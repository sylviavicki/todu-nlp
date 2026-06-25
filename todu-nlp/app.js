/**
 * 智办 — 自然语言待办工具
 * 离线运行 / localStorage持久化 / 自然语言解析 / 超期预警
 * 直接双击 index.html 即可使用，无需服务器
 */

// ===================== 本地存储（localStorage） =====================
const STORAGE_KEY = 'zhiban_tasks';

// SVG 图标（不依赖系统 emoji 字体，国产系统/麒麟等无彩色 emoji 字体时也能正常显示）
const ICON_SUN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
const ICON_MOON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const ICON_SEARCH = '<svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const ICON_DOC = '<svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/></svg>';

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    let maxId = 0;
    for (const t of data) {
      if (t.id) maxId = Math.max(maxId, t.id);
    }
    for (const t of data) {
      if (!t.id) t.id = ++maxId;
    }
    return data;
  } catch (e) {
    console.error('读取本地存储失败', e);
    return [];
  }
}

function saveToStorage(tasks) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

function addTask(task) {
  const tasks = loadFromStorage();
  const maxId = tasks.reduce((m, t) => Math.max(m, t.id || 0), 0);
  task.id = maxId + 1;
  tasks.unshift(task);
  saveToStorage(tasks);
  return task.id;
}

function updateTask(task) {
  const tasks = loadFromStorage();
  const idx = tasks.findIndex(t => t.id === task.id);
  if (idx === -1) throw new Error('任务不存在');
  tasks[idx] = task;
  saveToStorage(tasks);
  return task.id;
}

function deleteTask(id) {
  const tasks = loadFromStorage();
  const filtered = tasks.filter(t => t.id !== id);
  if (filtered.length === tasks.length) throw new Error('任务不存在');
  saveToStorage(filtered);
}

function getAllTasks() {
  return loadFromStorage();
}

function getTask(id) {
  const tasks = loadFromStorage();
  return tasks.find(t => t.id === id) || null;
}

// 导出：下载JSON文件备份
function exportToUserFolder(tasks) {
  const data = JSON.stringify(tasks, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `zhiban-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

// 导入：通过 <input type="file"> 读取JSON文件（兼容 file:// 协议）
function importFromUserFolder(callback) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) { callback(null); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        callback(data);
      } catch (e) {
        callback(null);
      }
    };
    reader.onerror = () => callback(null);
    reader.readAsText(file);
  };
  input.click();
}

// ===================== 自然语言解析引擎 =====================

const NLP = {
  relativeTime: {
    // 过去（负 offset）
    '大前天': -3, '前天': -2, '昨天': -1,
    // 今天及未来
    '今天': 0, '明天': 1, '后天': 2,
    '大后天': 3, '一周后': 7, '两周后': 14,
    '半个月后': 15, '一个月后': 30,
  },

  // 中文数字转整数（支持 一..十 及组合，如 十五、二十、二十三）
  cn2num(str) {
    const map = { '零':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9 };
    if (str === '十') return 10;
    const shi = str.indexOf('十');
    if (shi !== -1) {
      const tens = shi > 0 ? map[str[shi - 1]] : 1;
      const ones = str.slice(shi + 1);
      return tens * 10 + (ones ? map[ones] : 0);
    }
    let n = 0;
    for (const ch of str) n = n * 10 + map[ch];
    return n;
  },

  parse(text) {
    const result = {
      title: '',
      description: '',
      stakeholders: '',
      due: null,
      note: '',
      status: 'todo'
    };

    let remaining = text.trim();

    // 1. 先提取截止时间（含小时），放到最前避免被备注/干系人贪婪匹配吞掉
    const dueResult = this.parseDueDate(remaining);
    if (dueResult.date) {
      result.due = dueResult.date;
      // 剥离日期后的「之前/以前」限定词，避免残留进标题（如「20260701之前完成…」）
      remaining = dueResult.remaining.replace(/之前|以前/g, '').trim();
    }

    // 2. 提取干系人（值在「备注/注意/附注」关键词或句末处终止，避免吞掉后续备注）
    const stakePatterns = [
      /[,，;；]\s*(?:负责人|干系人|分配给|由)\s*[是为：:]\s*([\u4e00-\u9fa5\w\s,，]+?)(?=[,，;；\s]*(?:备注|注意|附注)|$)/,
      /[,，;；]\s*(?:负责人|干系人)\s*([\u4e00-\u9fa5\w\s,，]+?)(?=[,，;；\s]*(?:备注|注意|附注)|$)/,
      /[,，;；]\s*由\s*([\u4e00-\u9fa5\w]+?)\s*(?:负责|跟进|处理)/,
      // 句首匹配（无前置分隔符）
      /^(?:负责人|干系人|分配给|由)\s*[是为：:]\s*([\u4e00-\u9fa5\w\s,，]+?)(?=[,，;；\s]*(?:备注|注意|附注)|$)/,
      /^(?:负责人|干系人)\s*([\u4e00-\u9fa5\w\s,，]+?)(?=[,，;；\s]*(?:备注|注意|附注)|$)/,
      /^由\s*([\u4e00-\u9fa5\w]+?)\s*(?:负责|跟进|处理)/,
      // 「分配给X」无「是/为/：」分隔时，按逗号/句末终止（后接非备注内容亦能正确截断）
      /[,，;；]\s*分配给\s*([一-龥\w·]+?)\s*(?=[,，;；]|$)/,
      /^分配给\s*([一-龥\w·]+?)\s*(?=[,，;；]|$)/,
    ];
    for (const pat of stakePatterns) {
      const m = remaining.match(pat);
      if (m) {
        result.stakeholders = m[1].trim().replace(/[,，\s]+/g, ', ');
        remaining = remaining.replace(m[0], '');
        break;
      }
    }
    // @提及（支持多人，如 @张三 @李四）
    const atMatches = remaining.match(/@([\u4e00-\u9fa5\w]+)/g);
    if (atMatches) {
      const names = atMatches.map(m => m.replace('@', ''));
      if (result.stakeholders) {
        result.stakeholders += ', ' + names.join(', ');
      } else {
        result.stakeholders = names.join(', ');
      }
      remaining = remaining.replace(/@[\u4e00-\u9fa5\w]+/g, '');
    }

    // 3. 提取备注（贪婪匹配到句末，支持含逗号的内容；干系人/截止时间已先行移除）
    const notePatterns = [
      /[,，;；\s]\s*备注[是为：:]\s*(.+)$/,
      /[,，;；\s]\s*注意[是为：:]\s*(.+)$/,
      /[,，;；\s]\s*附注[是为：:]\s*(.+)$/,
      /[,，;；\s]\s*备注\s*(.+)$/,
      /[,，;；\s]\s*注意\s*(.+)$/,
      /[,，;；\s]\s*附注\s*(.+)$/,
      // 句首匹配（无前置分隔符）
      /^备注[是为：:]\s*(.+)$/,
      /^注意[是为：:]\s*(.+)$/,
      /^附注[是为：:]\s*(.+)$/,
      /^备注\s*(.+)$/,
      /^注意\s*(.+)$/,
      /^附注\s*(.+)$/,
    ];
    for (const pat of notePatterns) {
      const m = remaining.match(pat);
      if (m) {
        result.note = m[1].trim();
        remaining = remaining.replace(m[0], '');
        break;
      }
    }

    // 4. 提取状态关键词
    const statusPatterns = [
      { pat: /(?:已经|已)\s*(?:完成|做完|结束|搞定)/, status: 'done' },
      { pat: /(?:正在|进行中|着手|开展)/, status: 'doing' },
      { pat: /(?:待办|未开始|还没|准备|计划|将要)/, status: 'todo' },
    ];
    for (const sp of statusPatterns) {
      if (sp.pat.test(remaining)) {
        result.status = sp.status;
        break;
      }
    }

    // 5. 清理并分离标题和描述
    remaining = remaining.replace(/[,，；]+$/, '').trim();
    const descSplit = remaining.match(/^(.+?)(?:[,，;；]\s*(?:主要|内容|详情|描述)[是为：:]\s*(.+))?$/);
    if (descSplit && descSplit[2]) {
      result.title = descSplit[1].trim();
      result.description = descSplit[2].trim();
    } else {
      if (remaining.length <= 20) {
        result.title = remaining;
      } else {
        const firstBreak = remaining.search(/[,，;。！?？]/);
        if (firstBreak > 5 && firstBreak < 40) {
          result.title = remaining.slice(0, firstBreak).trim();
          result.description = remaining.slice(firstBreak + 1).trim();
        } else {
          // 无标点时尽量在连词/助词处断句，避免生硬切断
          const softBreak = remaining.slice(0, 30).search(/(的|和|与|及|并|等)\s/);
          if (softBreak > 8) {
            result.title = remaining.slice(0, softBreak + 1).trim();
            result.description = remaining.slice(softBreak + 1).trim();
          } else {
            result.title = remaining.slice(0, 20).trim();
            result.description = remaining.slice(20).trim();
          }
        }
      }
    }

    if (!result.description) result.description = '';
    if (!result.note) result.note = '';

    // 未识别到日期时，默认今天 23:59（新任务默认今天截止）
    if (!result.due) {
      const n = new Date();
      result.due = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23, 59, 0).toISOString();
    }

    return result;
  },

  parseDueDate(text) {
    let remaining = text;
    let date = null;
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const todayDate = now.getDate();

    // 匹配时间 HH:MM / H点 / 上午H点 / 下午H点
    // 「点」与可选的「前」一并消费，避免残留进标题（如「下午3点前」整体剔除）
    // 时间匹配：HH:MM / H点M分 / H点MM / 上午H点 / 下午H点M分 等
    // 分组：[1][2] 数字时:分；[3]时段 [4]时 [5]分（时段式支持分钟，并消费「分」字）
    // 「点」「分」「前」一并消费，避免残留进标题
    const timePat = /(\d{1,2})[:点](\d{1,2})?(?:分)?(?:\s*前)?|(上午|下午|早上|中午|晚上|am|pm)\s*(\d{1,2})\s*点?(?:(\d{1,2})分)?\s*(?:前)?/;
    const timeMatch = text.match(timePat);
    let hours = 23;
    let minutes = 59;

    if (timeMatch) {
      // 已识别到具体时间：分钟默认 0（23:59 仅用于「未说时间 → 当天 23:59」的兜底）
      minutes = 0;
      if (timeMatch[1]) {
        hours = parseInt(timeMatch[1]);
        if (timeMatch[2]) minutes = parseInt(timeMatch[2]);
      } else if (timeMatch[4]) {
        let h = parseInt(timeMatch[4]);
        const period = timeMatch[3];
        if (period === '下午' || period === '晚上' || period === 'pm') {
          h = h === 12 ? 0 : h + 12; // 12 小时制：下午/晚上 12 点为 0 点（次日零点），其余 +12
        }
        if ((period === '上午' || period === '早上' || period === 'am') && h === 12) h = 0;
        hours = h;
        if (timeMatch[5]) minutes = parseInt(timeMatch[5]);
      }
      remaining = text.replace(timeMatch[0], '');
    }

    // 模式0: 纯数字日期 20260617 / 0617 / 2026-6-17 / 2026/6/17
    const num8Pat = /(\d{4})(\d{2})(\d{2})/;
    const isoPat = /(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/;
    const shortPat = /(\d{2})(\d{2})/;

    const mIso = remaining.match(isoPat);
    if (mIso) {
      const y = parseInt(mIso[1]);
      const mon = parseInt(mIso[2]) - 1;
      const d = parseInt(mIso[3]);
      date = new Date(y, mon, d, hours, minutes, 0);
      remaining = remaining.replace(mIso[0], '');
      return { date: date.toISOString(), remaining };
    }

    const m8 = remaining.match(num8Pat);
    if (m8 && m8[1] >= '1900' && m8[1] <= '2100') {
      const y = parseInt(m8[1]);
      const mon = parseInt(m8[2]) - 1;
      const d = parseInt(m8[3]);
      if (mon >= 0 && mon <= 11 && d >= 1 && d <= 31) {
        date = new Date(y, mon, d, hours, minutes, 0);
        remaining = remaining.replace(m8[0], '');
        return { date: date.toISOString(), remaining };
      }
    }

    const m4 = remaining.match(shortPat);
    if (m4) {
      const mon = parseInt(m4[1]) - 1;
      const d = parseInt(m4[2]);
      if (mon >= 0 && mon <= 11 && d >= 1 && d <= 31) {
        date = new Date(year, mon, d, hours, minutes, 0);
        remaining = remaining.replace(m4[0], '');
        return { date: date.toISOString(), remaining };
      }
    }

    // 中文日期 "6月20日"
    const datePat = /(\d{4}年)?(\d{1,2})月(\d{1,2})[日号]/;
    const m1 = remaining.match(datePat);
    if (m1) {
      const y = m1[1] ? parseInt(m1[1]) : year;
      const mon = parseInt(m1[2]) - 1;
      const d = parseInt(m1[3]);
      date = new Date(y, mon, d, hours, minutes, 0);
      remaining = remaining.replace(m1[0], '');
      return { date: date.toISOString(), remaining };
    }

    // 相对月份 "本月/下月/上月 X日"（支持过去与未来月份，跨年由 Date 自动归一）
    const relMonthPat = /(本月|这个月|下个月|下月|上个月|上月)\s*(\d{1,2})[日号]/;
    const m1b = remaining.match(relMonthPat);
    if (m1b) {
      const mp = m1b[1];
      const d = parseInt(m1b[2]);
      let m = month;
      if (mp === '下月' || mp === '下个月') m += 1;
      else if (mp === '上月' || mp === '上个月') m -= 1;
      date = new Date(year, m, d, hours, minutes, 0);
      remaining = remaining.replace(m1b[0], '');
      return { date: date.toISOString(), remaining };
    }

    // 星期 "下周三 / 本周三 / 上周三"（「上」=上周同一天，过去日期）
    const weekPat = /(上|下|本|这)?(周|礼拜)([一二三四五六日天])/;
    const m2 = remaining.match(weekPat);
    if (m2) {
      const prefix = m2[1] || '本';
      const dayChar = m2[3];
      const targetDay = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 }[dayChar];
      const today = now.getDay();
      let addDays = targetDay - today;
      if (prefix === '下') addDays += 7;
      else if (prefix === '上') addDays -= 7;
      else if (addDays <= 0) addDays += 7;
      date = new Date(now.getTime() + addDays * 86400000);
      date.setHours(hours, minutes, 0, 0);
      remaining = remaining.replace(m2[0], '');
      return { date: date.toISOString(), remaining };
    }

    // 相对时间 "明天"（按词长降序匹配，避免「大后天」被「后天」抢先命中）
    const relKeys = Object.keys(this.relativeTime).sort((a, b) => b.length - a.length);
    for (const key of relKeys) {
      const offset = this.relativeTime[key];
      if (remaining.includes(key)) {
        date = new Date(now.getTime() + offset * 86400000);
        date.setHours(hours, minutes, 0, 0);
        remaining = remaining.replace(key, '');
        return { date: date.toISOString(), remaining };
      }
    }

    // "X天后"（支持阿拉伯数字与中文数字，如 3天后 / 三天后 / 十五天后）
    const daysPat = /(\d+|[一二三四五六七八九十]+)\s*天后/;
    const m3 = remaining.match(daysPat);
    if (m3) {
      const offset = /^\d+$/.test(m3[1]) ? parseInt(m3[1]) : this.cn2num(m3[1]);
      date = new Date(now.getTime() + offset * 86400000);
      date.setHours(hours, minutes, 0, 0);
      remaining = remaining.replace(m3[0], '');
      return { date: date.toISOString(), remaining };
    }

    // 如果只说了时间没说日期 → 默认今天
    if (timeMatch && !date) {
      date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0);
      return { date: date.toISOString(), remaining };
    }

    // 未识别到日期时返回 null，由上层 parse 兜底为今天 23:59（新任务默认当天截止）
    return { date: null, remaining: text };
  }
};

// ===================== UI 控制器 =====================
const App = {
  tasks: [],
  filter: 'undone',
  editingId: null,
  editingImage: null,
  searchText: '',
  firstRender: true,
  draft: { title: '', description: '', stakeholders: '', due: null, note: '', status: 'todo', image: null },

  init() {
    this.bindEvents();
    this.initTheme();
    this.loadTasks();
    this.render();
    // 恢复从 guide 页面返回前的输入草稿
    const savedDraft = sessionStorage.getItem('zhiban_draft');
    if (savedDraft) {
      const input = document.getElementById('nlInput');
      input.value = savedDraft;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      sessionStorage.removeItem('zhiban_draft');
    }
    this.checkExportReminder();
  },

  // ===== 主题切换：亮色默认不动，新增暗色 + 头部切换钮，偏好持久化到 localStorage =====
  initTheme() {
    this.syncThemeIcon();
    this.syncThemeColor();
    const btn = document.getElementById('btnTheme');
    if (btn) btn.addEventListener('click', () => this.toggleTheme());
  },
  syncThemeIcon() {
    const t = document.documentElement.getAttribute('data-theme') || 'light';
    const btn = document.getElementById('btnTheme');
    if (btn) btn.innerHTML = t === 'dark' ? ICON_SUN : ICON_MOON;
  },
  // 同步浏览器地址栏/状态栏主题色，暗色下与页面头部一致
  syncThemeColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', document.documentElement.getAttribute('data-theme') === 'dark' ? '#0d1117' : '#1a1a2e');
  },
  toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('zhiban_theme', next); } catch (e) {}
    this.syncThemeIcon();
    this.syncThemeColor();
  },

  bindEvents() {
    // 实时解析预览
    document.getElementById('nlInput').addEventListener('input', (e) => {
      this.updatePreview();
    });

    // 可编辑预览字段输入变化
    ['title', 'desc', 'stake', 'due', 'note'].forEach(f => {
      const el = document.getElementById('e_' + f);
      if (el) el.addEventListener('input', () => this.syncDraft());
    });
    document.getElementById('e_status').addEventListener('change', () => this.syncDraft());

    // 创建
    document.getElementById('btnCreate').addEventListener('click', () => this.handleCreate());
    document.getElementById('nlInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleCreate();
      }
    });

    // 粘贴图片到输入框（作为附件，不识别内容）
    document.getElementById('nlInput').addEventListener('paste', (e) => this.handlePaste(e));

    // 任务列表缩略图点击（事件委托，避免把大 data URL 塞进 onclick）
    document.getElementById('taskList').addEventListener('click', (e) => {
      const thumb = e.target.closest('.task-thumb');
      if (thumb) this.openImage(Number(thumb.dataset.id));
    });

    // 示例标签点击填入输入框
    document.querySelectorAll('.example-tag').forEach(tag => {
      tag.addEventListener('click', () => {
        const text = tag.dataset.text;
        const input = document.getElementById('nlInput');
        input.value = text;
        input.focus();
        // 触发输入事件以解析
        input.dispatchEvent(new Event('input', { bubbles: true }));
        // 滚动到输入框
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });

    // 示例标签折叠（超过5个时默认折叠）
    const exampleTags = document.getElementById('exampleTags');
    const expandBtn = document.getElementById('btnExpandExamples');
    const totalTags = exampleTags.querySelectorAll('.example-tag').length;
    if (totalTags > 5) {
      expandBtn.style.display = 'inline-flex';
      exampleTags.classList.add('collapsed');
      expandBtn.addEventListener('click', () => {
        const collapsed = exampleTags.classList.toggle('collapsed');
        expandBtn.textContent = collapsed ? '更多示例 ▼' : '收起示例 ▲';
      });
    }

    // 筛选
    document.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.chip').forEach(c => { c.classList.remove('active'); c.setAttribute('aria-pressed', 'false'); });
        chip.classList.add('active');
        chip.setAttribute('aria-pressed', 'true');
        this.filter = chip.dataset.filter;
        this.renderList();
      });
    });

    // 导出导入
    document.getElementById('btnExport').addEventListener('click', () => this.exportJSON());
    document.getElementById('btnImport').addEventListener('click', () => this.importJSON());
    document.getElementById('btnGuide').addEventListener('click', () => {
      // 保存当前输入草稿以便返回时恢复
      const input = document.getElementById('nlInput');
      if (input.value.trim()) {
        sessionStorage.setItem('zhiban_draft', input.value);
      }
      window.location.href = 'guide.html';
    });

    // 搜索
    document.getElementById('searchInput').addEventListener('input', (e) => {
      this.searchText = e.target.value.trim().toLowerCase();
      this.renderList();
    });

    // Modal
    document.getElementById('modalClose').addEventListener('click', () => this.closeModal());
    document.getElementById('modalCancel').addEventListener('click', () => this.closeModal());
    document.getElementById('modalSave').addEventListener('click', () => this.saveEdit());

    // 编辑弹窗：图片更换/删除按钮由 renderEditImage 动态渲染并绑定，
    // 此处仅绑定静态的隐藏文件输入
    document.getElementById('editImageFile').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      this.compressImage(file).then(dataUrl => {
        this.editingImage = dataUrl;
        this.renderEditImage();
      }).catch(() => this.toast('图片处理失败', 'error'));
      e.target.value = ''; // 允许再次选同一文件
    });

    // 大图浮窗：点遮罩或图片关闭
    document.getElementById('imageModal').addEventListener('click', (e) => {
      this.closeImage();
    });

    // 删除确认弹窗
    document.getElementById('deleteModalClose').addEventListener('click', () => this.cancelDelete());
    document.getElementById('deleteModalCancel').addEventListener('click', () => this.cancelDelete());
    document.getElementById('deleteModalConfirm').addEventListener('click', () => this.confirmDelete());
    document.getElementById('deleteModal').addEventListener('click', (e) => {
      if (e.target.id === 'deleteModal') this.cancelDelete();
    });
    document.getElementById('editModal').addEventListener('click', (e) => {
      if (e.target.id === 'editModal') this.closeModal();
    });

    // 导入确认弹窗
    document.getElementById('importConfirmClose').addEventListener('click', () => this.cancelImport());
    document.getElementById('importConfirmCancel').addEventListener('click', () => this.cancelImport());
    document.getElementById('importConfirmMerge').addEventListener('click', () => this.confirmImportMerge());
    document.getElementById('importConfirmCrossMerge').addEventListener('click', () => this.confirmImportCrossMerge());
    document.getElementById('importConfirmOverwrite').addEventListener('click', () => this.confirmImportOverwrite());
    document.getElementById('importConfirmModal').addEventListener('click', (e) => {
      if (e.target.id === 'importConfirmModal') this.cancelImport();
    });

    // 循环设置弹窗
    document.getElementById('recurrenceModalClose').addEventListener('click', () => this.closeRecurrence());
    document.getElementById('recurrenceModalCancel').addEventListener('click', () => this.closeRecurrence());
    document.getElementById('recurrenceSetDaily').addEventListener('click', () => this.confirmRecurrence('daily'));
    document.getElementById('recurrenceSetWeekly').addEventListener('click', () => this.confirmRecurrence('weekly'));
    document.getElementById('recurrenceSetMonthly').addEventListener('click', () => this.confirmRecurrence('monthly'));
    document.getElementById('recurrenceSetQuarterly').addEventListener('click', () => this.confirmRecurrence('quarterly'));
    document.getElementById('recurrenceModal').addEventListener('click', (e) => {
      if (e.target.id === 'recurrenceModal') this.closeRecurrence();
    });

    // ESC 关闭弹窗
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (document.getElementById('editModal').classList.contains('active')) this.closeModal();
        if (document.getElementById('deleteModal').classList.contains('active')) this.cancelDelete();
        if (document.getElementById('importConfirmModal').classList.contains('active')) this.cancelImport();
        if (document.getElementById('recurrenceModal').classList.contains('active')) this.closeRecurrence();
        if (document.getElementById('imageModal').classList.contains('active')) this.closeImage();
      }
    });
  },

  updatePreview() {
    const text = document.getElementById('nlInput').value.trim();
    const preview = document.getElementById('parsedPreview');
    if (!text && !this.draft.image) {
      preview.classList.remove('active');
      this.draft = { title: '', description: '', stakeholders: '', due: null, note: '', status: 'todo', image: null };
      this.updateEditables();
      return;
    }
    if (text) {
      const parsed = NLP.parse(text);
      // 解析不感知图片，手动保留已粘贴的图片，避免输入文字时丢失
      parsed.image = this.draft.image;
      this.draft = parsed;
    } else {
      // 有图无文：默认标题「图片任务YYYY-MM-DD」，截止时间默认今天 23:59
      const n = new Date();
      this.draft = {
        title: `图片任务${this.todayStr()}`,
        description: '',
        stakeholders: '',
        due: new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23, 59, 0).toISOString(),
        note: '',
        status: 'todo',
        image: this.draft.image
      };
    }
    preview.classList.add('active');
    this.updateEditables();
  },

  updateEditables() {
    document.getElementById('e_title').value = this.draft.title || '';
    document.getElementById('e_desc').value = this.draft.description || '';
    document.getElementById('e_stake').value = this.draft.stakeholders || '';
    document.getElementById('e_due').value = this.draft.due ? this.toDatetimeLocal(this.draft.due) : '';
    document.getElementById('e_note').value = this.draft.note || '';
    document.getElementById('e_status').value = this.draft.status || 'todo';
    this.renderPreviewImage();
  },

  // 渲染预览区的图片行（缩略图 + 移除按钮）
  renderPreviewImage() {
    const wrap = document.getElementById('previewImage');
    if (!wrap) return;
    if (this.draft.image) {
      wrap.style.display = 'flex';
      wrap.innerHTML = `
        <img class="preview-thumb" src="${this.draft.image}" alt="附件">
        <button type="button" class="preview-image-remove" title="移除图片">×</button>
      `;
      wrap.querySelector('.preview-image-remove').addEventListener('click', () => {
        this.draft.image = null;
        this.updatePreview();
      });
    } else {
      wrap.style.display = 'none';
      wrap.innerHTML = '';
    }
  },

  syncDraft() {
    this.draft.title = document.getElementById('e_title').value.trim();
    this.draft.description = document.getElementById('e_desc').value.trim();
    this.draft.stakeholders = document.getElementById('e_stake').value.trim();
    const dueVal = document.getElementById('e_due').value;
    this.draft.due = dueVal ? new Date(dueVal).toISOString() : null;
    this.draft.note = document.getElementById('e_note').value.trim();
    this.draft.status = document.getElementById('e_status').value;
  },

  handleCreate() {
    // 仅粘贴图片、未输入文字时，标题默认为「图片任务YYYY-MM-DD」
    if (!this.draft.title && this.draft.image) {
      this.draft.title = `图片任务${this.todayStr()}`;
    }
    if (!this.draft.title) {
      this.toast('请输入事项名称', 'error');
      return;
    }

    const task = {
      ...this.draft,
      recurrence: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    // 新任务未指定截止时间时，默认今天 23:59
    if (!task.due) {
      const n = new Date();
      task.due = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23, 59, 0).toISOString();
    }

    try {
      const id = addTask(task);
      task.id = id;
      this.tasks.unshift(task);
      // 清空输入
      document.getElementById('nlInput').value = '';
      document.getElementById('parsedPreview').classList.remove('active');
      this.draft = { title: '', description: '', stakeholders: '', due: null, note: '', status: 'todo', image: null };
      this.updateEditables();
      this.render();
      this.toast('待办创建成功');
    } catch (e) {
      // localStorage 配额不足时给出可操作提示
      if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) {
        this.toast('存储空间不足，请删除部分带图待办或导出后清理', 'error');
      } else {
        this.toast('创建失败: ' + e.message, 'error');
      }
    }
  },

  // 粘贴图片处理：仅取图片项，压缩后作为 draft 附件
  handlePaste(e) {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    let imageFile = null;
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        imageFile = it.getAsFile();
        if (imageFile) break;
      }
    }
    if (!imageFile) return; // 非图片粘贴，放行默认文本行为
    e.preventDefault();
    this.compressImage(imageFile).then(dataUrl => {
      this.draft.image = dataUrl;
      this.updatePreview();
    }).catch(() => this.toast('图片处理失败', 'error'));
  },

  // 压缩图片：最长边 ≤ 1280px，JPEG 0.8，控制 localStorage 占用
  compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取失败'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('图片加载失败'));
        img.onload = () => {
          try {
            const MAX = 1280;
            let { width, height } = img;
            if (width > MAX || height > MAX) {
              const scale = MAX / Math.max(width, height);
              width = Math.round(width * scale);
              height = Math.round(height * scale);
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            // 白底，避免透明 PNG 转 JPEG 后变黑
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', 0.8));
          } catch (err) {
            // canvas 失败时回退为原图 data URL
            resolve(reader.result);
          }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  },

  loadTasks() {
    try {
      this.tasks = getAllTasks();
      this.sortTasks();
    } catch (e) {
      this.toast('加载数据失败', 'error');
    }
  },

  sortTasks() {
    this.tasks.sort((a, b) => {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const tomorrowStart = new Date(todayStart.getTime() + 86400000);
      const aDue = a.due ? new Date(a.due) : null;
      const bDue = b.due ? new Date(b.due) : null;
      const aDone = a.status === 'done';
      const bDone = b.status === 'done';

      // 已完成排最后
      if (aDone && !bDone) return 1;
      if (!aDone && bDone) return -1;

      // 未完成的按紧急程度排序
      if (aDone && bDone) {
        // 都已完成，按创建时间倒序
        return new Date(b.createdAt) - new Date(a.createdAt);
      }

      const aOverdue = aDue && aDue < now;
      const bOverdue = bDue && bDue < now;
      const aNear = aDue && !aOverdue && aDue >= todayStart && aDue < tomorrowStart;
      const bNear = bDue && !bOverdue && bDue >= todayStart && bDue < tomorrowStart;

      // 已超期最前
      if (aOverdue && !bOverdue) return -1;
      if (!aOverdue && bOverdue) return 1;
      // 今日到期次之
      if (aNear && !bNear) return -1;
      if (!aNear && bNear) return 1;

      // 同级别按截止时间升序（越早越前）
      if (aDue && bDue) return aDue - bDue;
      if (aDue && !bDue) return -1;
      if (!aDue && bDue) return 1;

      // 都没有日期，按创建时间倒序
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
  },

  render() {
    this.sortTasks();
    this.renderFiltersWithCount();
    this.renderList();
    this.firstRender = false;
  },

  renderFiltersWithCount() {
    const stats = { all: 0, undone: 0, near: 0, todo: 0, doing: 0, done: 0, overdue: 0 };
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrowStart = new Date(todayStart.getTime() + 86400000);
    for (const t of this.tasks) {
      stats.all++;
      if (t.status === 'todo') { stats.todo++; stats.undone++; }
      if (t.status === 'doing') { stats.doing++; stats.undone++; }
      if (t.status === 'done') stats.done++;
      if (t.due && t.status !== 'done' && new Date(t.due) < now) stats.overdue++;
      if (t.due && t.status !== 'done') {
        const dueDate = new Date(t.due);
        if (dueDate >= todayStart && dueDate < tomorrowStart) stats.near++;
      }
    }

    document.querySelectorAll('.chip').forEach(chip => {
      const f = chip.dataset.filter;
      if (!f) return;
      const count = stats[f] || 0;
      // 保留dot，只替换文字和badge
      const dotHtml = chip.querySelector('.dot') ? chip.querySelector('.dot').outerHTML : '';
      const textNode = Array.from(chip.childNodes).find(n => n.nodeType === 3 && n.textContent.trim());
      const text = textNode ? textNode.textContent.trim() : '';
      chip.innerHTML = `${dotHtml}${text} <span class="count-badge">${count}</span>`;
      // 同步筛选开关的选中状态给辅助技术
      chip.setAttribute('aria-pressed', chip.classList.contains('active') ? 'true' : 'false');
    });
  },

  renderList() {
    const list = document.getElementById('taskList');
    if (!list) return;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrowStart = new Date(todayStart.getTime() + 86400000);

    let filtered = this.tasks;
    if (this.filter === 'todo') filtered = this.tasks.filter(t => t.status === 'todo');
    if (this.filter === 'doing') filtered = this.tasks.filter(t => t.status === 'doing');
    if (this.filter === 'done') filtered = this.tasks.filter(t => t.status === 'done');
    if (this.filter === 'overdue') filtered = this.tasks.filter(t => t.due && t.status !== 'done' && new Date(t.due) < now);
    if (this.filter === 'undone') filtered = this.tasks.filter(t => t.status !== 'done');
    if (this.filter === 'near') {
      filtered = this.tasks.filter(t => {
        if (!t.due || t.status === 'done') return false;
        const dueDate = new Date(t.due);
        return dueDate >= todayStart && dueDate < tomorrowStart;
      });
    }

    // 搜索过滤
    if (this.searchText) {
      filtered = filtered.filter(t => {
        const s = this.searchText;
        return (t.title && t.title.toLowerCase().includes(s)) ||
               (t.description && t.description.toLowerCase().includes(s)) ||
               (t.stakeholders && t.stakeholders.toLowerCase().includes(s)) ||
               (t.note && t.note.toLowerCase().includes(s));
      });
    }

    if (filtered.length === 0) {
      const isSearch = !!this.searchText;
      list.innerHTML = `
        <div class="empty-state">
          <div class="icon">${isSearch ? ICON_SEARCH : ICON_DOC}</div>
          <h3>${isSearch ? '未找到匹配的待办' : '暂无待办'}</h3>
          <p>${isSearch ? '试试更换关键词或清除搜索' : '在上方输入自然语言描述，即可快速创建待办'}</p>
        </div>
      `;
      return;
    }

    list.innerHTML = filtered.map((t, idx) => {
      const dueDate = t.due ? new Date(t.due) : null;
      let isOverdue = false;
      let isNear = false;
      if (dueDate && t.status !== 'done') {
        isOverdue = dueDate < now;
        isNear = !isOverdue && dueDate < tomorrowStart; // 今天截止 = 今日到期
      }
      const statusLabels = { todo: '未开始', doing: '进行中', done: '已完成' };
      const statusClasses = { todo: 'status-todo-tag', doing: 'status-doing-tag', done: 'status-done-tag' };
      const recShort = { daily: '次日', weekly: '下周', monthly: '下月', quarterly: '下季度' };
      const recFull = { daily: '每日循环', weekly: '每周循环', monthly: '每月循环', quarterly: '每季度循环' };

      let cardClass = `task-card status-${t.status}`;
      if (this.firstRender) cardClass += ' animate-in';
      if (isOverdue) cardClass += ' overdue-red';
      else if (isNear) cardClass += ' overdue-orange';

      const dueLabel = () => {
        if (!dueDate) return '<span class="meta-tag due no-due">无截止时间</span>';
        let label = this.formatDate(t.due);
        if (isOverdue) label += ' (已超期)';
        else if (isNear) label += ' (今日到期)';
        return `<span class="meta-tag due ${isOverdue ? 'overdue-tag' : isNear ? 'near-tag' : ''}">${label}</span>`;
      };

      const animDelay = Math.min(idx * 0.04, 0.3);

      return `
        <div class="${cardClass}" data-id="${t.id}" style="animation-delay:${animDelay}s" aria-label="${this.escape(t.title)}">
          <div class="task-header">
            <div class="task-title">${this.escape(t.title)}</div>
          </div>
          ${t.description ? `<div class="task-desc">${this.escape(t.description)}</div>` : ''}
          ${t.image ? `<div class="task-thumb-row"><img class="task-thumb" data-id="${t.id}" src="${t.image}" alt="附件图片" title="点击查看大图"></div>` : ''}
          <div class="task-meta">
            <span class="meta-tag ${statusClasses[t.status]}">${statusLabels[t.status]}</span>
            ${t.recurrence ? `<span class="meta-tag recurrence-tag">↻ ${recFull[t.recurrence]}</span>` : ''}
            ${t.stakeholders ? `<span class="meta-tag stakeholder">${this.escape(t.stakeholders)}</span>` : ''}
            ${dueLabel()}
          </div>
          ${t.note ? `<div class="task-note">${this.escape(t.note)}</div>` : ''}
          <div class="task-actions">
            ${t.status !== 'doing' ? `<button class="btn-small" onclick="App.setStatus(${t.id}, 'doing')">设为进行中</button>` : ''}
            ${t.status === 'doing' ? `<button class="btn-small" onclick="App.setStatus(${t.id}, 'todo')">退回未开始</button>` : ''}
            ${(isOverdue || isNear) && t.status !== 'done' ? `<button class="btn-small warn-coral" onclick="App.postponeTask(${t.id})">延期一天</button>` : ''}
            ${t.recurrence && t.status !== 'done'
              ? `<button class="btn-small primary" onclick="App.completeAndNextCycle(${t.id})">完成并${recShort[t.recurrence]}</button>`
              : (t.status !== 'done' ? `<button class="btn-small primary" onclick="App.setStatus(${t.id}, 'done')">完成</button>` : '')
            }
            ${t.status === 'done' ? `<button class="btn-small" onclick="App.setStatus(${t.id}, 'todo')">重启</button>` : ''}
            ${t.status !== 'done' && !t.recurrence ? `<button class="btn-small" onclick="App.openRecurrenceModal(${t.id})">设为循环</button>` : ''}
            ${t.recurrence ? `<button class="btn-small" onclick="App.setRecurrence(${t.id}, null)">取消循环</button>` : ''}
            <button class="btn-small" onclick="App.editTask(${t.id})">编辑</button>
            <button class="btn-small danger" onclick="App.deleteTask(${t.id})">删除</button>
          </div>
        </div>
      `;
    }).join('');
  },

  setStatus(id, status) {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return;
    task.status = status;
    task.updatedAt = new Date().toISOString();
    updateTask(task);
    this.render();
    const labels = { todo: '已重置为未开始', doing: '已开始', done: '已完成' };
    this.toast(labels[status]);
  },

  // 大图浮窗
  openImage(id) {
    const task = this.tasks.find(t => t.id === id);
    if (!task || !task.image) return;
    document.getElementById('imageModalImg').src = task.image;
    document.getElementById('imageModal').classList.add('active');
  },

  closeImage() {
    const modal = document.getElementById('imageModal');
    if (modal) modal.classList.remove('active');
    const img = document.getElementById('imageModalImg');
    if (img) img.src = '';
  },

  postponeTask(id) {
    const task = this.tasks.find(t => t.id === id);
    if (!task || !task.due) return;
    const oldDue = new Date(task.due);
    oldDue.setDate(oldDue.getDate() + 1);
    task.due = oldDue.toISOString();
    task.updatedAt = new Date().toISOString();
    updateTask(task);
    this.render();
    this.toast(`已延期至 ${this.formatDate(task.due)}`);
  },

  // ===== 循环任务 =====
  pendingRecurrenceId: null,

  // 推进截止时间到下一周期（从原截止时间推进；无截止时间则从今天推进）
  advanceDue(dueIso, recurrence) {
    const base = dueIso ? new Date(dueIso) : new Date();
    if (recurrence === 'daily') {
      base.setDate(base.getDate() + 1);
    } else if (recurrence === 'weekly') {
      base.setDate(base.getDate() + 7);
    } else if (recurrence === 'monthly') {
      base.setMonth(base.getMonth() + 1);
    } else if (recurrence === 'quarterly') {
      base.setMonth(base.getMonth() + 3);
    }
    return base.toISOString();
  },

  // 完成本期并跳转到下一周期：截止时间推进、状态重置为未开始（当前任务直接跳转，不新建）
  completeAndNextCycle(id) {
    const task = this.tasks.find(t => t.id === id);
    if (!task || !task.recurrence) return;
    task.due = this.advanceDue(task.due, task.recurrence);
    task.status = 'todo';
    task.updatedAt = new Date().toISOString();
    updateTask(task);
    this.render();
    const shortLabels = { daily: '次日', weekly: '下周', monthly: '下月', quarterly: '下季度' };
    this.toast(`已完成本期，已跳转到${shortLabels[task.recurrence]}（${this.formatDate(task.due)}）`);
  },

  // 打开“设置为循环”弹窗
  openRecurrenceModal(id) {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return;
    this.pendingRecurrenceId = id;
    document.getElementById('recurrenceModalText').textContent = `为「${task.title}」选择循环周期：`;
    document.getElementById('recurrenceModal').classList.add('active');
  },

  closeRecurrence() {
    this.pendingRecurrenceId = null;
    document.getElementById('recurrenceModal').classList.remove('active');
  },

  confirmRecurrence(recurrence) {
    const id = this.pendingRecurrenceId;
    if (id === null) return;
    this.setRecurrence(id, recurrence);
    this.closeRecurrence();
  },

  // 设置或取消循环周期（传 null 即取消循环）
  setRecurrence(id, recurrence) {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return;
    task.recurrence = recurrence || null;
    task.updatedAt = new Date().toISOString();
    updateTask(task);
    this.render();
    const fullLabels = { daily: '每日', weekly: '每周', monthly: '每月', quarterly: '每季度' };
    if (recurrence) {
      this.toast(`已设为${fullLabels[recurrence]}循环`);
    } else {
      this.toast('已取消循环');
    }
  },

  pendingDeleteId: null,
  deletedTask: null,
  deleteTimer: null,

  deleteTask(id) {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return;
    const title = task.title;
    // 使用自定义弹窗，不依赖原生 confirm()
    this.pendingDeleteId = id;
    document.getElementById('deleteModalText').textContent = `确定删除「${title}」？删除后可在 5 秒内撤销。`;
    document.getElementById('deleteModal').classList.add('active');
  },

  confirmDelete() {
    const id = this.pendingDeleteId;
    if (id === null) return;
    const task = this.tasks.find(t => t.id === id);
    if (!task) return;

    // 如果之前有未撤销的删除，先释放其内存留底（已真删，无需再写）
    if (this.deleteTimer) {
      clearTimeout(this.deleteTimer);
      this.deleteTimer = null;
    }
    this.deletedTask = null;

    // 立即从内存与 localStorage 真删，保证刷新不会复活
    this.tasks = this.tasks.filter(t => t.id !== id);
    try {
      deleteTask(id);
    } catch (e) {
      // localStorage 已无此任务，忽略
    }
    // 内存留底，用于 5 秒内撤销
    this.deletedTask = task;
    this.pendingDeleteId = null;
    document.getElementById('deleteModal').classList.remove('active');
    this.render();

    // 显示带撤销按钮的 toast
    this.toastWithUndo(`已删除「${this.escape(task.title)}」`, () => this.undoDelete());

    // 5 秒后清空内存留底（此时已无法撤销）
    this.deleteTimer = setTimeout(() => {
      this.deletedTask = null;
      this.deleteTimer = null;
    }, 5000);
  },

  undoDelete() {
    if (!this.deletedTask) return;
    if (this.deleteTimer) {
      clearTimeout(this.deleteTimer);
      this.deleteTimer = null;
    }
    const task = this.deletedTask;
    this.deletedTask = null;
    // 从内存与 localStorage 恢复
    this.tasks.unshift(task);
    const all = loadFromStorage();
    // 避免重复 id（理论上不会，但防御性处理）
    if (!all.find(t => t.id === task.id)) all.unshift(task);
    saveToStorage(all);
    this.render();
    this.toast('已撤销删除');
  },

  cancelDelete() {
    this.pendingDeleteId = null;
    document.getElementById('deleteModal').classList.remove('active');
  },

  editTask(id) {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return;
    this.editingId = id;
    this.editingImage = task.image || null;
    document.getElementById('editTitle').value = task.title || '';
    document.getElementById('editDesc').value = task.description || '';
    document.getElementById('editStakeholder').value = task.stakeholders || '';
    document.getElementById('editDue').value = task.due ? this.toDatetimeLocal(task.due) : '';
    document.getElementById('editStatus').value = task.status || 'todo';
    document.getElementById('editNote').value = task.note || '';
    this.renderEditImage();
    document.getElementById('editModal').classList.add('active');
    // 打开后聚焦标题，方便键盘直接编辑
    const titleInput = document.getElementById('editTitle');
    if (titleInput) setTimeout(() => titleInput.focus(), 50);
  },

  // 渲染编辑弹窗的图片行
  renderEditImage() {
    const wrap = document.getElementById('editImageRow');
    if (!wrap) return;
    if (this.editingImage) {
      wrap.style.display = 'flex';
      wrap.innerHTML = `
        <img class="edit-thumb" src="${this.editingImage}" alt="附件">
        <div class="edit-image-actions">
          <button type="button" class="btn-small" id="editImageReplace">更换图片</button>
          <button type="button" class="btn-small danger" id="editImageRemove">删除图片</button>
        </div>
      `;
      document.getElementById('editImageReplace').addEventListener('click', () => {
        document.getElementById('editImageFile').click();
      });
      document.getElementById('editImageRemove').addEventListener('click', () => {
        this.editingImage = null;
        this.renderEditImage();
      });
    } else {
      wrap.style.display = 'flex';
      wrap.innerHTML = `
        <div class="edit-image-empty">无图片</div>
        <div class="edit-image-actions">
          <button type="button" class="btn-small" id="editImageReplace">添加图片</button>
        </div>
      `;
      document.getElementById('editImageReplace').addEventListener('click', () => {
        document.getElementById('editImageFile').click();
      });
    }
  },

  closeModal() {
    document.getElementById('editModal').classList.remove('active');
    this.editingId = null;
    this.editingImage = null;
  },

  saveEdit() {
    if (!this.editingId) return;
    const task = this.tasks.find(t => t.id === this.editingId);
    if (!task) return;

    task.title = document.getElementById('editTitle').value.trim();
    task.description = document.getElementById('editDesc').value.trim();
    task.stakeholders = document.getElementById('editStakeholder').value.trim();
    const dueVal = document.getElementById('editDue').value;
    task.due = dueVal ? new Date(dueVal).toISOString() : null;
    task.status = document.getElementById('editStatus').value;
    task.note = document.getElementById('editNote').value.trim();
    task.image = this.editingImage || null;
    task.updatedAt = new Date().toISOString();

    if (!task.title) {
      this.toast('事项名称不能为空', 'error');
      return;
    }

    try {
      updateTask(task);
    } catch (e) {
      if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) {
        this.toast('存储空间不足，请删除部分带图待办或导出后清理', 'error');
      } else {
        this.toast('保存失败: ' + e.message, 'error');
      }
      return;
    }
    this.render();
    this.closeModal();
    this.toast('保存成功');
  },

  exportJSON() {
    exportToUserFolder(this.tasks);
    localStorage.setItem('zhiban_last_export', new Date().toISOString());
    this.markExportDismissedToday();
    // 导出后移除可能存在的提醒横幅
    const banner = document.getElementById('exportBanner');
    if (banner) banner.remove();
    this.toast('导出成功，已记录备份时间');
  },

  // 标记今日已处理备份提醒（导出或主动关闭），当天不再弹
  markExportDismissedToday() {
    const today = new Date().toISOString().slice(0, 10);
    localStorage.setItem('zhiban_export_dismissed', today);
  },

  isExportDismissedToday() {
    return localStorage.getItem('zhiban_export_dismissed') === new Date().toISOString().slice(0, 10);
  },

  importJSON() {
    // 使用自定义确认弹窗
    this.showImportConfirm();
  },

  showImportConfirm() {
    document.getElementById('importConfirmModal').classList.add('active');
  },

  cancelImport() {
    document.getElementById('importConfirmModal').classList.remove('active');
  },

  // 清洗并校验导入数据：只保留有标题的对象，规范字段类型，非法 due 置空
  // 保留合法的原 id（正整数），用于合并导入时按 id 去重；非法/无 id 置 null 待分配
  sanitizeImport(data) {
    if (!Array.isArray(data)) return [];
    const validStatus = ['todo', 'doing', 'done'];
    const cleaned = [];
    for (const t of data) {
      if (!t || typeof t !== 'object') continue;
      const title = typeof t.title === 'string' ? t.title.trim() : '';
      if (!title) continue; // 无标题视为无效，跳过
      let due = null;
      if (t.due) {
        const d = new Date(t.due);
        due = isNaN(d.getTime()) ? null : d.toISOString();
      }
      const id = Number.isInteger(t.id) && t.id > 0 ? t.id : null;
      // 仅保留合法的图片 data URL，避免导入伪造内容
      const image = (typeof t.image === 'string' && t.image.startsWith('data:image/')) ? t.image : null;
      cleaned.push({
        id,
        title,
        description: typeof t.description === 'string' ? t.description : '',
        stakeholders: typeof t.stakeholders === 'string' ? t.stakeholders : '',
        due,
        note: typeof t.note === 'string' ? t.note : '',
        status: validStatus.includes(t.status) ? t.status : 'todo',
        recurrence: ['daily', 'weekly', 'monthly', 'quarterly'].includes(t.recurrence) ? t.recurrence : null,
        image,
        createdAt: t.createdAt || new Date().toISOString(),
        updatedAt: t.updatedAt || new Date().toISOString()
      });
    }
    return cleaned;
  },

  // 内容指纹：标题+截止时间+干系人，用于跨设备合并去重与本设备合并的内容兜底去重。
  // due 统一转 ISO 再比较，避免 '2026-06-18' 与 ISO 字符串不一致导致漏去重
  contentFingerprint(t) {
    let due = t.due || '';
    if (due) { const d = new Date(due); due = isNaN(d.getTime()) ? '' : d.toISOString(); }
    return `${t.title}||${due}||${t.stakeholders || ''}`;
  },

  // 公共：读文件 → 校验 → 清洗。onCleaned(cleaned, invalidSkipped) 处理实际导入逻辑；
  // 返回 false 表示中途出错/取消，onCleaned 不再执行。
  readImportFile(onCleaned) {
    document.getElementById('importConfirmModal').classList.remove('active');
    importFromUserFolder((data) => {
      if (!data) {
        this.toast('导入已取消或文件无效', 'error');
        return;
      }
      if (!Array.isArray(data)) {
        this.toast('导入失败: 格式错误', 'error');
        return;
      }
      try {
        const cleaned = this.sanitizeImport(data);
        if (cleaned.length === 0) {
          this.toast('导入失败: 文件中没有有效待办', 'error');
          return;
        }
        const invalidSkipped = data.length - cleaned.length;
        onCleaned(cleaned, invalidSkipped);
      } catch (err) {
        this.toast('导入失败: ' + err.message, 'error');
      }
    });
  },

  // 统一的完成提示
  finishImport(imported, invalidSkipped, dupSkipped) {
    this.loadTasks();
    this.render();
    const parts = [];
    if (invalidSkipped > 0) parts.push(`跳过 ${invalidSkipped} 条无效数据`);
    if (dupSkipped > 0) parts.push(`跳过 ${dupSkipped} 条重复`);
    const note = parts.length ? `（${parts.join('、')}）` : '';
    this.toast(`已导入 ${imported} 条待办` + note);
  },

  confirmImportOverwrite() {
    this.readImportFile((cleaned, invalidSkipped) => {
      // 覆盖导入：清空现有数据，用清洗后的内容替换并重排 ID
      let nextId = 0;
      cleaned.forEach(t => { t.id = ++nextId; });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
      this.finishImport(cleaned.length, invalidSkipped, 0);
    });
  },

  confirmImportMerge() {
    this.readImportFile((cleaned, invalidSkipped) => {
      // 本设备合并：按 id 去重；对 id 不冲突的项再按内容指纹兜底去重。
      // 防止覆盖导入/重建打乱 id 体系后，内容相同的已完成任务被当作新任务重复插入
      const existing = loadFromStorage();
      const existingIds = new Set(existing.map(t => t.id));
      const existingFps = new Set(existing.map(t => this.contentFingerprint(t)));
      const batchIds = new Set();
      const batchFps = new Set();
      const toInsert = [];
      let dupSkipped = 0;
      for (const t of cleaned) {
        // 1. id 去重：与现有 id 冲突、或本批已出现相同 id 的，视为重复跳过
        if (t.id != null && (existingIds.has(t.id) || batchIds.has(t.id))) {
          dupSkipped++; continue;
        }
        // 2. 内容兜底去重：标题+截止时间+干系人 完全一致则视为同一条，跳过
        const fp = this.contentFingerprint(t);
        if (existingFps.has(fp) || batchFps.has(fp)) { dupSkipped++; continue; }
        // 3. 通过两层去重，纳入待插入（无 id 项待后续分配）
        if (t.id != null) batchIds.add(t.id);
        batchFps.add(fp);
        toInsert.push(t);
      }
      // 为无 id 项分配不冲突的新 id（基于现有 id 与本批已用 id 的最大值之上递增）
      let maxId = existing.reduce((m, t) => Math.max(m, t.id || 0), 0);
      for (const t of toInsert) if (t.id != null) maxId = Math.max(maxId, t.id);
      for (const t of toInsert) {
        if (t.id == null) {
          do { maxId++; } while (existingIds.has(maxId) || batchIds.has(maxId));
          t.id = maxId;
          batchIds.add(maxId);
        }
      }
      saveToStorage([...toInsert, ...existing]);
      this.finishImport(toInsert.length, invalidSkipped, dupSkipped);
    });
  },

  confirmImportCrossMerge() {
    this.readImportFile((cleaned, invalidSkipped) => {
      // 跨设备合并：按内容指纹（标题+截止时间+干系人）去重，
      // 导入项全部重新分配连续新 id，避免不同设备的 id 体系冲突
      const existing = loadFromStorage();
      const existingFps = new Set(existing.map(t => this.contentFingerprint(t)));
      const batchFps = new Set();
      const toInsert = [];
      let dupSkipped = 0;
      for (const t of cleaned) {
        const k = this.contentFingerprint(t);
        if (existingFps.has(k) || batchFps.has(k)) { dupSkipped++; continue; }
        batchFps.add(k);
        toInsert.push(t);
      }
      // 全部重新分配连续新 id
      let maxId = existing.reduce((m, t) => Math.max(m, t.id || 0), 0);
      toInsert.forEach(t => { t.id = ++maxId; });
      saveToStorage([...toInsert, ...existing]);
      this.finishImport(toInsert.length, invalidSkipped, dupSkipped);
    });
  },

  checkExportReminder() {
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

    const buildMsg = (lastExport, refNow) => {
      const days = lastExport ? Math.floor((refNow - new Date(lastExport).getTime()) / (24*60*60*1000)) : null;
      return days
        ? `已 ${days} 天未导出备份，建议点击 ⬆ 导出数据以防丢失`
        : `您还未导过备份，建议点击 ⬆ 导出数据以防丢失`;
    };

    const shouldRemind = () => {
      if (this.isExportDismissedToday()) return false; // 今日已处理（导出或关闭），不再弹
      const last = localStorage.getItem('zhiban_last_export');
      const n = Date.now();
      return !last || (n - new Date(last).getTime()) > SEVEN_DAYS;
    };

    if (shouldRemind()) {
      // 延迟2秒显示，避免与页面加载冲突
      setTimeout(() => {
        if (shouldRemind()) {
          this.showExportBanner(buildMsg(localStorage.getItem('zhiban_last_export'), Date.now()));
        }
      }, 2000);
    }

    // 每30分钟检查一次（今日已关闭/导出过则当天不再弹）
    setInterval(() => {
      if (shouldRemind()) {
        this.showExportBanner(buildMsg(localStorage.getItem('zhiban_last_export'), Date.now()));
      }
    }, 30 * 60 * 1000);
  },

  showExportBanner(msg) {
    // 避免重复显示；样式统一由 CSS #exportBanner 管理，响应主题
    if (document.getElementById('exportBanner')) return;
    const banner = document.createElement('div');
    banner.id = 'exportBanner';
    banner.setAttribute('role', 'alert');
    banner.setAttribute('aria-label', '数据备份提醒');
    banner.innerHTML = `
      <span class="banner-icon" aria-hidden="true">!</span>
      <span class="banner-msg">${msg}</span>
      <button class="banner-export-btn" onclick="App.exportJSON()">立即导出备份</button>
      <button class="banner-close-btn" aria-label="关闭提醒" onclick="App.dismissExportBanner()">×</button>
    `;
    document.body.appendChild(banner);
    // 20秒后自动消失（仅移除，不标记已处理）
    setTimeout(() => { if (banner.parentElement) banner.remove(); }, 20000);
  },

  // 关闭备份提醒横幅并标记今日已处理，当天不再弹
  dismissExportBanner() {
    const banner = document.getElementById('exportBanner');
    if (banner) banner.remove();
    this.markExportDismissedToday();
  },

  toast(msg, type = 'success') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? '✓ ' : '✗ ';
    toast.textContent = icon + msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-exit');
      const rm = () => toast.remove();
      toast.addEventListener('transitionend', rm, { once: true });
      setTimeout(rm, 250); // 兜底：transitionend 未触发也强制移除
    }, 2500);
  },

  toastWithUndo(msg, onUndo) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast success toast-undo';
    toast.innerHTML = `
      <span>✓ ${msg}</span>
      <button class="toast-undo-btn" type="button">撤销</button>
    `;
    container.appendChild(toast);

    let undone = false;
    const undoBtn = toast.querySelector('.toast-undo-btn');
    const finish = () => {
      toast.classList.add('toast-exit');
      const rm = () => toast.remove();
      toast.addEventListener('transitionend', rm, { once: true });
      setTimeout(rm, 250); // 兜底
    };
    const timer = setTimeout(() => { if (!undone) finish(); }, 5000);

    undoBtn.addEventListener('click', () => {
      undone = true;
      clearTimeout(timer);
      finish();
      onUndo();
    });
  },

  formatDate(iso) {
    const d = new Date(iso);
    const now = new Date();
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const isToday = d.toDateString() === now.toDateString();
    const isTomorrow = new Date(now.getTime() + 86400000).toDateString() === d.toDateString();
    const sameYear = y === now.getFullYear();
    const dateStr = sameYear ? `${m}月${day}日` : `${y}年${m}月${day}日`;
    const prefix = isToday ? '今天 ' : isTomorrow ? '明天 ' : `${dateStr} `;
    return prefix + `${hh}:${mm}`;
  },

  toDatetimeLocal(iso) {
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  // 当日日期 YYYY-MM-DD，用于图片任务默认标题
  todayStr() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },

  escape(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
};

// 启动（确保DOM就绪）
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.init());
} else {
  App.init();
}
