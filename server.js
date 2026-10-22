import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

import ExcelJS from 'exceljs';
import fs from 'node:fs';
import crypto from 'node:crypto';


import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import pg from 'pg';
import XLSX from 'xlsx';

const { Pool } = pg;

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const sessions = new Set();

function getTables(req) {
  const mode = req.query.mode === 'fire' ? 'fire' : req.query.mode === 'firstaid' ? 'firstaid' : 'ladder';
  if (mode === 'fire') {
    return {
      points: 'fire_inspection_points',
      options: 'fire_question_options',
      inspections: 'fire_inspections',
      results: 'fire_inspection_results'
    };
  }
  if (mode === 'firstaid') {
    return {
      points: 'firstaid_inspection_points',
      options: 'firstaid_question_options',
      inspections: 'firstaid_inspections',
      results: 'firstaid_inspection_results'
    };
  }
  return {
    points: 'inspection_points',
    options: 'question_options',
    inspections: 'inspections',
    results: 'inspection_results'
  };
}


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

async function getQuestions(mode = 'ladder') {
  const tables = getTables({ query: { mode } });
  const isLadder = mode !== 'fire' && mode !== 'firstaid';
  const query = isLadder
    ? `select id, category, question, display_order, is_required, is_active, created_at, updated_at from ${tables.points} order by display_order, id`
    : `select id, '${mode}' as category, question, display_order, is_required, is_active, created_at, updated_at from ${tables.points} order by display_order, id`;

  const { rows: questions } = await pool.query(query);
  const { rows: options } = await pool.query(`
    select id, question_id, option_label, option_value, sort_order, is_fail_value, is_active
    from ${tables.options}
    order by sort_order, id
  `);
  const grouped = new Map();
  for (const option of options) {
    if (!grouped.has(option.question_id)) grouped.set(option.question_id, []);
    grouped.get(option.question_id).push(option);
  }
  return questions.map(q => ({
    ...q,
    question_type: 'decision',
    allow_remarks: true,
    options: grouped.get(q.id) || []
  }));
}

async function replaceOptions(client, questionId, options = [], mode = 'ladder') {
  const tables = getTables({query: {mode}});
  await client.query(`delete from ${tables.options} where question_id = $1`, [questionId]);
  for (const [index, option] of options.entries()) {
    await client.query(
      `insert into ${tables.options} (question_id, option_label, option_value, sort_order, is_fail_value, is_active)
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
    res.json(await getQuestions(req.query.mode));
  } catch (error) {
    next(error);
  }
});

app.post('/api/questions', requireAdmin, async (req, res, next) => {
  const q = req.body;
  const client = await pool.connect();
  const isLadder = req.query.mode !== 'fire' && req.query.mode !== 'firstaid';
  try {
    await client.query('begin');
    const { rows } = isLadder
      ? await client.query(
          `insert into ${getTables(req).points} (category, question, display_order, is_required, is_active)
           values ($1, $2, $3, $4, $5)
           returning id`,
          [q.category || 'general', q.question, q.display_order, !!q.is_required, q.is_active !== false],
        )
      : await client.query(
          `insert into ${getTables(req).points} (question, display_order, is_required, is_active)
           values ($1, $2, $3, $4)
           returning id`,
          [q.question, q.display_order, !!q.is_required, q.is_active !== false],
        );
    await replaceOptions(client, rows[0].id, q.options || [], req.query.mode);
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
  const isLadder = req.query.mode !== 'fire' && req.query.mode !== 'firstaid';
  try {
    await client.query('begin');
    if (isLadder) {
      await client.query(
        `update ${getTables(req).points}
            set category=$1, question=$2, display_order=$3,
                is_required=$4, is_active=$5, updated_at=now()
          where id=$6`,
        [q.category || 'general', q.question, q.display_order, !!q.is_required, q.is_active !== false, req.params.id],
      );
    } else {
      await client.query(
        `update ${getTables(req).points}
            set question=$1, display_order=$2,
                is_required=$3, is_active=$4, updated_at=now()
          where id=$5`,
        [q.question, q.display_order, !!q.is_required, q.is_active !== false, req.params.id],
      );
    }
    await replaceOptions(client, req.params.id, q.options || [], req.query.mode);
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
    await pool.query(`update ${getTables(req).points} set is_active=false, updated_at=now() where id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/inspections', requireAdmin, async (req, res, next) => {
  try {
    const t = getTables(req);
    const mode = req.query.mode || 'ladder';
    const isFire = mode === 'fire';
    const isFirstAid = mode === 'firstaid';

    const ladderNoCol = isFire ? 'point_no' : isFirstAid ? 'box_no' : 'ladder_no';
    const sectionCol = isFire ? 'location' : isFirstAid ? 'location' : 'section';
    const heightExpr = isFire ? 'i.quantity::text' : isFirstAid ? "''" : 'i.height_feet::text';
    const typeExpr = isFire ? 'i.extinguisher_type' : isFirstAid ? "''" : 'i.ladder_type';
    const pressureExpr = isFire ? 'i.pressure_weight' : 'null';

    const filters = [];
    const values = [];
    if (req.query.from) { values.push(req.query.from); filters.push(`i.inspection_date >= $${values.length}`); }
    if (req.query.to) { values.push(req.query.to); filters.push(`i.inspection_date <= $${values.length}`); }
    if (req.query.ladder) { values.push(`%${req.query.ladder}%`); filters.push(`i.${ladderNoCol} ilike $${values.length}`); }
    if (req.query.inspector) { values.push(`%${req.query.inspector}%`); filters.push(`i.inspector_name ilike $${values.length}`); }
    if (req.query.status) { values.push(req.query.status); filters.push(`i.overall_result = $${values.length}`); }
    const where = filters.length ? `where ${filters.join(' and ')}` : '';
    const { rows } = await pool.query(`
      select i.id, i.inspection_date, i.${ladderNoCol} as ladder_no, i.${sectionCol} as section,
             ${heightExpr} as height_feet, ${typeExpr} as ladder_type,
             ${pressureExpr} as pressure_weight,
             i.inspector_name, i.overall_result, i.remarks, i.created_at,
             count(r.id)::int as answer_count,
             count(*) filter (where r.result = 'FAIL' or r.result = 'EXPIRED')::int as fail_count
        from ${t.inspections} i
        left join ${t.results} r on r.inspection_id = i.id
        ${where}
       group by i.id
       order by i.inspection_date asc, i.created_at asc
       limit 500
    `, values);
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.get('/api/inspections/:id', requireAdmin, async (req, res, next) => {
  try {
    const t = getTables(req);
    const mode = req.query.mode || 'ladder';
    const catExpr = mode === 'ladder' ? 'r.category_snapshot' : `'${mode}'`;
    const { rows } = await pool.query(`
      select r.display_order_snapshot as order,
             ${catExpr} as category,
             r.question_text_snapshot as question,
             r.result, coalesce(r.answer_label, r.result) as answer_label, r.remarks
        from ${t.results} r
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
    const questions = await getQuestions(req.query.mode);
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
    const mode = req.query.mode === 'fire' ? 'fire' : req.query.mode === 'firstaid' ? 'firstaid' : 'ladder';

    if (mode === 'firstaid') {
      const filters = [];
      const values = [];
      if (req.query.from) { values.push(req.query.from); filters.push(`i.inspection_date >= $${values.length}`); }
      if (req.query.to) { values.push(req.query.to); filters.push(`i.inspection_date <= $${values.length}`); }
      if (req.query.ladder) { values.push(`%${req.query.ladder}%`); filters.push(`(i.box_no ilike $${values.length} or i.location ilike $${values.length})`); }
      if (req.query.inspector) { values.push(`%${req.query.inspector}%`); filters.push(`i.inspector_name ilike $${values.length}`); }
      if (req.query.status) { values.push(req.query.status); filters.push(`i.overall_result = $${values.length}`); }
      const where = filters.length ? `where ${filters.join(' and ')}` : '';

      const { rows } = await pool.query(`
        select i.id as inspection_id,
               i.inspection_date,
               i.box_no,
               i.location,
               i.inspector_name,
               i.epf_number,
               i.overall_result,
               i.remarks as overall_remarks,
               i.created_at,
               r.display_order_snapshot as question_number,
               r.question_text_snapshot as question,
               r.result as answer,
               coalesce(r.answer_label, r.result) as answer_label,
               r.remarks as answer_remarks
          from firstaid_inspections i
          left join firstaid_inspection_results r on r.inspection_id = i.id
          ${where}
         order by i.inspection_date asc, i.created_at asc, r.display_order_snapshot asc
      `, values);

      const inspectionsMap = new Map();
      rows.forEach(r => {
        if (!inspectionsMap.has(r.inspection_id)) {
          inspectionsMap.set(r.inspection_id, {
            'Inspection ID': r.inspection_id,
            'Date': r.inspection_date ? r.inspection_date.toISOString().split('T')[0] : '',
            'Box No': r.box_no,
            'Location': r.location,
            'Inspector Name': r.inspector_name,
            'EPF Number': r.epf_number,
            'Overall Result': r.overall_result,
            'Overall Remarks': r.overall_remarks || '',
            item_remarks: []
          });
        }
        if (r.question) {
          const rec = inspectionsMap.get(r.inspection_id);
          const cleanQ = r.question.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
          rec[cleanQ] = r.answer_label || r.answer;
          if (r.answer_remarks && r.answer_remarks.trim()) {
            rec.item_remarks.push(`${r.question}: ${r.answer_remarks.trim()}`);
          }
        }
      });

      const finalRows = Array.from(inspectionsMap.values());
      let buffer;
      try {
        const templatePath = path.join(__dirname, 'firstaid_template.xlsx');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(templatePath);
        const sheet = workbook.getWorksheet(1);

        const headerRow9 = sheet.getRow(9);
        const headers = [];
        headerRow9.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          headers[colNumber] = cell.value ? String(cell.value).trim() : '';
        });

        const styleRow = sheet.getRow(10);

        finalRows.forEach((row, rowIndex) => {
          const excelRowNumber = 10 + rowIndex;
          const excelRow = sheet.getRow(excelRowNumber);

          for (let c = 1; c <= 26; c++) {
            const targetCell = excelRow.getCell(c);
            if (styleRow.getCell(c).style) {
              targetCell.style = Object.assign({}, styleRow.getCell(c).style);
            }
          }

          excelRow.getCell(1).value = row['Date'] || '';
          excelRow.getCell(2).value = row['Inspector Name'] || '';
          excelRow.getCell(3).value = row['EPF Number'] || '';
          excelRow.getCell(4).value = row['Box No'] || '';
          excelRow.getCell(5).value = row['Location'] || '';

          // Question items from col 6 to 23
          for (let c = 6; c <= 23; c++) {
            const h = headers[c];
            if (!h) continue;
            const cleanH = h.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
            let matchedVal = '';
            for (const [key, val] of Object.entries(row)) {
              if (key === cleanH || key.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim().toLowerCase() === cleanH) {
                matchedVal = val;
                break;
              }
            }
            excelRow.getCell(c).value = matchedVal || '';
          }

          // Individual Remarks in col 24
          excelRow.getCell(24).value = row.item_remarks && row.item_remarks.length ? row.item_remarks.join('; ') : '';

          // Overall Remark in col 25
          excelRow.getCell(25).value = row['Overall Remarks'] || '';

          // Overall Result in col 26
          const resultCell = excelRow.getCell(26);
          resultCell.value = row['Overall Result'] || '';
          if (row['Overall Result'] === 'FAIL') {
            resultCell.font = Object.assign({}, resultCell.font || {}, { color: { argb: 'FFFF0000' }, bold: true });
          } else if (row['Overall Result'] === 'PASS') {
            resultCell.font = Object.assign({}, resultCell.font || {}, { color: { argb: 'FF008000' }, bold: true });
          }

          excelRow.commit();
        });

        buffer = await workbook.xlsx.writeBuffer();
      } catch (tmplErr) {
        console.error('First aid template export fallback:', tmplErr);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(finalRows.length ? finalRows : [{ note: 'No records found' }]), 'First Aid Results');
        buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      }

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="FIRST-AID-CHECKLIST-EXPORT.xlsx"');
      return res.send(buffer);
    }

    if (mode === 'fire') {
      const filters = [];
      const values = [];
      if (req.query.from) { values.push(req.query.from); filters.push(`i.inspection_date >= ${values.length}`); }
      if (req.query.to) { values.push(req.query.to); filters.push(`i.inspection_date <= ${values.length}`); }
      if (req.query.ladder) { values.push(`%${req.query.ladder}%`); filters.push(`(i.point_no ilike ${values.length} or i.location ilike ${values.length})`); }
      if (req.query.inspector) { values.push(`%${req.query.inspector}%`); filters.push(`i.inspector_name ilike ${values.length}`); }
      if (req.query.status) { values.push(req.query.status); filters.push(`i.overall_result = ${values.length}`); }
      const where = filters.length ? `where ${filters.join(' and ')}` : '';

      const { rows } = await pool.query(`
        select i.id as inspection_id,
               i.inspection_date,
               i.point_no,
               i.location,
               i.quantity,
               i.extinguisher_type,
               i.pressure_weight,
               i.inspector_name,
               i.epf_number,
               i.overall_result,
               i.remarks as overall_remarks,
               i.created_at,
               r.display_order_snapshot as question_number,
               r.question_text_snapshot as question,
               r.result as answer,
               coalesce(r.answer_label, r.result) as answer_label,
               r.remarks as answer_remarks
          from fire_inspections i
          left join fire_inspection_results r on r.inspection_id = i.id
          ${where}
         order by i.inspection_date asc, i.created_at asc, r.display_order_snapshot asc
      `, values);

      const inspectionsMap = new Map();
      rows.forEach(r => {
        if (!inspectionsMap.has(r.inspection_id)) {
          inspectionsMap.set(r.inspection_id, {
            'Inspection ID': r.inspection_id,
            'Date': r.inspection_date ? r.inspection_date.toISOString().split('T')[0] : '',
            'Point No.': r.point_no,
            'Location': r.location,
            'Type': r.extinguisher_type,
            'Quantity': r.quantity,
            'Pressure/Weight': r.pressure_weight || '',
            'Inspector Name': r.inspector_name,
            'EPF Number': r.epf_number || '',
            'Overall Result': r.overall_result,
            'Overall Remarks': r.overall_remarks || '',
            item_remarks: []
          });
        }
        if (r.question) {
          const rec = inspectionsMap.get(r.inspection_id);
          const cleanQ = r.question.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
          rec[cleanQ] = r.answer_label || r.answer;
          if (r.answer_remarks && r.answer_remarks.trim()) {
            rec.item_remarks.push(`${r.question}: ${r.answer_remarks.trim()}`);
          }
        }
      });

      const finalRows = Array.from(inspectionsMap.values());
      let buffer;
      try {
        let templatePath = path.join(__dirname, 'fire_extinguisher_template.xlsx');
        if (!fs.existsSync(templatePath)) {
          templatePath = path.join(__dirname, 'Fire Extinguisher Inspection Record Sheet.xlsx');
        }

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(templatePath);
        const sheet = workbook.getWorksheet(1);

        const headerRow9 = sheet.getRow(9);
        const headers = [];
        headerRow9.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          headers[colNumber] = cell.value ? String(cell.value).trim() : '';
        });

        const styleRow = sheet.getRow(10);

        // Clear any pre-existing sample or template rows from row 10 downwards
        for (let r = 10; r <= sheet.rowCount; r++) {
          const er = sheet.getRow(r);
          for (let c = 1; c <= 19; c++) {
            er.getCell(c).value = null;
          }
          er.commit();
        }

        finalRows.forEach((row, rowIndex) => {
          const excelRowNumber = 10 + rowIndex;
          const excelRow = sheet.getRow(excelRowNumber);
          excelRow.height = 30;

          for (let c = 1; c <= 19; c++) {
            const targetCell = excelRow.getCell(c);
            if (styleRow.getCell(c).style) {
              targetCell.style = Object.assign({}, styleRow.getCell(c).style);
            }
            targetCell.border = {
              top: { style: 'thin' },
              left: { style: 'thin' },
              bottom: { style: 'thin' },
              right: { style: 'thin' }
            };
            targetCell.font = { name: 'Calibri', size: 11 };
            targetCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
          }

          excelRow.getCell(1).value = row['Inspection ID'] || '';
          excelRow.getCell(2).value = row['Date'] || '';
          excelRow.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' };
          excelRow.getCell(3).value = row['Inspector Name'] || '';
          excelRow.getCell(4).value = row['EPF Number'] || '';
          excelRow.getCell(5).value = row['Location'] || '';
          excelRow.getCell(6).value = row['Point No.'] || '';
          excelRow.getCell(7).value = row['Type'] || '';
          excelRow.getCell(8).value = row['Quantity'] || '';
          excelRow.getCell(8).alignment = { horizontal: 'center', vertical: 'middle' };
          excelRow.getCell(9).value = row['Pressure/Weight'] || '';
          excelRow.getCell(9).alignment = { horizontal: 'center', vertical: 'middle' };

          // Checklist questions from column 10 to 17
          for (let c = 10; c <= 17; c++) {
            const h = headers[c];
            if (!h) continue;
            const cleanH = h.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
            let matchedVal = '';
            for (const [key, val] of Object.entries(row)) {
              if (key.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim().toLowerCase() === cleanH) {
                matchedVal = val;
                break;
              }
            }
            const qCell = excelRow.getCell(c);
            qCell.value = matchedVal || '';
            qCell.alignment = { horizontal: 'center', vertical: 'middle' };
            if (matchedVal === 'FAIL') {
              qCell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFF0000' } };
            } else if (matchedVal === 'PASS') {
              qCell.font = { name: 'Calibri', size: 11, color: { argb: 'FF008000' } };
            }
          }

          // Overall Result in col 18
          const resultCell = excelRow.getCell(18);
          resultCell.value = row['Overall Result'] || '';
          resultCell.alignment = { horizontal: 'center', vertical: 'middle' };
          if (row['Overall Result'] === 'FAIL') {
            resultCell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFF0000' } };
          } else if (row['Overall Result'] === 'PASS') {
            resultCell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF008000' } };
          }

          // Overall Remarks in col 19
          const remarkParts = [];
          if (row['Overall Remarks']) remarkParts.push(row['Overall Remarks']);
          if (row.item_remarks && row.item_remarks.length) {
            remarkParts.push(...row.item_remarks);
          }
          excelRow.getCell(19).value = remarkParts.join('; ');

          excelRow.commit();
        });

        buffer = await workbook.xlsx.writeBuffer();
      } catch (tmplErr) {
        console.error('Fire extinguisher template export fallback:', tmplErr);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(finalRows.length ? finalRows : [{ note: 'No records found' }]), 'Fire Inspections');
        buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      }

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="FIRE-EXTINGUISHER-CHECKLIST-EXPORT.xlsx"');
      return res.send(buffer);
    }

    // Default: Ladder
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
       order by i.inspection_date asc, i.created_at asc, r.display_order_snapshot asc
    `, values);

    const inspectionsMap = new Map();
    rows.forEach(r => {
      if (!inspectionsMap.has(r.inspection_id)) {
        inspectionsMap.set(r.inspection_id, {
          'Inspection ID': r.inspection_id,
          'Date': r.inspection_date ? r.inspection_date.toISOString().split('T')[0] : '',
          'Ladder No.': r.ladder_no,
          'Section': r.section,
          'Feet': r.height_feet,
          'Ladder Type (Step ladder/Extension ladder)': r.ladder_type,
          'Inspector Name': r.inspector_name,
          'EPF Number': r.epf_number,
          'Overall Result': r.overall_result,
          'Overall Remarks': r.overall_remarks || ''
        });
      }
      if (r.question) {
        const cat = r.category || '';
        inspectionsMap.get(r.inspection_id)[`${cat}:::${r.question}`] = r.answer;
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
      const categories = [];
      const maxCols = Math.max(headerRow6.cellCount, headerRow7.cellCount, 40);
      
      for (let i = 1; i <= maxCols; i++) {
         let catVal = headerRow6.getCell(i).value;
         if (catVal && typeof catVal === 'object' && catVal.richText) catVal = catVal.richText.map(t=>t.text).join('');
         categories[i] = typeof catVal === 'string' ? catVal.trim().toLowerCase() : '';
         
         let hVal = headerRow7.getCell(i).value;
         if (hVal && typeof hVal === 'object' && hVal.richText) hVal = hVal.richText.map(t=>t.text).join('');
         headers[i] = typeof hVal === 'string' ? hVal.trim() : '';
      }
      
      const styleRow = sheet.getRow(8);

      // Clear any pre-existing sample or template rows from row 8 downwards
      for (let r = 8; r <= sheet.rowCount; r++) {
        const er = sheet.getRow(r);
        for (let c = 1; c <= 35; c++) {
          er.getCell(c).value = null;
        }
        er.commit();
      }
      
      finalRows.forEach((row, rowIndex) => {
        const excelRowNumber = 8 + rowIndex;
        const excelRow = sheet.getRow(excelRowNumber);
        
        for (let c = 1; c <= 33; c++) {
          const targetCell = excelRow.getCell(c);
          if (styleRow.getCell(c).style) {
            targetCell.style = Object.assign({}, styleRow.getCell(c).style);
          }
        }

        excelRow.getCell(1).value = row['Date'] || '';
        excelRow.getCell(2).value = row['Inspector Name'] || '';
        excelRow.getCell(3).value = row['EPF Number'] || '';
        excelRow.getCell(4).value = row['Overall Result'] || '';
        excelRow.getCell(5).value = row['Ladder No.'] || '';
        excelRow.getCell(6).value = row['Section'] || '';
        excelRow.getCell(7).value = row['Feet'] || '';
        excelRow.getCell(8).value = row['Ladder Type (Step ladder/Extension ladder)'] || '';

        // Match checklist questions from column 9 to 32
        for (let c = 9; c <= 32; c++) {
          const h = headers[c];
          if (!h) continue;
          const cleanH = h.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
          const excelCat = categories[c] || '';
          
          let matchedVal = '';
          for (const [key, val] of Object.entries(row)) {
            if (key.includes(':::')) {
              const [dbCat, dbQuestion] = key.split(':::');
              const cleanDbCat = dbCat.replace(/\s+/g, ' ').trim().toLowerCase();
              const cleanDbQuestion = dbQuestion.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
              
              if (cleanDbQuestion === cleanH) {
                if (excelCat.includes('extension') && !cleanDbCat.includes('extension')) continue;
                if (excelCat.includes('step') && !cleanDbCat.includes('step')) continue;
                matchedVal = val;
                break;
              }
            } else {
              if (key.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim().toLowerCase() === cleanH) {
                matchedVal = val;
                break;
              }
            }
          }
          excelRow.getCell(c).value = matchedVal || '';
        }

        excelRow.getCell(33).value = row['Overall Remarks'] || '';
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
if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Safety Inspection Admin running on http://localhost:${port}`);
  });
}

export default app;
