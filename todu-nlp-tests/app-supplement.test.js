const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ── Mocks ──
const storage = {};
global.localStorage = {
  getItem(key) { return storage[key] || null; },
  setItem(key, value) { storage[key] = value; },
};
global.document = {
  readyState: 'complete',
  addEventListener() {},
  removeEventListener() {},
  getElementById(id) {
    return {
      classList: { add() {}, remove() {}, contains() { return false; } },
      addEventListener() {},
      style: {},
      textContent: '',
      parentElement: null,
      remove() {},
    };
  },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement() { return { classList: { add() {} }, style: {}, appendChild() {}, addEventListener() {} }; },
  body: { appendChild() {}, classList: { add() {}, remove() {} } },
};

// ── Extract App ──
const srcPath = path.join(__dirname, '..', 'todu-nlp', 'app.js');
const src = fs.readFileSync(srcPath, 'utf8');
const lines = src.split(/\r?\n/);
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
function exportToUserFolder(tasks) { return true; }
function importFromUserFolder(callback) { callback(null); }
`;

const App = new Function(preamble + lines.slice(start, end + 1).join('\n') + '\nreturn App;')();

// ── Helpers ──
function resetStorage() {
  Object.keys(storage).forEach(k => delete storage[k]);
}

function seedTasks(list) {
  storage['zhiban_tasks'] = JSON.stringify(list);
  App.tasks = JSON.parse(JSON.stringify(list));
}

function makeTask(id, overrides = {}) {
  return {
    id, title: 't' + id, description: '', stakeholders: '', due: null, note: '',
    status: 'todo', recurrence: null, image: null,
    createdAt: '2026-06-20T00:00:00.000Z', updatedAt: '2026-06-20T00:00:00.000Z',
    ...overrides,
  };
}

// Mock render/toast to avoid DOM errors
let lastToast = '';
let renderCalled = false;
function mockUI() {
  lastToast = '';
  renderCalled = false;
  App.render = () => { renderCalled = true; };
  App.toast = (msg) => { lastToast = msg; };
  App.toastWithUndo = (msg, onUndo) => { lastToast = msg; };
  App.loadTasks = function() { this.tasks = JSON.parse(JSON.stringify(JSON.parse(storage['zhiban_tasks'] || '[]'))); };
}
beforeEach(() => { resetStorage(); mockUI(); });

// ═══════════════════════════════════════════════════════════
describe('setStatus', () => {
  it('changes status from todo to doing', () => {
    seedTasks([makeTask(1, { status: 'todo' })]);
    App.setStatus(1, 'doing');
    assert.equal(App.tasks[0].status, 'doing');
    assert.ok(renderCalled);
  });

  it('changes status from doing to done', () => {
    seedTasks([makeTask(1, { status: 'doing' })]);
    App.setStatus(1, 'done');
    assert.equal(App.tasks[0].status, 'done');
  });

  it('changes status from done to todo (restart)', () => {
    seedTasks([makeTask(1, { status: 'done' })]);
    App.setStatus(1, 'todo');
    assert.equal(App.tasks[0].status, 'todo');
  });

  it('no-ops for non-existent task', () => {
    seedTasks([makeTask(1)]);
    App.setStatus(999, 'doing');
    assert.equal(App.tasks[0].status, 'todo');
  });

  it('updates updatedAt timestamp', () => {
    seedTasks([makeTask(1, { status: 'todo' })]);
    App.setStatus(1, 'doing');
    assert.notEqual(App.tasks[0].updatedAt, '2026-06-20T00:00:00.000Z');
  });

  it('persists to localStorage', () => {
    seedTasks([makeTask(1, { status: 'todo' })]);
    App.setStatus(1, 'done');
    const stored = JSON.parse(storage['zhiban_tasks']);
    assert.equal(stored[0].status, 'done');
  });
});

// ═══════════════════════════════════════════════════════════
describe('postponeTask', () => {
  it('postpones due date by 1 day', () => {
    seedTasks([makeTask(1, { due: '2026-06-24T10:00:00.000Z' })]);
    App.postponeTask(1);
    const newDue = new Date(App.tasks[0].due);
    assert.equal(newDue.toISOString().slice(0, 10), '2026-06-25');
  });

  it('no-ops when task has no due date', () => {
    seedTasks([makeTask(1, { due: null })]);
    App.postponeTask(1);
    assert.equal(App.tasks[0].due, null);
  });

  it('no-ops for non-existent task', () => {
    seedTasks([makeTask(1)]);
    App.postponeTask(999);
    assert.equal(App.tasks[0].due, null);
  });

  it('persists to localStorage', () => {
    seedTasks([makeTask(1, { due: '2026-06-24T10:00:00.000Z' })]);
    App.postponeTask(1);
    const stored = JSON.parse(storage['zhiban_tasks']);
    assert.equal(new Date(stored[0].due).toISOString().slice(0, 10), '2026-06-25');
  });
});

// ═══════════════════════════════════════════════════════════
describe('setRecurrence', () => {
  it('sets daily recurrence', () => {
    seedTasks([makeTask(1)]);
    App.setRecurrence(1, 'daily');
    assert.equal(App.tasks[0].recurrence, 'daily');
  });

  it('sets weekly recurrence', () => {
    seedTasks([makeTask(1)]);
    App.setRecurrence(1, 'weekly');
    assert.equal(App.tasks[0].recurrence, 'weekly');
  });

  it('sets monthly recurrence', () => {
    seedTasks([makeTask(1)]);
    App.setRecurrence(1, 'monthly');
    assert.equal(App.tasks[0].recurrence, 'monthly');
  });

  it('sets quarterly recurrence', () => {
    seedTasks([makeTask(1)]);
    App.setRecurrence(1, 'quarterly');
    assert.equal(App.tasks[0].recurrence, 'quarterly');
  });

  it('cancels recurrence with null', () => {
    seedTasks([makeTask(1, { recurrence: 'weekly' })]);
    App.setRecurrence(1, null);
    assert.equal(App.tasks[0].recurrence, null);
  });

  it('cancels recurrence with undefined (falsy fallback)', () => {
    seedTasks([makeTask(1, { recurrence: 'daily' })]);
    App.setRecurrence(1, undefined);
    assert.equal(App.tasks[0].recurrence, null);
  });

  it('no-ops for non-existent task', () => {
    seedTasks([makeTask(1)]);
    App.setRecurrence(999, 'daily');
    assert.equal(App.tasks[0].recurrence, null);
  });

  it('persists to localStorage', () => {
    seedTasks([makeTask(1)]);
    App.setRecurrence(1, 'daily');
    const stored = JSON.parse(storage['zhiban_tasks']);
    assert.equal(stored[0].recurrence, 'daily');
  });
});

// ═══════════════════════════════════════════════════════════
describe('completeAndNextCycle', () => {
  it('advances due by 1 day for daily, resets status to todo', () => {
    seedTasks([makeTask(1, { due: '2026-06-24T10:00:00.000Z', recurrence: 'daily', status: 'doing' })]);
    App.completeAndNextCycle(1);
    assert.equal(App.tasks[0].status, 'todo');
    assert.equal(new Date(App.tasks[0].due).toISOString().slice(0, 10), '2026-06-25');
  });

  it('advances due by 7 days for weekly', () => {
    seedTasks([makeTask(1, { due: '2026-06-24T10:00:00.000Z', recurrence: 'weekly', status: 'doing' })]);
    App.completeAndNextCycle(1);
    assert.equal(new Date(App.tasks[0].due).toISOString().slice(0, 10), '2026-07-01');
  });

  it('advances due by 1 month for monthly', () => {
    seedTasks([makeTask(1, { due: '2026-06-15T10:00:00.000Z', recurrence: 'monthly', status: 'doing' })]);
    App.completeAndNextCycle(1);
    assert.equal(new Date(App.tasks[0].due).toISOString().slice(0, 10), '2026-07-15');
  });

  it('advances due by 3 months for quarterly', () => {
    seedTasks([makeTask(1, { due: '2026-03-15T10:00:00.000Z', recurrence: 'quarterly', status: 'doing' })]);
    App.completeAndNextCycle(1);
    assert.equal(new Date(App.tasks[0].due).toISOString().slice(0, 10), '2026-06-15');
  });

  it('no-ops when task has no recurrence', () => {
    seedTasks([makeTask(1, { due: '2026-06-24T10:00:00.000Z', recurrence: null, status: 'doing' })]);
    App.completeAndNextCycle(1);
    assert.equal(App.tasks[0].status, 'doing');
  });

  it('no-ops for non-existent task', () => {
    seedTasks([makeTask(1)]);
    App.completeAndNextCycle(999);
    assert.equal(App.tasks[0].status, 'todo');
  });

  it('persists to localStorage', () => {
    seedTasks([makeTask(1, { due: '2026-06-24T10:00:00.000Z', recurrence: 'daily', status: 'doing' })]);
    App.completeAndNextCycle(1);
    const stored = JSON.parse(storage['zhiban_tasks']);
    assert.equal(stored[0].status, 'todo');
    assert.equal(new Date(stored[0].due).toISOString().slice(0, 10), '2026-06-25');
  });
});

// ═══════════════════════════════════════════════════════════
describe('confirmDelete + undoDelete', () => {
  it('confirmDelete removes task from tasks array', () => {
    seedTasks([makeTask(1), makeTask(2)]);
    App.pendingDeleteId = 1;
    App.confirmDelete();
    assert.equal(App.tasks.length, 1);
    assert.equal(App.tasks[0].id, 2);
  });

  it('confirmDelete removes task from localStorage', () => {
    seedTasks([makeTask(1), makeTask(2)]);
    App.pendingDeleteId = 1;
    App.confirmDelete();
    const stored = JSON.parse(storage['zhiban_tasks']);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, 2);
  });

  it('confirmDelete stores deleted task for undo', () => {
    seedTasks([makeTask(1)]);
    App.pendingDeleteId = 1;
    App.confirmDelete();
    assert.ok(App.deletedTask);
    assert.equal(App.deletedTask.id, 1);
  });

  it('confirmDelete clears pendingDeleteId', () => {
    seedTasks([makeTask(1)]);
    App.pendingDeleteId = 1;
    App.confirmDelete();
    assert.equal(App.pendingDeleteId, null);
  });

  it('undoDelete restores deleted task', () => {
    seedTasks([makeTask(1), makeTask(2)]);
    App.pendingDeleteId = 1;
    App.confirmDelete();
    App.undoDelete();
    assert.equal(App.tasks.length, 2);
    assert.equal(App.tasks[0].id, 1);
  });

  it('undoDelete restores to localStorage', () => {
    seedTasks([makeTask(1), makeTask(2)]);
    App.pendingDeleteId = 1;
    App.confirmDelete();
    App.undoDelete();
    const stored = JSON.parse(storage['zhiban_tasks']);
    assert.equal(stored.length, 2);
  });

  it('undoDelete clears deletedTask after restore', () => {
    seedTasks([makeTask(1)]);
    App.pendingDeleteId = 1;
    App.confirmDelete();
    App.undoDelete();
    assert.equal(App.deletedTask, null);
  });

  it('undoDelete no-ops when no deletedTask', () => {
    seedTasks([makeTask(1)]);
    App.deletedTask = null;
    App.undoDelete();
    assert.equal(App.tasks.length, 1);
  });

  it('confirmDelete clears previous deleteTimer', () => {
    seedTasks([makeTask(1), makeTask(2)]);
    let cleared = false;
    App.deleteTimer = { _cleared: false };
    const origClear = global.clearTimeout;
    global.clearTimeout = (t) => { cleared = true; };
    App.pendingDeleteId = 1;
    App.confirmDelete();
    global.clearTimeout = origClear;
    assert.ok(App.deleteTimer);
  });

  it('confirmDelete no-ops when pendingDeleteId is null', () => {
    seedTasks([makeTask(1)]);
    App.pendingDeleteId = null;
    App.confirmDelete();
    assert.equal(App.tasks.length, 1);
  });

  it('confirmDelete no-ops when task not found', () => {
    seedTasks([makeTask(1)]);
    App.pendingDeleteId = 999;
    App.confirmDelete();
    assert.equal(App.tasks.length, 1);
  });
});

// ═══════════════════════════════════════════════════════════
describe('markExportDismissedToday / isExportDismissedToday', () => {
  it('marks today as dismissed', () => {
    App.markExportDismissedToday();
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(storage['zhiban_export_dismissed'], today);
  });

  it('isExportDismissedToday returns true after marking', () => {
    App.markExportDismissedToday();
    assert.equal(App.isExportDismissedToday(), true);
  });

  it('isExportDismissedToday returns false when not marked', () => {
    delete storage['zhiban_export_dismissed'];
    assert.equal(App.isExportDismissedToday(), false);
  });

  it('isExportDismissedToday returns false for stale date', () => {
    storage['zhiban_export_dismissed'] = '2020-01-01';
    assert.equal(App.isExportDismissedToday(), false);
  });
});

// ═══════════════════════════════════════════════════════════
describe('finishImport', () => {
  it('toasts with import count only', () => {
    App.finishImport(5, 0, 0);
    assert.ok(lastToast.includes('已导入 5 条'));
    assert.ok(!lastToast.includes('跳过'));
  });

  it('toasts with invalid skipped count', () => {
    App.finishImport(3, 2, 0);
    assert.ok(lastToast.includes('已导入 3 条'));
    assert.ok(lastToast.includes('跳过 2 条无效数据'));
  });

  it('toasts with duplicate skipped count', () => {
    App.finishImport(3, 0, 1);
    assert.ok(lastToast.includes('已导入 3 条'));
    assert.ok(lastToast.includes('跳过 1 条重复'));
  });

  it('toasts with both invalid and duplicate skipped', () => {
    App.finishImport(3, 2, 1);
    assert.ok(lastToast.includes('已导入 3 条'));
    assert.ok(lastToast.includes('跳过 2 条无效数据'));
    assert.ok(lastToast.includes('跳过 1 条重复'));
  });

  it('reloads tasks after import', () => {
    seedTasks([makeTask(1)]);
    App.finishImport(1, 0, 0);
    assert.equal(App.tasks.length, 1);
  });
});

// ═══════════════════════════════════════════════════════════
describe('confirmImportOverwrite', () => {
  it('replaces all existing tasks with imported data', () => {
    seedTasks([makeTask(1), makeTask(2)]);
    App.readImportFile = (cb) => cb([
      { title: 'imported A' }, { title: 'imported B' }, { title: 'imported C' },
    ], 0);
    App.confirmImportOverwrite();
    assert.equal(App.tasks.length, 3);
    assert.equal(App.tasks[0].title, 'imported A');
    assert.equal(App.tasks[0].id, 1);
    assert.equal(App.tasks[1].id, 2);
    assert.equal(App.tasks[2].id, 3);
  });

  it('handles empty import', () => {
    seedTasks([makeTask(1)]);
    App.readImportFile = (cb) => cb([], 0);
    App.confirmImportOverwrite();
    assert.equal(App.tasks.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════
describe('confirmImportMerge', () => {
  it('appends new tasks to existing ones', () => {
    seedTasks([makeTask(1, { title: 'existing' })]);
    App.readImportFile = (cb) => cb([
      { title: 'new task', id: null },
    ], 0);
    App.confirmImportMerge();
    assert.equal(App.tasks.length, 2);
    assert.equal(App.tasks[0].title, 'new task');
    assert.equal(App.tasks[1].title, 'existing');
  });

  it('skips duplicate by id', () => {
    seedTasks([makeTask(1, { title: 'existing' })]);
    App.readImportFile = (cb) => cb([
      { title: 'duplicate by id', id: 1 },
      { title: 'new task', id: null },
    ], 0);
    App.confirmImportMerge();
    assert.equal(App.tasks.length, 2);
    assert.equal(App.tasks[0].title, 'new task');
  });

  it('skips duplicate by content fingerprint', () => {
    seedTasks([makeTask(1, { title: 'same', due: '2026-06-24T00:00:00.000Z', stakeholders: '张三' })]);
    App.readImportFile = (cb) => cb([
      { title: 'same', due: '2026-06-24T00:00:00.000Z', stakeholders: '张三', id: 99 },
      { title: 'new task', id: null },
    ], 0);
    App.confirmImportMerge();
    assert.equal(App.tasks.length, 2);
    assert.equal(App.tasks[0].title, 'new task');
  });

  it('assigns new ids to tasks without id', () => {
    seedTasks([makeTask(5, { title: 'existing' })]);
    App.readImportFile = (cb) => cb([
      { title: 'no id 1', id: null },
      { title: 'no id 2', id: null },
    ], 0);
    App.confirmImportMerge();
    assert.equal(App.tasks.length, 3);
    const ids = App.tasks.map(t => t.id);
    assert.ok(ids.includes(6));
    assert.ok(ids.includes(7));
  });
});

// ═══════════════════════════════════════════════════════════
describe('confirmImportCrossMerge', () => {
  it('appends new tasks with reassigned ids', () => {
    seedTasks([makeTask(1, { title: 'existing' })]);
    App.readImportFile = (cb) => cb([
      { title: 'cross task', id: 42 },
    ], 0);
    App.confirmImportCrossMerge();
    assert.equal(App.tasks.length, 2);
    assert.equal(App.tasks[0].title, 'cross task');
    assert.equal(App.tasks[0].id, 2);
  });

  it('skips duplicate by content fingerprint', () => {
    seedTasks([makeTask(1, { title: 'same', due: '2026-06-24T00:00:00.000Z', stakeholders: '李四' })]);
    App.readImportFile = (cb) => cb([
      { title: 'same', due: '2026-06-24T00:00:00.000Z', stakeholders: '李四', id: 99 },
      { title: 'unique', id: 100 },
    ], 0);
    App.confirmImportCrossMerge();
    assert.equal(App.tasks.length, 2);
    assert.equal(App.tasks[0].title, 'unique');
  });

  it('reassigns all ids sequentially', () => {
    seedTasks([makeTask(10, { title: 'existing' })]);
    App.readImportFile = (cb) => cb([
      { title: 'a', id: 5 },
      { title: 'b', id: 7 },
      { title: 'c', id: 99 },
    ], 0);
    App.confirmImportCrossMerge();
    const imported = App.tasks.filter(t => t.title !== 'existing');
    assert.equal(imported.length, 3);
    assert.equal(imported[0].id, 11);
    assert.equal(imported[1].id, 12);
    assert.equal(imported[2].id, 13);
  });
});

console.log('\nAll app-supplement.test.js suites registered. Run with: node --test');