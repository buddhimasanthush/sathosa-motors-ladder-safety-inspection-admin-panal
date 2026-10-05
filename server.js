import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import pg from 'pg';
import XLSX from 'xlsx';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const sessions = new Set();

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined,
  max: 5,
});

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  if (sessions.has(req.cookies.admin_session)) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

function normalizeQuestion(row, index) {
  const text = String(row.Question || row.question || row.question_text || '').trim();
  const section = String(row.Section || row.section || row.Category || row.category || 'general').trim().toLowerCase();
  const questionType = String(row['Question Type'] || row.question_type || row.Type || 'decision').trim().toLowerCase();
  const requiredRaw = row.Required ?? row.required ?? true;
  const activeRaw = row.Active ?? row.active ?? true;
  const sortRaw = row['Question Number'] ?? row.sort_order ?? row.display_order ?? index + 1;
  const optionsRaw = String(row.Options || row.options || '').trim();
  const options = optionsRaw
    ? optionsRaw.split('|').map((part, optionIndex) => {
        const [labelValue, flag] = part.split(':');
        const [label, value] = labelValue.includes('=')
          ? labelValue.split('=')
          : [labelValue, labelValue];
        return {
          option_label: String(label || '').trim(),
          option_value: String(value || label || '').trim(),
          sort_order: optionIndex + 1,
          is_fail_value: String(flag || '').trim().toLowerCase() === 'fail',
        };
      })
    : [];

  return {
    category: section,
    question: text,
    question_type: questionType,
    display_order: Number(sortRaw),
    is_required: ['true', 'yes', '1', 'required'].includes(String(requiredRaw).trim().toLowerCase()),
    is_active: !['false', 'no', '0', 'inactive'].includes(String(activeRaw).trim().toLowerCase()),
    options,
  };
}

function validateQuestions(questions) {
  const errors = [];
  const seen = new Set();
  const validTypes = new Set(['decision', 'yes_no', 'multiple_choice', 'text', 'long_text', 'number', 'date']);
  const validSections = new Set(['general', 'extension', 'step']);

  questions.forEach((q, index) => {
    const row = index + 2;
    if (!q.question) errors.push(`Row ${row}: missing question text.`);
    if (!validSections.has(q.category)) errors.push(`Row ${row}: invalid section "${q.category}". Use general, extension, or step.`);
    if (!validTypes.has(q.question_type)) errors.push(`Row ${row}: invalid question type "${q.question_type}".`);
    if (!Number.isFinite(q.display_order) || q.display_order <= 0) errors.push(`Row ${row}: invalid question number/order.`);
    const key = `${q.category}|${q.question.toLowerCase()}`;
    if (seen.has(key)) errors.push(`Row ${row}: duplicate question in the same section.`);
    seen.add(key);
    const needsOptions = ['decision', 'yes_no', 'multiple_choice'].includes(q.question_type);
    if (needsOptions && !q.options.length) errors.push(`Row ${row}: selectable question requires options.`);
    q.options.forEach((option, optionIndex) => {
      if (!option.option_label || !option.option_value) errors.push(`Row ${row}: option ${optionIndex + 1} is missing a label or value.`);
    });
  });

  return errors;
}

async function getQuestions() {
  const { rows: questions } = await pool.query(`
    select id, category, question, question_type, display_order, is_required, is_active, allow_remarks, created_at, updated_at
    from inspection_points
    order by display_order, id
  `);
  const { rows: options } = await pool.query(`
    select id, question_id, option_label, option_value, sort_order, is_fail_value, is_active
    from question_options
    order by sort_order, id
  `);
  const grouped = new Map();
  for (const option of options) {
    if (!grouped.has(option.question_id)) grouped.set(option.question_id, []);
    grouped.get(option.question_id).push(option);
  }
  return questions.map(q => ({ ...q, options: grouped.get(q.id) || [] }));
}

async function replaceOptions(client, questionId, options = []) {
  await client.query('delete from question_options where question_id = $1', [questionId]);
  for (const [index, option] of options.entries()) {
    await client.query(
      `insert into question_options (question_id, option_label, option_value, sort_order, is_fail_value, is_active)
       values ($1, $2, $3, $4, $5, true)`,
      [questionId, option.option_label, option.option_value, option.sort_order || index + 1, !!option.is_fail_value],
    );
  }
}

app.post('/api/login', (req, res) => {
  const expected = process.env.ADMIN_PASSWORD || '';
  const supplied = String(req.body?.password || '');
  if (!expected || supplied !== expected) return res.status(401).json({ error: 'Invalid password' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.add(token);
  res.cookie('admin_session', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true });
});

app.post('/api/logout', requireAdmin, (req, res) => {
  sessions.delete(req.cookies.admin_session);
  res.clearCookie('admin_session');
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  res.json({ authenticated: sessions.has(req.cookies.admin_session) });
});

app.get('/api/questions', requireAdmin, async (req, res, next) => {
  try {
    res.json(await getQuestions());
  } catch (error) {
    next(error);
  }
});

app.post('/api/questions', requireAdmin, async (req, res, next) => {
  const q = req.body;
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (q.display_order) {
      await client.query('update inspection_points set display_order = display_order + 1 where display_order >= 
  const q = req.body;
  const client = await pool.connect();
  try {
    ', [q.display_order]);
    }
    const { rows } = await client.query(
      `insert into inspection_points (category, question, question_type, display_order, is_required, is_active, allow_remarks)
       values ($1, $2, $3, $4, $5, $6, true)
       returning id`,
      [q.category, q.question, q.question_type, q.display_order, !!q.is_required, q.is_active !== false],
    );
    await replaceOptions(client, rows[0].id, q.options || []);
    await client.query('commit');
    res.json({ id: rows[0].id });
  } catch (error) {
    await client.query('rollback');
    next(error);
  } finally {
    client.release();
  }
});

app.put('/api/questions/:id', requireAdmin, async (req, res, next) => {
  const q = req.body;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows: curr } = await client.query('select display_order from inspection_points where id = 
  const q = req.body;
  const client = await pool.connect();
  try {
    ', [req.params.id]);
    const currOrder = curr[0]?.display_order;
    if (q.display_order && currOrder && q.display_order !== currOrder) {
      if (q.display_order < currOrder) {
        await client.query('update inspection_points set display_order = display_order + 1 where display_order >= 
  const q = req.body;
  const client = await pool.connect();
  try {
     and display_order < $2', [q.display_order, currOrder]);
      } else {
        await client.query('update inspection_points set display_order = display_order - 1 where display_order <= 
  const q = req.body;
  const client = await pool.connect();
  try {
     and display_order > $2', [q.display_order, currOrder]);
      }
    }
    await client.query(
      `update inspection_points
          set category=$1, question=$2, question_type=$3, display_order=$4,
              is_required=$5, is_active=$6, updated_at=now()
        where id=$7`,
      [q.category, q.question, q.question_type, q.display_order, !!q.is_required, q.is_active !== false, req.params.id],
    );
    await replaceOptions(client, req.params.id, q.options || []);
    await client.query('commit');
    res.json({ ok: true });
  } catch (error) {
    await client.query('rollback');
    next(error);
  } finally {
    client.release();
  }
});

app.delete('/api/questions/:id', requireAdmin, async (req, res, next) => {
  try {
    await pool.query('update inspection_points set is_active=false, updated_at=now() where id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/inspections', requireAdmin, async (req, res, next) => {
  try {
    const filters = [];
    const values = [];
    if (req.query.from) { values.push(req.query.from); filters.push(`i.inspection_date >= $${values.length}`); }
    if (req.query.to) { values.push(req.query.to); filters.push(`i.inspection_date <= $${values.length}`); }
    if (req.query.ladder) { values.push(`%${req.query.ladder}%`); filters.push(`i.ladder_no ilike $${values.length}`); }
    if (req.query.inspector) { values.push(`%${req.query.inspector}%`); filters.push(`i.inspector_name ilike $${values.length}`); }
    if (req.query.status) { values.push(req.query.status); filters.push(`i.overall_result = $${values.length}`); }
    const where = filters.length ? `where ${filters.join(' and ')}` : '';
    const { rows } = await pool.query(`
      select i.id, i.inspection_date, i.ladder_no, i.section, i.height_feet, i.ladder_type,
             i.inspector_name, i.epf_number, i.overall_result, i.remarks, i.created_at,
             count(r.id)::int as answer_count,
             count(*) filter (where r.result = 'FAIL')::int as fail_count
        from inspections i
        left join inspection_results r on r.inspection_id = i.id
        ${where}
       group by i.id
       order by i.inspection_date desc, i.created_at desc
       limit 500
    `, values);
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.get('/api/inspections/:id', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      select r.display_order_snapshot as order,
             r.category_snapshot as category,
             r.question_text_snapshot as question,
             r.result, r.result as answer_label, r.remarks
        from inspection_results r
       where r.inspection_id = $1
       order by r.display_order_snapshot asc
    `, [req.params.id]);
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.get('/api/export/questionnaire', requireAdmin, async (req, res, next) => {
  try {
    const questions = await getQuestions();
    const rows = questions.map(q => ({
      'Question Number': q.display_order,
      Section: q.category,
      Question: q.question,
      'Question Type': q.question_type,
      Required: q.is_required ? 'yes' : 'no',
      Active: q.is_active ? 'yes' : 'no',
      Options: q.options.map(o => `${o.option_label}=${o.option_value}${o.is_fail_value ? ':fail' : ''}`).join('|'),
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Questionnaire');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="questionnaire.xlsx"');
    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

app.get('/api/export/inspections', requireAdmin, async (req, res, next) => {
  try {
    // Apply optional query filters
    const filters = [];
    const values = [];
    if (req.query.from)      { values.push(req.query.from);          filters.push(`i.inspection_date >= $${values.length}`); }
    if (req.query.to)        { values.push(req.query.to);            filters.push(`i.inspection_date <= $${values.length}`); }
    if (req.query.ladder)    { values.push(`%${req.query.ladder}%`); filters.push(`i.ladder_no ilike $${values.length}`); }
    if (req.query.inspector) { values.push(`%${req.query.inspector}%`); filters.push(`i.inspector_name ilike $${values.length}`); }
    if (req.query.status)    { values.push(req.query.status);        filters.push(`i.overall_result = $${values.length}`); }
    const where = filters.length ? `where ${filters.join(' and ')}` : '';

    const { rows } = await pool.query(`
      select i.id as inspection_id,
             i.inspection_date,
             i.ladder_no,
             i.section,
             i.height_feet,
             i.ladder_type,
             i.inspector_name,
             i.overall_result,
             i.remarks                     as overall_remarks,
             i.created_at,
             r.display_order_snapshot      as question_number,
             r.category_snapshot           as question_section,
             r.question_text_snapshot      as question,
             r.question_type_snapshot      as question_type,
             r.result                      as answer,
             r.result as answer_label,
             r.remarks                     as answer_remarks
        from inspections i
        left join inspection_results r on r.inspection_id = i.id
        ${where}
       order by i.inspection_date desc, i.created_at desc, r.display_order_snapshot asc
    `, values);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows.length ? rows : [{ note: 'No records found' }]), 'Inspection Results');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="inspection-records.xlsx"');
    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

app.post('/api/import/questionnaire', requireAdmin, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ errors: ['No Excel file uploaded.'] });
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const questions = rows.map(normalizeQuestion);
    const errors = validateQuestions(questions);
    if (errors.length || req.body.confirm !== 'true') {
      return res.json({ preview: questions, errors });
    }

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('update inspection_points set is_active=false, updated_at=now() where is_active=true');
      for (const q of questions) {
        const { rows: inserted } = await client.query(
          `insert into inspection_points (category, question, question_type, display_order, is_required, is_active, allow_remarks)
           values ($1, $2, $3, $4, $5, $6, true)
           returning id`,
          [q.category, q.question, q.question_type, q.display_order, q.is_required, q.is_active],
        );
        await replaceOptions(client, inserted[0].id, q.options);
      }
      await client.query('commit');
      res.json({ imported: questions.length, errors: [] });
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: error.message || 'Server error' });
});

const port = Number(process.env.PORT || 8081);
app.listen(port, () => {
  console.log(`Safety Inspection Admin running on http://localhost:${port}`);
});
