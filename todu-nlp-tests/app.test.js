const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ── Mocks ──
global.localStorage = {
  _data: {},
  getItem(key) { return this._data[key] || null; },
  setItem(key, value) { this._data[key] = value; },
};
global.document = {
  readyState: 'complete',
  addEventListener() {},
  removeEventListener() {},
  getElementById() { return { classList: { add() {}, remove() {}, contains() {} }, addEventListener() {}, style: {}, textContent: '' }; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement() { return { classList: { add() {} }, style: {}, appendChild() {}, addEventListener() {} }; },
  body: { appendChild() {}, classList: { add() {}, remove() {} } },
};

// ── Extract App from app.js ──
const srcPath = path.join(__dirname, '..', 'todu-nlp', 'app.js');
const src = fs.readFileSync(srcPath, 'utf8');
const lines = src.split(/\r?\n/);

// Find App object
let start = -1, depth = 0, end = -1;
for (let i = 0; i < lines.length; i++) {
  if (start === -1) {
    if (/^const App = \{/.test(lines[i])) {
      start = i;
      depth = (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
      if (depth === 0) { end = i; break; }
    }
  } else {
    depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
    if (depth === 0) { end = i; break; }
  }
}
if (start === -1) throw new Error('App object not found');

const preamble = `
const STORAGE_KEY = 'zhiban_tasks';
const ICON_SUN = ''; const ICON_MOON = ''; const ICON_SEARCH = ''; const ICON_DOC = '';
function loadFromStorage() { return JSON.parse(global.localStorage.getItem('zhiban_tasks') || '[]'); }
function saveToStorage(tasks) { global.localStorage.setItem('zhiban_tasks', JSON.stringify(tasks)); }
function addTask(task) { const tasks = loadFromStorage(); task.id = (tasks.reduce((m,t)=>Math.max(m,t.id||0),0)+1); tasks.unshift(task); saveToStorage(tasks); return task.id; }
function updateTask(task) { const tasks = loadFromStorage(); const idx = tasks.findIndex(t=>t.id===task.id); if(idx===-1) throw new Error('任务不存在'); tasks[idx]=task; saveToStorage(tasks); }
function deleteTask(id) { const tasks = loadFromStorage(); saveToStorage(tasks.filter(t=>t.id!==id)); }
function getAllTasks() { return loadFromStorage(); }
function getTask(id) { return loadFromStorage().find(t=>t.id===id)||null; }
`;

const App = new Function(preamble + lines.slice(start, end + 1).join('\n') + '\nreturn App;')();

// ── Helpers ──
function dateStr(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// ── Tests ──

describe('advanceDue', () => {
  const ref = '2026-06-24T00:00:00.000Z';

  it('daily: advances by 1 day', () => {
    const r = App.advanceDue(ref, 'daily');
    assert.equal(new Date(r).toISOString().slice(0, 10), '2026-06-25');
  });

  it('daily: crosses month boundary', () => {
    const r = App.advanceDue('2026-01-31T00:00:00.000Z', 'daily');
    assert.equal(new Date(r).toISOString().slice(0, 10), '2026-02-01');
  });

  it('daily: crosses year boundary', () => {
    const r = App.advanceDue('2026-12-31T00:00:00.000Z', 'daily');
    assert.equal(new Date(r).toISOString().slice(0, 10), '2027-01-01');
  });

  it('weekly: advances by 7 days', () => {
    const r = App.advanceDue(ref, 'weekly');
    assert.equal(new Date(r).toISOString().slice(0, 10), '2026-07-01');
  });

  it('monthly: advances by 1 month', () => {
    const r = App.advanceDue('2026-03-15T00:00:00.000Z', 'monthly');
    assert.equal(new Date(r).toISOString().slice(0, 10), '2026-04-15');
  });

  it('monthly: end-of-month overflow (Jan 31 → Mar 3 in 2026)', () => {
    const r = App.advanceDue('2026-01-31T00:00:00.000Z', 'monthly');
    assert.equal(new Date(r).toISOString().slice(0, 10), '2026-03-03');
  });

  it('quarterly: advances by 3 months', () => {
    const r = App.advanceDue('2026-01-15T00:00:00.000Z', 'quarterly');
    assert.equal(new Date(r).toISOString().slice(0, 10), '2026-04-15');
  });

  it('quarterly: end-of-month overflow (Jan 31 → May 1)', () => {
    const r = App.advanceDue('2026-01-31T00:00:00.000Z', 'quarterly');
    assert.equal(new Date(r).toISOString().slice(0, 10), '2026-05-01');
  });

  it('null recurrence: returns same date unchanged', () => {
    const r = App.advanceDue(ref, null);
    assert.equal(new Date(r).toISOString().slice(0, 10), '2026-06-24');
  });

  it('undefined recurrence: returns same date unchanged', () => {
    const r = App.advanceDue(ref, undefined);
    assert.equal(new Date(r).toISOString().slice(0, 10), '2026-06-24');
  });

  it('unknown recurrence: returns same date unchanged', () => {
    const r = App.advanceDue(ref, 'yearly');
    assert.equal(new Date(r).toISOString().slice(0, 10), '2026-06-24');
  });

  it('no dueIso: advances from today (daily)', () => {
    const today = dateStr(new Date());
    const tomorrow = dateStr(new Date(Date.now() + 86400000));
    const r = App.advanceDue(null, 'daily');
    assert.ok([today, tomorrow].includes(new Date(r).toISOString().slice(0, 10)),
      'should be today or tomorrow');
  });

  it('no dueIso + weekly: advances from today', () => {
    const weekLater = dateStr(new Date(Date.now() + 7 * 86400000));
    const r = App.advanceDue(null, 'weekly');
    assert.equal(new Date(r).toISOString().slice(0, 10), weekLater);
  });
});

describe('formatDate', () => {
  const now = new Date();
  const todayStr = dateStr(now);
  const y = now.getFullYear();

  it('today: shows "今天 HH:mm"', () => {
    const iso = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 30).toISOString();
    const r = App.formatDate(iso);
    assert.ok(r.startsWith('今天 '));
    assert.ok(r.includes('14:30'));
  });

  it('tomorrow: shows "明天 HH:mm"', () => {
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 5);
    const r = App.formatDate(t.toISOString());
    assert.ok(r.startsWith('明天 '));
    assert.ok(r.includes('09:05'));
  });

  it('same year, future: shows "M月D日 HH:mm"', () => {
    const r = App.formatDate(y + '-12-25T10:00:00.000Z');
    assert.ok(r.startsWith('12月25日 '));
    assert.ok(r.includes('10:00') || r.includes('18:00')); // depends on TZ
  });

  it('different year: shows "YYYY年M月D日 HH:mm"', () => {
    const r = App.formatDate('2025-01-01T08:00:00.000Z');
    assert.ok(r.startsWith('2025年1月1日 ') || r.startsWith('2025年1月1日 '));
  });

  it('zero-pads hours and minutes', () => {
    const r = App.formatDate(y + '-06-01T00:05:00.000Z');
    assert.ok(r.includes('00:05') || r.includes('08:05')); // depends on TZ
  });
});

describe('toDatetimeLocal', () => {
  it('formats as YYYY-MM-DDTHH:mm', () => {
    const r = App.toDatetimeLocal('2026-06-24T14:30:00.000Z');
    assert.match(r, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it('zero-pads single-digit month and day', () => {
    const r = App.toDatetimeLocal('2026-01-05T00:00:00.000Z');
    assert.match(r, /^\d{4}-01-05T/);
  });
});

describe('todayStr', () => {
  it('returns YYYY-MM-DD matching current date', () => {
    const r = App.todayStr();
    const expected = dateStr(new Date());
    assert.equal(r, expected);
  });

  it('matches /^\d{4}-\d{2}-\d{2}$/', () => {
    assert.match(App.todayStr(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('escape', () => {
  it('escapes & < > " \'', () => {
    assert.equal(App.escape('a & b < c > d " e \' f'), 'a &amp; b &lt; c &gt; d &quot; e &#39; f');
  });

  it('leaves normal text unchanged', () => {
    assert.equal(App.escape('hello world 123'), 'hello world 123');
  });

  it('returns empty string for empty input', () => {
    assert.equal(App.escape(''), '');
  });

  it('returns empty string for null/undefined', () => {
    assert.equal(App.escape(null), '');
    assert.equal(App.escape(undefined), '');
  });

  it('handles Chinese text', () => {
    assert.equal(App.escape('提交季度报告'), '提交季度报告');
  });
});

describe('sanitizeImport', () => {
  it('returns [] for non-array', () => {
    assert.deepEqual(App.sanitizeImport(null), []);
    assert.deepEqual(App.sanitizeImport(undefined), []);
    assert.deepEqual(App.sanitizeImport('string'), []);
    assert.deepEqual(App.sanitizeImport({}), []);
  });

  it('returns [] for empty array', () => {
    assert.deepEqual(App.sanitizeImport([]), []);
  });

  it('skips items without title', () => {
    const r = App.sanitizeImport([{ title: '' }, { title: '   ' }, { description: 'no title' }]);
    assert.equal(r.length, 0);
  });

  it('skips null/undefined items', () => {
    const r = App.sanitizeImport([null, undefined, { title: 'keep' }]);
    assert.equal(r.length, 1);
    assert.equal(r[0].title, 'keep');
  });

  it('defaults missing fields', () => {
    const r = App.sanitizeImport([{ title: 'test' }]);
    const t = r[0];
    assert.equal(t.title, 'test');
    assert.equal(t.description, '');
    assert.equal(t.stakeholders, '');
    assert.equal(t.due, null);
    assert.equal(t.note, '');
    assert.equal(t.status, 'todo');
    assert.equal(t.recurrence, null);
    assert.equal(t.image, null);
    assert.ok(t.createdAt);
    assert.ok(t.updatedAt);
  });

  it('validates status (only todo/doing/done)', () => {
    const r = App.sanitizeImport([
      { title: 'a', status: 'todo' },
      { title: 'b', status: 'doing' },
      { title: 'c', status: 'done' },
      { title: 'd', status: 'invalid' },
      { title: 'e', status: 'archived' },
    ]);
    assert.equal(r[0].status, 'todo');
    assert.equal(r[1].status, 'doing');
    assert.equal(r[2].status, 'done');
    assert.equal(r[3].status, 'todo'); // fallback
    assert.equal(r[4].status, 'todo'); // fallback
  });

  it('validates recurrence (daily/weekly/monthly/quarterly)', () => {
    const r = App.sanitizeImport([
      { title: 'a', recurrence: 'daily' },
      { title: 'b', recurrence: 'weekly' },
      { title: 'c', recurrence: 'monthly' },
      { title: 'd', recurrence: 'quarterly' },
      { title: 'e', recurrence: 'yearly' },
      { title: 'f', recurrence: null },
    ]);
    assert.equal(r[0].recurrence, 'daily');
    assert.equal(r[1].recurrence, 'weekly');
    assert.equal(r[2].recurrence, 'monthly');
    assert.equal(r[3].recurrence, 'quarterly');
    assert.equal(r[4].recurrence, null);
    assert.equal(r[5].recurrence, null);
  });

  it('validates image (only data:image/...)', () => {
    const r = App.sanitizeImport([
      { title: 'a', image: 'data:image/png;base64,abc' },
      { title: 'b', image: 'data:image/jpeg;base64,xyz' },
      { title: 'c', image: 'https://evil.com/x.png' },
      { title: 'd', image: 'javascript:alert(1)' },
      { title: 'e', image: null },
    ]);
    assert.ok(r[0].image.startsWith('data:image/'));
    assert.ok(r[1].image.startsWith('data:image/'));
    assert.equal(r[2].image, null);
    assert.equal(r[3].image, null);
    assert.equal(r[4].image, null);
  });

  it('handles invalid due date', () => {
    const r = App.sanitizeImport([
      { title: 'a', due: 'not-a-date' },
      { title: 'b', due: '2026-06-24T00:00:00.000Z' },
    ]);
    assert.equal(r[0].due, null);
    assert.ok(r[1].due);
  });

  it('preserves valid id', () => {
    const r = App.sanitizeImport([{ title: 'a', id: 42 }]);
    assert.equal(r[0].id, 42);
  });

  it('nullifies non-integer or non-positive id', () => {
    const r = App.sanitizeImport([
      { title: 'a', id: 0 },
      { title: 'b', id: -1 },
      { title: 'c', id: 3.5 },
      { title: 'd', id: 'string' },
    ]);
    assert.equal(r[0].id, null);
    assert.equal(r[1].id, null);
    assert.equal(r[2].id, null);
    assert.equal(r[3].id, null);
  });

  it('trims title whitespace', () => {
    const r = App.sanitizeImport([{ title: '  hello world  ' }]);
    assert.equal(r[0].title, 'hello world');
  });
});

describe('contentFingerprint', () => {
  it('returns title||due||stakeholders', () => {
    const r = App.contentFingerprint({
      title: '提交报告',
      due: '2026-06-24T00:00:00.000Z',
      stakeholders: '张三',
    });
    assert.equal(r, '提交报告||2026-06-24T00:00:00.000Z||张三');
  });

  it('handles missing due', () => {
    const r = App.contentFingerprint({ title: 'test', stakeholders: '李四' });
    assert.equal(r, 'test||||李四');
  });

  it('handles missing stakeholders', () => {
    const r = App.contentFingerprint({ title: 'test', due: '2026-06-24T00:00:00.000Z' });
    assert.equal(r, 'test||2026-06-24T00:00:00.000Z||');
  });

  it('normalizes due to ISO string', () => {
    const r = App.contentFingerprint({ title: 'test', due: '2026-06-18' });
    assert.equal(r, 'test||2026-06-18T00:00:00.000Z||');
  });

  it('handles invalid due', () => {
    const r = App.contentFingerprint({ title: 'test', due: 'not-a-date' });
    assert.equal(r, 'test||||');
  });
});

describe('sortTasks', () => {
  function makeTask(id, status, dueOffsetDays, createdOffsetDays) {
    const now = new Date();
    const due = dueOffsetDays !== null
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + dueOffsetDays, 12, 0).toISOString()
      : null;
    const createdAt = new Date(now.getTime() - createdOffsetDays * 86400000).toISOString();
    return { id, title: 't' + id, status, due, createdAt, description: '', stakeholders: '', note: '', image: null, recurrence: null };
  }

  it('overdue tasks come first', () => {
    App.tasks = [
      makeTask(1, 'todo', 5, 0),   // future
      makeTask(2, 'todo', -2, 0),  // overdue
      makeTask(3, 'todo', 10, 0),  // far future
    ];
    App.sortTasks();
    assert.equal(App.tasks[0].id, 2); // overdue first
  });

  it('today tasks come after overdue, before future', () => {
    App.tasks = [
      makeTask(1, 'todo', 5, 0),   // future
      makeTask(2, 'todo', 0, 0),   // today
      makeTask(3, 'todo', -1, 0),  // overdue
    ];
    App.sortTasks();
    assert.equal(App.tasks[0].id, 3); // overdue
    assert.equal(App.tasks[1].id, 2); // today
    assert.equal(App.tasks[2].id, 1); // future
  });

  it('future tasks sorted by due date ascending', () => {
    App.tasks = [
      makeTask(1, 'todo', 10, 0),
      makeTask(2, 'todo', 3, 0),
      makeTask(3, 'todo', 7, 0),
    ];
    App.sortTasks();
    assert.equal(App.tasks[0].id, 2); // 3 days
    assert.equal(App.tasks[1].id, 3); // 7 days
    assert.equal(App.tasks[2].id, 1); // 10 days
  });

  it('done tasks go last', () => {
    App.tasks = [
      makeTask(1, 'done', -5, 0),
      makeTask(2, 'todo', 5, 0),
      makeTask(3, 'done', -1, 0),
    ];
    App.sortTasks();
    assert.equal(App.tasks[0].status, 'todo');
    assert.equal(App.tasks[1].status, 'done');
    assert.equal(App.tasks[2].status, 'done');
  });

  it('done tasks sorted by createdAt descending', () => {
    App.tasks = [
      makeTask(1, 'done', null, 10), // older
      makeTask(2, 'done', null, 1),  // newer
      makeTask(3, 'done', null, 5),  // middle
    ];
    App.sortTasks();
    assert.equal(App.tasks[0].id, 2); // newest first
    assert.equal(App.tasks[1].id, 3);
    assert.equal(App.tasks[2].id, 1); // oldest last
  });

  it('tasks with due date come before tasks without', () => {
    App.tasks = [
      makeTask(1, 'todo', null, 0),
      makeTask(2, 'todo', 5, 0),
    ];
    App.sortTasks();
    assert.equal(App.tasks[0].id, 2); // has due
    assert.equal(App.tasks[1].id, 1); // no due
  });

  it('tasks without due sorted by createdAt descending', () => {
    App.tasks = [
      makeTask(1, 'todo', null, 10),
      makeTask(2, 'todo', null, 1),
    ];
    App.sortTasks();
    assert.equal(App.tasks[0].id, 2); // newer
    assert.equal(App.tasks[1].id, 1); // older
  });

  it('mixed scenario: overdue > today > future > done', () => {
    App.tasks = [
      makeTask(1, 'done', -10, 5),
      makeTask(2, 'todo', 7, 0),
      makeTask(3, 'todo', -2, 0),
      makeTask(4, 'todo', 0, 0),
      makeTask(5, 'done', -1, 1),
      makeTask(6, 'todo', 3, 0),
    ];
    App.sortTasks();
    const ids = App.tasks.map(t => t.id);
    // overdue first: 3
    // today: 4
    // future by due: 6 (3d), 2 (7d)
    // done by createdAt desc: 5 (newer), 1 (older)
    assert.deepEqual(ids, [3, 4, 6, 2, 5, 1]);
  });
});

console.log('\nAll app.test.js suites registered. Run with: node --test');