/**
 * 智办 本次视觉改动的方法级回归测试
 * 覆盖本次实际修改过的 app.js 方法（测试脚本 1/2 未覆盖的 DOM 耦合部分）：
 *   - 主题切换 initTheme/syncThemeIcon/syncThemeColor/toggleTheme
 *   - showExportBanner（提取到 CSS 后的结构生成 + 防重复）
 *   - toast（toast-exit 退出动画类）
 *
 * 需要一个能记录操作的 DOM 桩：getElementById 返回带真实 classList/style/textContent
 * 的元素，documentElement/document.body 能被 setAttribute/appendChild 真实操作。
 *
 * 运行：node _changed_methods_regression.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const APP_JS = path.join(__dirname, '..', 'todu-nlp', 'app.js');
const BASE_TIME = new Date('2026-06-22T10:00:00').getTime();

// ===== 能记录操作的元素桩 =====
function makeEl(id) {
  const el = {
    _id: id, style: {}, value: '', _text: '', _html: '', dataset: {},
    _attrs: {}, _children: [], _parent: null,
    _listeners: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, force) { if (force === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else { force ? this._set.add(c) : this._set.delete(c); } return this._set.has(c); },
      contains(c) { return this._set.has(c); }
    },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    get id() { return Object.prototype.hasOwnProperty.call(this._attrs, 'id') ? this._attrs.id : null; },
    set id(v) { this._attrs.id = String(v); },
    get className() { return Array.from(this.classList._set).join(' '); },
    set className(v) { this.classList._set = new Set(String(v).split(/\s+/).filter(Boolean)); },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    removeEventListener() {},
    appendChild(child) { this._children.push(child); child._parent = this; return child; },
    removeChild(child) { this._children = this._children.filter(c => c !== child); },
    remove() { if (this._parent) { this._parent.removeChild(this); this._parent = null; } },
    get parentElement() { return this._parent; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    click() { (this._listeners.click || []).forEach(fn => fn({})); },
    dispatchEvent() {},
    closest() { return null; },
    childNodes: []
  };
  return el;
}

// ===== 全局桩 =====
function makeStorage() {
  const d = {};
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null; },
    setItem(k, v) { d[k] = String(v); },
    removeItem(k) { delete d[k]; },
    clear() { for (const k of Object.keys(d)) delete d[k]; },
    _raw: d
  };
}
const storage = makeStorage();

// 元素注册表：按 id 存取，App 期望的 id 都预建
const elRegistry = {};
function getEl(id) {
  if (!elRegistry[id]) elRegistry[id] = makeEl(id);
  return elRegistry[id];
}

// 真实的 documentElement（主题切换要 setAttribute data-theme）
const documentElement = makeEl('documentElement');
// 真实的 body（exportBanner 要 appendChild）
const bodyEl = makeEl('body');
// 真实的 head
const headEl = makeEl('head');
// meta[theme-color] 元素
const themeColorMeta = makeEl('themeColorMeta');

// 真实定时器记录（toast 用 setTimeout）
const timers = [];
let timerSeq = 0;

const sandbox = {
  console,
  Date: class extends Date {
    constructor(...args) { super(...(args.length ? args : [BASE_TIME])); }
    static now() { return BASE_TIME; }
  },
  Math, JSON, Array, Object, Number, String, Boolean, RegExp, Set, Map, parseInt, parseFloat, isNaN, isFinite,
  setTimeout: (fn, ms) => { const id = ++timerSeq; timers.push({ id, fn, ms, fired: false }); return id; },
  clearTimeout: (id) => { const t = timers.find(t => t.id === id); if (t) t.cancelled = true; },
  setInterval: () => 0, clearInterval(){},
  document: {
    readyState: 'loading',
    addEventListener(){}, removeEventListener(){},
    getElementById: (id) => elRegistry[id] || null,
    querySelector: (sel) => {
      if (sel === 'meta[name="theme-color"]') return themeColorMeta;
      if (sel === '.example-tag' || sel === '.chip') return null;
      return makeEl('q_' + sel);
    },
    querySelectorAll: () => [],
    createElement: (tag) => makeEl('created_' + tag + '_' + Math.random().toString(36).slice(2,6)),
    documentElement,
    head: headEl,
    body: bodyEl
  },
  localStorage: storage,
  sessionStorage: makeStorage(),
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL(){} },
  FileReader: function(){ this.readAsDataURL = function(){}; this.readAsText = function(){}; },
  Blob: function(){},
  matchMedia: () => ({ matches: false, addEventListener(){} }),
  navigator: { clipboard: { read: () => Promise.resolve([]) } }
};

let src = fs.readFileSync(APP_JS, 'utf8');
src = src.replace(/\/\/ 启动（确保DOM就绪）[\s\S]*$/, '\n// (自启动段已移除用于测试)\n');
const wrapped = '(function(){\n' + src + '\nreturn { NLP: NLP, App: App };\n})()';
const ctx = vm.createContext(sandbox);
let exported;
try { exported = vm.runInContext(wrapped, ctx, { filename: 'app.js' }); }
catch (e) { console.error('❌ app.js 执行报错:', e.message); console.error(e.stack.split('\n').slice(0,6).join('\n')); process.exit(1); }
const { App } = exported;

// 桩掉 App 的非目标 DOM 方法，避免干扰
App.render = function(){}; App.renderList = function(){}; App.renderFiltersWithCount = function(){};
App.renderPreviewImage = function(){}; App.renderEditImage = function(){}; App.updateEditables = function(){};
App.toastWithUndo = function(){}; // 单独测 toast 时不走这个

// ===== 测试框架 =====
let pass = 0, fail = 0; const failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); console.log('  ❌ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)})`); }
function section(name) { console.log('\n── ' + name + ' ──'); }
function reset() {
  storage.clear();
  Object.keys(elRegistry).forEach(k => delete elRegistry[k]);
  documentElement._attrs = {};
  documentElement.classList._set.clear();
  bodyEl._children = [];
  themeColorMeta._attrs = {};
  timers.length = 0; timerSeq = 0;
}

// ============================================================
// 1. 主题切换 toggleTheme / syncThemeIcon / syncThemeColor
// ============================================================
section('主题切换 toggleTheme');
reset();
// 预建主题切换需要的元素
getEl('btnTheme');
documentElement.setAttribute('data-theme', 'light'); // 模拟 FOUC 脚本设的初始值
App.toggleTheme();
eq(documentElement.getAttribute('data-theme'), 'dark', 'toggleTheme 亮→暗');
eq(storage.getItem('zhiban_theme'), 'dark', 'toggleTheme 写入 localStorage');
ok(getEl('btnTheme')._html.includes('<svg'), 'syncThemeIcon 暗色注入 SVG');
ok(getEl('btnTheme')._html.includes('r="4"'), 'syncThemeIcon 暗色为太阳 SVG（含圆 r=4）');
eq(themeColorMeta.getAttribute('content'), '#0d1117', 'syncThemeColor 暗色 meta=#0d1117');
// 再切回亮
App.toggleTheme();
eq(documentElement.getAttribute('data-theme'), 'light', 'toggleTheme 暗→亮');
ok(getEl('btnTheme')._html.includes('21 12.79'), 'syncThemeIcon 亮色为月亮 SVG（含弯月 path）');
eq(themeColorMeta.getAttribute('content'), '#1a1a2e', 'syncThemeColor 亮色 meta=#1a1a2e');
eq(storage.getItem('zhiban_theme'), 'light', 'toggleTheme 写入 localStorage(light)');

// syncThemeIcon 在无 data-theme 时默认 light（月亮）
reset();
getEl('btnTheme');
App.syncThemeIcon();
ok(getEl('btnTheme')._html.includes('21 12.79'), 'syncThemeIcon 无 data-theme 默认月亮 SVG');

// ============================================================
// 2. showExportBanner 结构生成 + 防重复
// ============================================================
section('showExportBanner 结构生成 + 防重复');
reset();
App.showExportBanner('测试消息');
const banners = bodyEl._children.filter(c => c._id === 'exportBanner' || c.getAttribute('id') === 'exportBanner');
// createElement 生成的 banner id 是通过 setAttribute 设的
ok(bodyEl._children.length === 1, 'showExportBanner 后 body 有 1 个子元素');
const banner = bodyEl._children[0];
eq(banner.getAttribute('id'), 'exportBanner', 'banner id=exportBanner');
ok(banner._html.includes('banner-icon'), 'banner innerHTML 含 banner-icon');
ok(banner._html.includes('banner-msg'), 'banner innerHTML 含 banner-msg');
ok(banner._html.includes('banner-export-btn'), 'banner innerHTML 含 banner-export-btn');
ok(banner._html.includes('banner-close-btn'), 'banner innerHTML 含 banner-close-btn');
ok(banner._html.includes('测试消息'), 'banner innerHTML 含传入消息');
ok(banner._html.includes('App.exportJSON()'), 'banner 含导出按钮 onclick');
ok(banner._html.includes('App.dismissExportBanner()'), 'banner 含关闭按钮 onclick');
// 防重复：getElementById('exportBanner') 现在会返回这个 banner（已注册到 elRegistry）
// 但 createElement 生成的 banner 没进 elRegistry，所以 getElementById('exportBanner') 返回 undefined
// 真实浏览器里 getElementById 能找到 appendChild 进 DOM 的元素。为模拟，手动注册：
elRegistry['exportBanner'] = banner;
App.showExportBanner('第二条');
ok(bodyEl._children.length === 1, 'showExportBanner 重复调用不新增（防重复）');

// ============================================================
// 3. toast 退出动画类
// ============================================================
section('toast 退出动画 toast-exit 类');
reset();
// toast 需要 toastContainer 元素
const container = getEl('toastContainer');
// 记录 appendChild 创建的 toast
let createdToast = null;
const origCreate = sandbox.document.createElement;
sandbox.document.createElement = (tag) => { const el = makeEl('toast_created'); if (tag === 'div') createdToast = el; return el; };
// 桩 container.appendChild 捕获
const appended = [];
container.appendChild = (child) => { appended.push(child); child._parent = container; return child; };
App.toast('操作成功', 'success');
ok(appended.length === 1, 'toast 创建并 append 到 container');
ok(createdToast !== null, 'toast 元素已生成');
ok(createdToast.classList.contains('toast') && createdToast.classList.contains('success'), 'toast 元素含 toast success 类');
eq(createdToast._text, '✓ 操作成功', 'toast success 文本含 ✓ 前缀');
// 应注册了一个 setTimeout（用于 2.5s 后加 exit 类）
const toastTimers = timers.filter(t => !t.cancelled);
ok(toastTimers.length >= 1, 'toast 注册了 setTimeout');
// 手动触发该 timer 的回调，验证它给 toast 加 toast-exit 类
toastTimers[0].fn();
ok(createdToast.classList.contains('toast-exit'), 'setTimeout 回调给 toast 加 toast-exit 类（退出动画）');
// error 类型
sandbox.document.createElement = origCreate;
let errToast = null;
sandbox.document.createElement = (tag) => { const el = makeEl('err_toast'); if (tag === 'div') errToast = el; return el; };
App.toast('失败了', 'error');
ok(errToast.classList.contains('error'), 'toast error 含 error 类');
eq(errToast._text, '✗ 失败了', 'toast error 文本含 ✗ 前缀');

// ============================================================
console.log('\n========== 结果 ==========');
console.log(`通过 ${pass} / ${pass+fail} 断言`);
if (fail) {
  console.log(`失败 ${fail} 条:`);
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
} else {
  console.log('🎉 全部通过 — 本次改动的三个方法未被破坏');
}
