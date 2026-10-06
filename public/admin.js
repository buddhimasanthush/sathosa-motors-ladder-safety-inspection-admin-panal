/* ═══════════════════════════════════════════════════════════
   Safety Inspection Admin Panel — Client-side JavaScript
   ═══════════════════════════════════════════════════════════ */

'use strict';

/* ─── State ──────────────────────────────────────────────── */
let questions = [];
let selectedQuestion = null;
let importedPreview = null;

/* ─── Utility helpers ────────────────────────────────────── */
const esc = str => String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const q = id => document.getElementById(id);

function showErrorModal(msg) {
  const el = q('errorModalText');
  if (el) el.textContent = msg;
  const modal = q('errorModal');
  if (modal) modal.classList.add('active');
}

const show = el => el?.classList.remove('hidden');
const hide = el => el?.classList.add('hidden');

function sectionBadge(s) {
  const cls = { general: 'badge-section-general', extension: 'badge-section-extension', step: 'badge-section-step' };
  const lbl = { general: 'General', extension: 'Extension', step: 'Step' };
  return `<span class="badge ${cls[s] || 'badge-inactive'}">${lbl[s] || s}</span>`;
}

function typeBadge(t) {
  const labels = { decision: 'Decision', yes_no: 'Yes/No', multiple_choice: 'Choice', text: 'Text', long_text: 'Long Text', number: 'Number', date: 'Date' };
  return labels[t] || t;
}

/* ─── API calls ──────────────────────────────────────────── */
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin'
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || data || `HTTP ${res.status}`);
  return data;
}

/* ─── Auth ───────────────────────────────────────────────── */
async function checkSession() {
  try {
    const d = await api('GET', '/session');
    if (d.authenticated) {
      showApp();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

function showLogin() {
  hide(q('appView'));
  show(q('loginView'));
}

function showApp() {
  hide(q('loginView'));
  show(q('appView'));
  loadQuestions();
}

q('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = q('loginError');
  errEl.textContent = '';
  const pw = q('password').value;
  try {
    await api('POST', '/login', { password: pw });
    q('password').value = '';
    showApp();
  } catch (err) {
    errEl.textContent = err.message === 'Invalid password' ? 'Incorrect password. Try again.' : err.message;
  }
});

q('logoutBtn').addEventListener('click', async () => {
  try { await api('POST', '/logout'); } catch {}
  showLogin();
});

/* ─── Tab Navigation ─────────────────────────────────────── */
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
    btn.classList.add('active');
    const panel = q(target + 'Tab');
    if (panel) panel.classList.remove('hidden');

    if (target === 'records') loadRecords();
    if (target === 'preview') renderPreview();
  });
});

/* ═══════════════════════════════════════════════════════════
   QUESTIONS TAB
   ═══════════════════════════════════════════════════════════ */
async function loadQuestions() {
  try {
    questions = await api('GET', '/questions');
    renderQuestionsTable();
    updateQuestionCount();
  } catch (err) {
    showErrorModal('Failed to load questions: ' + err.message);
  }
}

function updateQuestionCount() {
  const active = questions.filter(q => q.is_active).length;
  const total = questions.length;
  q('questionCount').textContent = `${active} active · ${total} total questions`;
}

function renderQuestionsTable() {
  const tbody = q('questionRows');
  if (!questions.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">📋</div><p>No questions found. Add the first one using the form.</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = questions.map(item => `
    <tr class="${selectedQuestion?.id === item.id ? 'selected' : ''}" data-id="${item.id}" style="cursor:pointer;">
      <td class="mono" style="color:var(--text-2); width:56px;">${item.display_order}</td>
      <td>${sectionBadge(item.category)}</td>
      <td><div class="q-text" title="${esc(item.question)}">${esc(item.question)}</div></td>
      <td style="white-space:nowrap;">${typeBadge(item.question_type)}</td>
      <td>${item.is_required ? '<span class="badge badge-required">Req</span>' : '<span style="color:var(--text-3);font-size:0.78rem;">opt</span>'}</td>
      <td>${item.is_active
        ? '<span class="badge badge-active">Active</span>'
        : '<span class="badge badge-inactive">Off</span>'}</td>
      <td>
        <div style="display:flex;gap:6px;">
          <button class="btn-icon btn-sm" onclick="editQuestion(${item.id})" title="Edit">✏️</button>
          <button class="btn-icon btn-sm" onclick="toggleActive(${item.id}, ${!item.is_active})" title="${item.is_active ? 'Deactivate' : 'Activate'}">${item.is_active ? '🔇' : '✅'}</button>
        </div>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
      const id = Number(row.dataset.id);
      editQuestion(id);
    });
  });
}

/* ─── Question Form ──────────────────────────────────────── */
function resetForm() {
  selectedQuestion = null;
  q('editorTitle').textContent = 'Add Question';
  q('questionId').value = '';
  q('questionText').value = '';
  q('category').value = 'general';
  q('questionType').value = 'decision';
  q('sortOrder').value = (Math.max(0, ...questions.map(x => x.display_order)) + 1) || 1;
  q('required').checked = true;
  q('active').checked = true;
  renderOptionsEditor([
    { option_label: 'PASS', option_value: 'PASS', is_fail_value: false },
    { option_label: 'FAIL', option_value: 'FAIL', is_fail_value: true },
    
  ]);
  q('formStatus').textContent = '';
  q('formStatus').className = 'status-msg';
  q('deactivateBtn').style.display = 'none';
  q('questionText').focus();
  renderQuestionsTable(); // deselect
}

function editQuestion(id) {
  const q_item = questions.find(x => x.id === id);
  if (!q_item) return;
  selectedQuestion = q_item;
  q('editorTitle').textContent = 'Edit Question';
  q('questionId').value = q_item.id;
  q('questionText').value = q_item.question;
  q('category').value = q_item.category;
  q('questionType').value = q_item.question_type;
  q('sortOrder').value = q_item.display_order;
  q('required').checked = q_item.is_required;
  q('active').checked = q_item.is_active;
  renderOptionsEditor(q_item.options || []);
  q('formStatus').textContent = '';
  q('formStatus').className = 'status-msg';
  q('deactivateBtn').style.display = '';
  q('deactivateBtn').textContent = q_item.is_active ? '🔇 Deactivate' : '✅ Activate';
  renderQuestionsTable();
  q('questionForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ─── Options Editor ─────────────────────────────────────── */
function getOptions() {
  const rows = document.querySelectorAll('#optionsList .option-row');
  return Array.from(rows).map((row, i) => ({
    option_label: row.querySelector('.opt-label').value.trim(),
    option_value: row.querySelector('.opt-value').value.trim(),
    sort_order: i + 1,
    is_fail_value: row.querySelector('.fail-toggle').classList.contains('is-fail'),
  }));
}

function renderOptionsEditor(opts) {
  const list = q('optionsList');
  list.innerHTML = '';
  opts.forEach((opt, i) => addOptionRow(opt));
}

function addOptionRow(opt = { option_label: '', option_value: '', is_fail_value: false }) {
  const list = q('optionsList');
  const row = document.createElement('div');
  row.className = 'option-row';
  row.innerHTML = `
    <input type="text" class="opt-label" placeholder="Label" value="${esc(opt.option_label)}" required title="Display label">
    <input type="text" class="opt-value" placeholder="Value" value="${esc(opt.option_value)}" required title="Stored value">
    <button type="button" class="fail-toggle ${opt.is_fail_value ? 'is-fail' : ''}" title="Mark as fail outcome">FAIL</button>
    <button type="button" class="remove-opt" title="Remove option">✕</button>
  `;
  row.querySelector('.opt-label').addEventListener('input', function() {
    const valField = row.querySelector('.opt-value');
    if (!valField._edited) valField.value = this.value;
  });
  row.querySelector('.opt-value').addEventListener('input', function() {
    this._edited = true;
  });
  row.querySelector('.fail-toggle').addEventListener('click', function() {
    this.classList.toggle('is-fail');
  });
  row.querySelector('.remove-opt').addEventListener('click', () => row.remove());
  list.appendChild(row);
}

q('addOptionBtn')?.addEventListener('click', () => addOptionRow());

/* Show/hide options editor based on question type */
q('questionType').addEventListener('change', function() {
  const needsOptions = ['decision', 'yes_no', 'multiple_choice'].includes(this.value);
  q('optionsSection').style.display = needsOptions ? '' : 'none';
  if (needsOptions && !q('optionsList').children.length) {
    addOptionRow({ option_label: 'PASS', option_value: 'PASS', is_fail_value: false });
    addOptionRow({ option_label: 'FAIL', option_value: 'FAIL', is_fail_value: true });
    
  }
});

function getFormData() {
  const needsOptions = ['decision', 'yes_no', 'multiple_choice'].includes(q('questionType').value);
  return {
    question:      q('questionText').value.trim(),
    category:      q('category').value,
    question_type: q('questionType').value,
    display_order: Number(q('sortOrder').value),
    is_required:   q('required').checked,
    is_active:     q('active').checked,
    options:       needsOptions ? getOptions() : [],
  };
}

function setStatus(msg, type = 'ok') {
  const el = q('formStatus');
  el.textContent = msg;
  el.className = `status-msg ${type}`;
}

q('newQuestionBtn').addEventListener('click', resetForm);
q('resetFormBtn').addEventListener('click', resetForm);

q('deactivateBtn').addEventListener('click', async () => {
  if (!selectedQuestion) return;
  const newActive = !selectedQuestion.is_active;
  try {
    await toggleActive(selectedQuestion.id, newActive);
  } catch {}
});

async function toggleActive(id, newActive) {
  const item = questions.find(x => x.id === id);
  if (!item) return;
  try {
    await api('PUT', `/questions/${id}`, { ...item, is_active: newActive, options: item.options || [] });
    await loadQuestions();
    if (selectedQuestion?.id === id) editQuestion(id);
    setStatus(`Question ${newActive ? 'activated' : 'deactivated'}.`, 'ok');
  } catch (err) {
    showErrorModal('Error: ' + err.message);
  }
}

q('questionForm').addEventListener('submit', async e => {
  e.preventDefault();
  const data = getFormData();
  if (!data.question) { setStatus('Question text is required.', 'err'); return; }
  const needsOptions = ['decision', 'yes_no', 'multiple_choice'].includes(data.question_type);
  if (needsOptions && (!data.options.length || data.options.some(o => !o.option_label || !o.option_value))) {
    setStatus('All options must have a label and value.', 'err');
    return;
  }
  if (!Number.isFinite(data.display_order) || data.display_order <= 0) {
    setStatus('Sort order must be a positive number.', 'err');
    return;
  }

  setStatus('Saving…', 'ok');
  try {
    const id = q('questionId').value;
    if (id) {
      await api('PUT', `/questions/${id}`, data);
    } else {
      const result = await api('POST', '/questions', data);
      q('questionId').value = result.id;
    }
    await loadQuestions();
    setStatus('Question saved ✓', 'ok');
    if (!id) {
      // After adding, select the new question
      const created = questions.find(x => String(x.id) === String(q('questionId').value));
      if (created) editQuestion(created.id);
    }
  } catch (err) {
    showErrorModal('Error: ' + err.message);
  }
});

/* ═══════════════════════════════════════════════════════════
   PREVIEW TAB
   ═══════════════════════════════════════════════════════════ */
function renderPreview() {
  const container = q('previewList');
  if (!questions.length) {
    container.innerHTML = '<p style="color:var(--text-3);padding:24px;">No questions found.</p>';
    return;
  }

  const sections = [
    { key: 'general',   label: '🔧 General Inspection Points', icon: '🔧' },
    { key: 'extension', label: '🔄 Extension Ladder Specific', icon: '🔄' },
    { key: 'step',      label: '🪜 Step Ladder Specific',      icon: '🪜' },
  ];

  container.innerHTML = sections.map(sec => {
    const items = questions.filter(x => x.category === sec.key);
    if (!items.length) return '';
    return `
      <div class="preview-section fade-in">
        <div class="preview-section-title">${sec.label} <span style="margin-left:auto;font-size:0.75rem;opacity:0.7;">${items.length} questions</span></div>
        ${items.map((item, i) => `
          <div class="preview-question ${item.is_active ? '' : 'inactive'}" style="${item.is_active ? '' : 'opacity:0.6;'}">
            <span class="preview-num">#${item.display_order}</span>
            <span class="preview-text">${esc(item.question)}${item.is_required ? ' <span style="color:var(--fail);font-size:0.85em;">*</span>' : ''}</span>
            <span class="preview-type-badge">${typeBadge(item.question_type)}</span>
            ${!item.is_active ? '<span class="badge badge-inactive" style="margin-left:8px;">Inactive</span>' : '<span class="badge badge-active" style="margin-left:8px;">Active</span>'}
          </div>
        `).join('')}
      </div>
    `;
  }).join('');
}



/* ═══════════════════════════════════════════════════════════
   RECORDS TAB
   ═══════════════════════════════════════════════════════════ */
async function loadRecords() {
  const params = new URLSearchParams();
  const from = q('filterFrom').value;
  const to = q('filterTo').value;
  const ladder = q('filterLadder').value.trim();
  const inspector = q('filterInspector').value.trim();
  const status = q('filterStatus').value;
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (ladder) params.set('ladder', ladder);
  if (inspector) params.set('inspector', inspector);
  if (status) params.set('status', status);

  const tbody = q('recordRows');
  tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-3);">Loading...</td></tr>`;

  try {
    const records = await api('GET', '/inspections?' + params);
    window.currentRecords = records;
    renderRecords(records);
    renderRecordStats(records);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--fail);padding:12px;">${esc(err.message)}</td></tr>`;
  }
}

function renderRecordStats(records) {
  const total = records.length;
  const passed = records.filter(r => r.overall_result === 'PASS').length;
  const failed = records.filter(r => r.overall_result === 'FAIL').length;
  const statsEl = q('recordStats');
  if (statsEl) {
    statsEl.innerHTML = `
      <div class="stat-card amber-accent"><div class="stat-label">Total</div><div class="stat-value">${total}</div></div>
      <div class="stat-card pass-accent"><div class="stat-label">Passed</div><div class="stat-value">${passed}</div></div>
      <div class="stat-card fail-accent"><div class="stat-label">Failed</div><div class="stat-value">${failed}</div></div>
    `;
  }
}

function renderRecords(records) {
  const tbody = q('recordRows');
  if (!records.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">📊</div><p>No records match the current filters.</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = records.map(r => `
    <tr>
      <td class="mono" style="white-space:nowrap;">${r.inspection_date || '—'}</td>
      <td><strong>${esc(r.ladder_no)}</strong><br><span style="font-size:0.78rem;color:var(--text-2);">${esc(r.section)}</span></td>
      <td>${esc(r.inspector_name)}<br><span style="font-size:0.78rem;color:var(--text-2);">EPF: ${esc(r.epf_number)}</span></td>
      <td style="text-transform:capitalize;">${esc(r.ladder_type)}<br><span style="font-size:0.78rem;color:var(--text-2);">${r.height_feet} ft</span></td>
      <td><span class="badge ${r.overall_result === 'PASS' ? 'badge-pass' : 'badge-fail'}">${r.overall_result}</span></td>
      <td class="mono" style="font-size:0.8rem;">${r.answer_count ?? '—'} / ${r.fail_count > 0 ? `<span style="color:var(--fail);">${r.fail_count} fail</span>` : '<span style="color:var(--pass);">0 fail</span>'}</td>
      <td>
        <button class="btn-secondary btn-sm" onclick="toggleRecordDetails('${r.id}', this)" style="padding: 4px 8px; font-size: 0.75rem;">View Details</button>
        <button class="btn-primary btn-sm" onclick="printRecord('${r.id}')" style="padding: 4px 8px; font-size: 0.75rem; margin-left: 4px;">PDF</button>
      </td>
    </tr>
    <tr id="details-${r.id}" class="record-details hidden" style="background: rgba(0,0,0,0.1);">
      <td colspan="7" style="padding: 0;">
        <div class="details-content" style="padding: 16px; border-left: 3px solid var(--primary);">Loading...</div>
      </td>
    </tr>
  `).join('');
}

window.toggleRecordDetails = async function(id, btn) {
  const row = document.getElementById(`details-${id}`);
  if (!row.classList.contains('hidden')) {
    row.classList.add('hidden');
    btn.textContent = 'View Details';
    return;
  }
  row.classList.remove('hidden');
  btn.textContent = 'Hide Details';
  const content = row.querySelector('.details-content');
  if (content.dataset.loaded) return;
  content.innerHTML = 'Loading answers...';
  try {
    const answers = await api('GET', `/inspections/${id}`);
    content.innerHTML = `<table style="width:100%; font-size:0.85rem; margin:0; background:transparent;">
      <thead>
        <tr><th style="padding:6px;border-bottom:1px solid var(--border);text-align:left;">#</th><th style="padding:6px;border-bottom:1px solid var(--border);text-align:left;">Section</th><th style="padding:6px;border-bottom:1px solid var(--border);text-align:left;">Question</th><th style="padding:6px;border-bottom:1px solid var(--border);text-align:left;">Result</th><th style="padding:6px;border-bottom:1px solid var(--border);text-align:left;">Remarks</th></tr>
      </thead>
      <tbody>
        ${answers.map(a => `
          <tr>
            <td style="padding:6px;border-bottom:1px solid rgba(255,255,255,0.05);">${a.order}</td>
            <td style="padding:6px;border-bottom:1px solid rgba(255,255,255,0.05);">${esc(a.category)}</td>
            <td style="padding:6px;border-bottom:1px solid rgba(255,255,255,0.05);">${esc(a.question)}</td>
            <td style="padding:6px;border-bottom:1px solid rgba(255,255,255,0.05);"><span class="badge ${a.result === 'FAIL' ? 'badge-fail' : (a.result === 'PASS' ? 'badge-pass' : 'badge-inactive')}">${esc(a.answer_label || a.result)}</span></td>
            <td style="padding:6px;border-bottom:1px solid rgba(255,255,255,0.05);">${esc(a.remarks || '')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
    content.dataset.loaded = 'true';
  } catch (err) {
    content.innerHTML = '<span style="color:var(--fail);">Failed to load details: ' + esc(err.message) + '</span>';
  }
}

q('loadRecordsBtn').addEventListener('click', loadRecords);


q('exportPdfBtn')?.addEventListener('click', () => {
  try {
    const table = q('recordRows').cloneNode(true);
    // Remove details rows from the clone
    table.querySelectorAll('.record-details').forEach(el => el.remove());
    // Remove the actions column header & cells if needed, or just let it be.
    
    let content = '<div style="font-family: sans-serif; padding: 20px; color: #000; background: #fff; max-width: 1000px; margin: 0 auto;">';
    content += '<h2 style="margin: 0 0 20px 0; border-bottom: 2px solid #333; padding-bottom: 10px;">Inspection Records Summary</h2>';
    content += '<table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">';
    content += '<tr style="background-color: #f3f4f6; border-bottom: 2px solid #d1d5db; text-align: left;">';
    content += '<th style="padding: 10px;">Date</th>';
    content += '<th style="padding: 10px;">Ladder / Location</th>';
    content += '<th style="padding: 10px;">Inspector / EPF</th>';
    content += '<th style="padding: 10px;">Type / Height</th>';
    content += '<th style="padding: 10px;">Result</th>';
    content += '<th style="padding: 10px;">Answers</th>';
    content += '</tr>';
    
    // Copy each non-details row
    Array.from(table.children).forEach(tr => {
      content += '<tr style="border-bottom: 1px solid #e5e7eb;">';
      const tds = tr.querySelectorAll('td');
      for(let i=0; i<6; i++) { // Skip the Actions column
        content += '<td style="padding: 10px; vertical-align: top;">' + (tds[i] ? tds[i].innerHTML : '') + '</td>';
      }
      content += '</tr>';
    });
    
    content += '</table></div>';
    
    const wrapper = document.createElement('div');
    wrapper.innerHTML = content;
    
    const opt = {
      margin:       0.5,
      filename:     'inspection-summary.pdf',
      image:        { type: 'jpeg', quality: 0.98 },
      html2canvas:  { scale: 2 },
      jsPDF:        { unit: 'in', format: 'letter', orientation: 'landscape' }
    };
    
    html2pdf().set(opt).from(wrapper).save();
    
  } catch(e) {
    showErrorModal('Failed to export PDF summary: ' + e.message);
  }
});

q('exportInspectionsBtn')?.addEventListener('click', () => {
  const params = new URLSearchParams();
  const from = q('filterFrom').value;
  const to = q('filterTo').value;
  const ladder = q('filterLadder').value.trim();
  const inspector = q('filterInspector').value.trim();
  const status = q('filterStatus').value;
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (ladder) params.set('ladder', ladder);
  if (inspector) params.set('inspector', inspector);
  if (status) params.set('status', status);
  window.location.href = '/api/export/inspections?' + params.toString();
});


/* ─── Init ───────────────────────────────────────────────── */
checkSession();

window.printRecord = async function(id) {
  try {
    const answers = await api('GET', '/inspections/' + id);
    const r = window.currentRecords ? window.currentRecords.find(rec => rec.id === id) : null;
    
    let content = '<div style="font-family: sans-serif; padding: 30px; color: #000; background: #fff; max-width: 900px; margin: 0 auto;">';
    
    if (r) {
      content += '<div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; border-bottom: 2px solid #333; padding-bottom: 10px;">';
      content += '<div><h2 style="margin: 0 0 10px 0;">Inspection Report</h2>';
      content += '<p style="margin: 3px 0;"><strong>Ladder No.:</strong> ' + (r.ladder_no || 'N/A') + '</p>';
      content += '<p style="margin: 3px 0;"><strong>Type:</strong> ' + (r.ladder_type || 'N/A') + '</p>';
      content += '<p style="margin: 3px 0;"><strong>Height:</strong> ' + (r.height_feet || 0) + ' ft</p></div>';
      content += '<div style="text-align: right;">';
      content += '<p style="margin: 3px 0;"><strong>Date:</strong> ' + (r.inspection_date ? r.inspection_date.split('T')[0] : 'N/A') + '</p>';
      content += '<p style="margin: 3px 0;"><strong>Inspector:</strong> ' + (r.inspector_name || 'N/A') + '</p>';
      content += '<p style="margin: 3px 0;"><strong>Result:</strong> <span style="color:' + (r.overall_result === 'PASS' ? 'green' : 'red') + ';font-weight:bold;">' + (r.overall_result || 'N/A') + '</span></p>';
      content += '</div></div>';
    }
    
    content += '<table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">';
    content += '<tr style="background-color: #f3f4f6; border-bottom: 2px solid #d1d5db;">';
    content += '<th style="text-align: left; padding: 10px; width: 5%;">#</th>';
    content += '<th style="text-align: left; padding: 10px; width: 65%;">Question</th>';
    content += '<th style="text-align: left; padding: 10px; width: 10%;">Result</th>';
    content += '<th style="text-align: left; padding: 10px; width: 20%;">Remarks</th>';
    content += '</tr>';
    
    answers.forEach(a => {
      content += '<tr style="border-bottom: 1px solid #e5e7eb;">';
      content += '<td style="padding: 10px; vertical-align: top;">' + (a.order || '-') + '</td>';
      content += '<td style="padding: 10px; vertical-align: top;">' + esc(a.question) + '</td>';
      content += '<td style="padding: 10px; vertical-align: top; font-weight: bold; color: ' + (a.result === 'PASS' ? 'green' : (a.result === 'FAIL' ? 'red' : 'black')) + ';">' + esc(a.answer_label || a.result) + '</td>';
      content += '<td style="padding: 10px; vertical-align: top; font-size: 0.9em;">' + (esc(a.remarks) || '') + '</td>';
      content += '</tr>';
    });
    content += '</table></div>';
    
    const wrapper = document.createElement('div');
    wrapper.innerHTML = content;
    
    const opt = {
      margin:       0.5,
      filename:     'inspection-' + (r ? r.ladder_no : id) + '.pdf',
      image:        { type: 'jpeg', quality: 0.98 },
      html2canvas:  { scale: 2 },
      jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
    };
    
    html2pdf().set(opt).from(wrapper).save();
    
  } catch(e) {
    showErrorModal('Failed to export PDF: ' + e.message);
  }
};
