import 'dotenv/config';
import ExcelJS from 'exceljs';
import fs from 'node:fs';
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
             i.inspector_name, i.overall_result, i.remarks, i.created_at,
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
             r.result, coalesce(r.answer_label, r.result) as answer_label, r.remarks
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
    const filters = [];
    const values = [];
    if (req.query.from) { values.push(req.query.from); filters.push(`i.inspection_date >= $${values.length}`); }
    if (req.query.to) { values.push(req.query.to); filters.push(`i.inspection_date <= $${values.length}`); }
    if (req.query.ladder) { values.push(`%${req.query.ladder}%`); filters.push(`i.ladder_no ilike $${values.length}`); }
    if (req.query.inspector) { values.push(`%${req.query.inspector}%`); filters.push(`i.inspector_name ilike $${values.length}`); }
    if (req.query.status) { values.push(req.query.status); filters.push(`i.overall_result = $${values.length}`); }
    
    const where = filters.length ? `where ${filters.join(' and ')}` : '';

    const { rows } = await pool.query(`
      select i.id as inspection_id,
             i.inspection_date,
             i.ladder_no,
             i.section,
             i.height_feet,
             i.ladder_type,
             i.inspector_name,
             i.epf_number,
             i.overall_result,
             i.remarks                     as overall_remarks,
             i.created_at,
             r.display_order_snapshot      as question_number,
             r.category_snapshot           as category,
             r.question_text_snapshot      as question,
             r.result                      as answer,
             r.remarks                     as answer_remarks
        from inspections i
        left join inspection_results r on r.inspection_id = i.id
        ${where}
       order by i.inspection_date desc, i.created_at desc, r.display_order_snapshot asc
    `, values);

    const inspectionsMap = new Map();
    
    rows.forEach(r => {
      if (!inspectionsMap.has(r.inspection_id)) {
        inspectionsMap.set(r.inspection_id, {
          'Inspection ID': r.inspection_id,
          'Date': r.inspection_date ? r.inspection_date.toISOString().split('T')[0] : '',
          'Ladder No': r.ladder_no,
          'Section/Location': r.section,
          'Height (ft)': r.height_feet,
          'Type': r.ladder_type,
          'Inspector Name': r.inspector_name,
          'EPF Number': r.epf_number,
          'Overall Result': r.overall_result,
          'Overall Remarks': r.overall_remarks
        });
      }
      if (r.question) {
        inspectionsMap.get(r.inspection_id)[r.question] = r.answer;
        if (r.answer_remarks) {
          inspectionsMap.get(r.inspection_id)[`${r.question} (Remarks)`] = r.answer_remarks;
        }
      }
    });

    const finalRows = Array.from(inspectionsMap.values());

    let buffer;
    try {
      const templatePath = path.join(__dirname, 'template.xlsx');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(templatePath);
      const sheet = workbook.getWorksheet(1);
      
      const headerRow6 = sheet.getRow(6);
      const headerRow7 = sheet.getRow(7);
      const headers = [];
      const maxCols = Math.max(headerRow6.cellCount, headerRow7.cellCount, 40);
      for (let i = 1; i <= maxCols; i++) {
         let val = headerRow7.getCell(i).value;
         if (val && typeof val === 'object' && val.richText) val = val.richText.map(t=>t.text).join('');
         if (!val) {
             val = headerRow6.getCell(i).value;
             if (val && typeof val === 'object' && val.richText) val = val.richText.map(t=>t.text).join('');
         }
         headers[i] = typeof val === 'string' ? val.trim() : (val ? String(val).trim() : '');
      }
      
      const styleRow = sheet.getRow(8);

      finalRows.forEach((row, rowIndex) => {
        const excelRowNumber = 8 + rowIndex;
        const excelRow = sheet.getRow(excelRowNumber);
        
        headers.forEach((h, colNumber) => {
          if (!h) return;
          const targetCell = excelRow.getCell(colNumber);
          
          // Copy style from row 8 to preserve borders and formatting
          targetCell.style = Object.assign({}, styleRow.getCell(colNumber).style);
          
          if (h === 'Ladder No.') targetCell.value = row['Ladder No'] || '';
          else if (h === 'Section') targetCell.value = row['Section/Location'] || '';
          else if (h === 'Feet') targetCell.value = row['Height (ft)'] || '';
          else if (h === 'Ladder Type (Step ladder/Extension ladder)') targetCell.value = row['Type'] || '';
          else {
            targetCell.value = row[h] || '';
          }
        });
        excelRow.commit();
      });
      
      buffer = await workbook.xlsx.writeBuffer();
    } catch (tmplErr) {
      console.error(tmplErr);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(finalRows.length ? finalRows : [{ note: 'No records found' }]), 'Inspection Results');
      buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="questionnaire.xlsx"');
    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

app.get('/api/export/inspections', requireAdmin, async (req, res, next) => {
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
      select i.id as inspection_id,
             i.inspection_date,
             i.ladder_no,
             i.section,
             i.height_feet,
             i.ladder_type,
             i.inspector_name,
             i.epf_number,
             i.overall_result,
             i.remarks                     as overall_remarks,
             i.created_at,
             r.display_order_snapshot      as question_number,
             r.category_snapshot           as category,
             r.question_text_snapshot      as question,
             r.result                      as answer,
             r.remarks                     as answer_remarks
        from inspections i
        left join inspection_results r on r.inspection_id = i.id
        ${where}
       order by i.inspection_date desc, i.created_at desc, r.display_order_snapshot asc
    `, values);

    const inspectionsMap = new Map();
    
    rows.forEach(r => {
      if (!inspectionsMap.has(r.inspection_id)) {
        inspectionsMap.set(r.inspection_id, {
          'Inspection ID': r.inspection_id,
          'Date': r.inspection_date ? r.inspection_date.toISOString().split('T')[0] : '',
          'Ladder No': r.ladder_no,
          'Section/Location': r.section,
          'Height (ft)': r.height_feet,
          'Type': r.ladder_type,
          'Inspector Name': r.inspector_name,
          'EPF Number': r.epf_number,
          'Overall Result': r.overall_result,
          'Overall Remarks': r.overall_remarks
        });
      }
      if (r.question) {
        inspectionsMap.get(r.inspection_id)[r.question] = r.answer;
        if (r.answer_remarks) {
          inspectionsMap.get(r.inspection_id)[`${r.question} (Remarks)`] = r.answer_remarks;
        }
      }
    });

    const finalRows = Array.from(inspectionsMap.values());

    let buffer;
    try {
      const templatePath = path.join(__dirname, 'template.xlsx');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(templatePath);
      const sheet = workbook.getWorksheet(1);
      
      const headerRow = sheet.getRow(7);
      const headers = [];
      headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          headers[colNumber] = cell.value; 
      });
      
      finalRows.forEach((row, rowIndex) => {
        const excelRowNumber = 8 + rowIndex;
        // In exceljs we can just get the row and it creates it if it doesn't exist
        const excelRow = sheet.getRow(excelRowNumber);
        
        headers.forEach((header, colNumber) => {
          if (!header) return;
          const h = header.toString().trim();
          if (h === 'Ladder No.') excelRow.getCell(colNumber).value = row['Ladder No'] || '';
          else if (h === 'Section') excelRow.getCell(colNumber).value = row['Section/Location'] || '';
          else if (h === 'Feet') excelRow.getCell(colNumber).value = row['Height (ft)'] || '';
          else if (h === 'Ladder Type (Step ladder/Extension ladder)') excelRow.getCell(colNumber).value = row['Type'] || '';
          else {
            excelRow.getCell(colNumber).value = row[h] || '';
          }
        });

        // Add additional metadata columns starting at AC (column 29)
        excelRow.getCell(29).value = row['Date'] || '';
        excelRow.getCell(30).value = row['Inspector Name'] || '';
        excelRow.getCell(31).value = row['EPF Number'] || '';
        excelRow.getCell(32).value = row['Overall Result'] || '';
        excelRow.getCell(33).value = row['Overall Remarks'] || '';
        excelRow.commit();
      });

      // Write headers for the extra metadata on row 7
      sheet.getCell(7, 29).value = 'Date';
      sheet.getCell(7, 30).value = 'Inspector Name';
      sheet.getCell(7, 31).value = 'EPF Number';
      sheet.getCell(7, 32).value = 'Overall Result';
      sheet.getCell(7, 33).value = 'Overall Remarks';
      
      buffer = await workbook.xlsx.writeBuffer();
    } catch (tmplErr) {
      console.error(tmplErr);
      // Fallback if template is broken
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(finalRows.length ? finalRows : [{ note: 'No records found' }]), 'Inspection Results');
      buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="LADDER-CHECKLIST-EXPORT.xlsx"');
    res.send(buffer);
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
