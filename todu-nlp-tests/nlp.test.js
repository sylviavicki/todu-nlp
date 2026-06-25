/**
 * 智办 NLP 回归测试（最终合并版）
 *
 * 合并来源：
 *   - 用例集（sections A–H，共 67 条）：取自 codex 版 nlp.test.js（覆盖最全）
 *   - 加载方式：取自 claudecode 版的 vm 上下文 + 固定 Date 桩（确定性，不随「今天」漂移）
 *
 * 为什么用固定 Date：codex 版用真实 new Date()，相对日期断言（上周X/下周X/本周X/0628/20260701 等）
 * 会随运行日期漂移、隔天就坏。这里把 Date 桩固定到 BASE_TIME=2026-06-23（周二），
 * 该日期正是 codex 用例期望值所对应的「今天」，故期望值原样成立且永不再漂。
 *
 * 运行：node nlp.test.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const APP_JS = path.join(__dirname, '..', 'todu-nlp', 'app.js');
const BASE_TIME = new Date('2026-06-23T10:00:00').getTime(); // 2026-06-23 周二 10:00（本地时区）

// ===== 浏览器全局桩（固定 Date，让相对时间可断言） =====
const storage = {
  _d: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; }
};
const fakeEl = () => ({
  style: {}, value: '', textContent: '', innerHTML: '', classList: { add(){}, remove(){}, toggle(){return false;}, contains(){return false;} },
  addEventListener(){}, removeEventListener(){}, appendChild(){}, querySelector(){return null;}, querySelectorAll(){return []; },
  setAttribute(){}, getAttribute(){return null;}, click(){}, focus(){}, dispatchEvent(){}, closest(){return null;},
  dataset: {}, childNodes: [], outerHTML: '', offsetWidth: 0
});
const sandbox = {
  console,
  Date: class extends Date {
    constructor(...args) { super(...(args.length ? args : [BASE_TIME])); }
    static now() { return BASE_TIME; }
  },
  Math, JSON, Array, Object, Number, String, Boolean, RegExp, Set, Map, parseInt, parseFloat, isNaN, isFinite,
  setTimeout: () => 0, clearTimeout(){}, setInterval: () => 0, clearInterval(){},
  document: {
    readyState: 'loading',
    addEventListener(){}, removeEventListener(){},
    getElementById: () => fakeEl(),
    querySelector: () => fakeEl(),
    querySelectorAll: () => [],
    createElement: () => fakeEl(),
    documentElement: { setAttribute(){}, getAttribute(){return null;}, classList: {add(){},remove(){},toggle(){},contains(){return false;}} },
    head: { appendChild(){} }, body: { appendChild(){} }
  },
  localStorage: storage,
  sessionStorage: storage,
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL(){} },
  FileReader: function(){ this.readAsDataURL = function(){}; this.readAsText = function(){}; },
  Blob: function(){},
  matchMedia: () => ({ matches: false, addEventListener(){} }),
  navigator: { clipboard: { read: () => Promise.resolve([]) } }
};

// 读取 app.js 并去掉末尾自启动段（避免触发 App.init() 访问真实 DOM）
let src = fs.readFileSync(APP_JS, 'utf8');
src = src.replace(/\/\/ 启动（确保DOM就绪）[\s\S]*$/, '\n// (自启动段已移除用于测试)\n');

// vm 上下文里 const 声明不挂到 context 对象，包一层显式暴露 NLP
const wrapped = '(function(){\n' + src + '\nreturn { NLP: NLP, App: App };\n})()';

const ctx = vm.createContext(sandbox);
let exported;
try {
  exported = vm.runInContext(wrapped, ctx, { filename: 'app.js' });
} catch (e) {
  console.error('❌ app.js 执行报错:', e.message);
  console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}
const NLP = exported.NLP;
if (!NLP || typeof NLP.parse !== 'function') {
  console.error('❌ 未能导出 NLP —— app.js 加载失败');
  process.exit(1);
}

// ===== 断言辅助（now 固定为 BASE_TIME，与 NLP 内部 Date 桩一致） =====
const now = new Date(BASE_TIME);
function diffDays(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - b) / 86400000);
}
function hm(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function md(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return (d.getMonth() + 1) + '-' + d.getDate();
}
let pass = 0, fail = 0, fails = [];
function assert(input, exp, section) {
  const p = NLP.parse(input);
  let ok = true; const why = [];
  if ('t' in exp && p.title !== exp.t) { ok = false; why.push('标题=' + JSON.stringify(p.title) + '(期望' + JSON.stringify(exp.t) + ')'); }
  if ('d' in exp && diffDays(p.due) !== exp.d) { ok = false; why.push('距今=' + diffDays(p.due) + '(期望' + exp.d + ')'); }
  if ('hm' in exp && hm(p.due) !== exp.hm) { ok = false; why.push('时分=' + hm(p.due) + '(期望' + exp.hm + ')'); }
  if ('md' in exp && md(p.due) !== exp.md) { ok = false; why.push('月日=' + md(p.due) + '(期望' + exp.md + ')'); }
  if ('stake' in exp && p.stakeholders !== exp.stake) { ok = false; why.push('干系人=' + JSON.stringify(p.stakeholders)); }
  if ('note' in exp && p.note !== exp.note) { ok = false; why.push('备注=' + JSON.stringify(p.note)); }
  if ('status' in exp && p.status !== exp.status) { ok = false; why.push('状态=' + p.status); }
  if ('desc' in exp && p.description !== exp.desc) { ok = false; why.push('描述=' + JSON.stringify(p.description)); }
  if (ok) pass++; else { fail++; fails.push('[' + section + '] ' + input + ' -> ' + why.join('; ')); }
  return ok;
}

const sections = [
  ['A. 主流程：日期/时间/干系人/备注/状态/标题分离', [
    ['明天下午3点前提交季度报告', { t: '提交季度报告', d: 1, hm: '15:00' }],
    ['6月20日完成项目验收，负责人：张三，备注：需带齐材料', { stake: '张三', note: '需带齐材料' }],
    ['20260701之前完成系统升级', { d: 8, t: '完成系统升级' }],
    ['下周三上午10点和客户开会', { hm: '10:00', t: '和客户开会' }],
    ['由李四负责跟进合同签署，备注：本周内必须完成', { stake: '李四', note: '本周内必须完成' }],
    ['已完成上周的设计稿评审', { status: 'done' }],
    ['正在处理服务器迁移，干系人 王五', { status: 'doing', stake: '王五' }],
    ['@张三 @李四 一起准备明天的演示材料', { stake: '张三, 李四', d: 1 }],
    ['写一份关于新功能的详细文档，内容：包含架构图和使用说明', { desc: '包含架构图和使用说明' }],
    ['今天18点下班前提交日报', { hm: '18:00' }],
    ['0628 准备季度汇报', { d: 5 }],
    ['下周一早上9点站会', { hm: '09:00' }],
    ['两周后交付第一版原型', { d: 14 }],
    ['明天 9:30 团队晨会，注意：提前5分钟进会议室', { d: 1, hm: '09:30', note: '提前5分钟进会议室' }],
    ['买个咖啡', { d: 0, hm: '23:59' }],
    ['2026/12/31 23:59 年终总结', { hm: '23:59' }],
  ]],
  ['B. 中文数字「X天后」', [
    ['3天后交报告', { d: 3, t: '交报告' }],
    ['三天后交报告', { d: 3, t: '交报告' }],
    ['五天后交报告', { d: 5, t: '交报告' }],
    ['十天后交报告', { d: 10, t: '交报告' }],
    ['十五天后交报告', { d: 15, t: '交报告' }],
    ['二十天后交报告', { d: 20, t: '交报告' }],
    ['二十三天后交报告', { d: 23, t: '交报告' }],
  ]],
  ['C. 大后天/后天 长串优先', [
    ['大后天交差', { d: 3, t: '交差' }],
    ['后天交差', { d: 2, t: '交差' }],
    ['大后天下午5点开会', { d: 3, hm: '17:00' }],
  ]],
  ['D. 过去日期：昨天/前天/大前天', [
    ['昨天提交日报', { d: -1, t: '提交日报' }],
    ['前天开会', { d: -2, t: '开会' }],
    ['大前天对账', { d: -3, t: '对账' }],
    ['昨天下午3点交报告', { d: -1, hm: '15:00' }],
    ['大前天上午10点对账', { d: -3, hm: '10:00' }],
  ]],
  ['E. 上周X（过去日期）', [
    ['上周五开会', { d: -4, t: '开会' }],
    ['上周一交报告', { d: -8, t: '交报告' }],
    ['上周日复盘', { d: -9, t: '复盘' }],
    ['上周三下午3点开会', { d: -6, hm: '15:00' }],
    ['上周五下午2点复盘', { d: -4, hm: '14:00' }],
  ]],
  ['F. 相对月份 本月/下月/上月 X日', [
    ['本月30日发版', { md: '6-30', t: '发版' }],
    ['下月5日上线', { md: '7-5', t: '上线' }],
    ['上月20日对账', { md: '5-20', t: '对账' }],
    ['这个月15日发工资', { md: '6-15', t: '发工资' }],
    ['下个月1日启动', { md: '7-1', t: '启动' }],
    ['上月20号对账', { md: '5-20', t: '对账' }],
    ['下月5号上线', { md: '7-5', t: '上线' }],
  ]],
  ['G. 边界与不误伤', [
    ['下周五开会', { d: 10, t: '开会' }],
    ['本周五开会', { d: 3, t: '开会' }],
    ['上周的复盘会议', { t: '上周的复盘会议' }],
    ['6月20日开会', { md: '6-20', t: '开会' }],
    ['一周后交报告', { d: 7, t: '交报告' }],
    ['一周后', { d: 7, t: '' }],
    ['三天后下午3点交报告', { d: 3, hm: '15:00', t: '交报告' }],
    ['前天之前完成对账', { d: -2, t: '完成对账' }],
    ['昨天以前提交日报', { d: -1, t: '提交日报' }],
    ['本月发版', { d: 0, t: '本月发版' }],
  ]],
  // 本轮修复：时间分钟「分」字残留 / 时段式分钟 / 这周X / 12点转换
  ['H. 时间分钟与12点转换（本轮修复）', [
    ['12点30分开会', { t: '开会', hm: '12:30' }],
    ['3点15分开会', { t: '开会', hm: '03:15' }],
    ['9点5分开会', { t: '开会', hm: '09:05' }],
    ['9点05分开会', { t: '开会', hm: '09:05' }],
    ['下午3点15分开会', { t: '开会', hm: '15:15' }],
    ['下午3点5分开会', { t: '开会', hm: '15:05' }],
    ['上午9点30分开会', { t: '开会', hm: '09:30' }],
    ['这周三开会', { t: '开会' }],
    ['这周五开会', { t: '开会' }],
    ['下午12点开会', { hm: '00:00' }],
    ['晚上12点开会', { hm: '00:00' }],
    ['中午12点开会', { hm: '12:00' }],
    ['上午12点开会', { hm: '00:00' }],
    ['下午3点开会', { hm: '15:00' }],
  ]],
];

console.log('智办 NLP 回归测试（合并版 · 固定 BASE_TIME=2026-06-23 周二）');
console.log('参考时间(本地): ' + now.toLocaleString('zh-CN') + '  星期' + '日一二三四五六'[now.getDay()]);
console.log('(注：距今天数相对固定基准日 2026-06-23 计算；不会随运行日期漂移)');
console.log('='.repeat(64));
for (const [title, cases] of sections) {
  console.log('\n【' + title + '】');
  for (const [input, exp] of cases) {
    console.log('  ' + (assert(input, exp, title) ? 'PASS' : 'FAIL') + '  ' + input);
  }
}
console.log('\n' + '='.repeat(64));
console.log('合计: PASS ' + pass + ' / FAIL ' + fail);
if (fail) {
  console.log('\n失败明细:');
  for (const f of fails) console.log('  ' + f);
  process.exit(1);
} else {
  console.log('全部通过 ✅');
}
