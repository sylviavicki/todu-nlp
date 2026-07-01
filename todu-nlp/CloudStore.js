/**
 * CloudStore —— 联网模式数据存储实现（本地优先 + 定时后台同步）
 *
 * 通过 GitHub Contents API 把全部任务读写到仓库里的一个 JSON 文件（如 todu-nlp/tasks.json）。
 *
 * 【本地优先】所有读写都先落 localStorage（zhiban_cloud_cache）秒回，UI 零等待；
 * 网络同步放后台：写入后防抖 ~4s 自动 push、20s 定时拉取远端、切到后台/关闭前 flush。
 * 即便同步从未成功，重开页面也能从 localStorage 恢复并补传——不丢数据。
 *
 * 【合并】单次 _sync() 同时 pull+push：GET 远端最新 → 与本地按 id+updatedAt 轻量合并
 * （含删除墓碑防「换设备时被删任务复活」）→ 若有改动则 PUT 合并结果（带最新 sha，含 409 重试）。
 *
 * 访问凭证 = GitHub fine-grained PAT（仅给目标仓库 Contents 读写权限）。
 * token 优先级：嵌入 token（cloud-config.js，跨端免输入）→ localStorage（同设备持久）→ 首次同步弹框输入。
 * 注意：嵌入 token 会随公开站点发布，仅数据不敏感时使用；GitHub push protection 会拦截含 PAT 的提交。
 *
 * 仅在部署版（index.html 引入了 cloud-config.js，设置了 window.CLOUD_CONFIG）时启用；
 * 本地 file:// 直开 index.html 不会加载本文件，走 LocalStore，行为与原版一致。
 */
class CloudStore {
  constructor(config) {
    this.owner = config.owner;
    this.repo = config.repo;
    this.path = config.path;
    this.branch = config.branch || 'main';
    this.apiBase = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${encodeURIComponent(this.path).replace(/%2F/g, '/')}`;
    // 本地缓存（工作副本）：{ tasks:[], sha, lastSyncedAt, tombstones:[{id,at}] }
    this._cache = null;
    this._localKey = 'zhiban_cloud_cache';
    this._tokenKey = 'zhiban_gh_token';       // token 存 localStorage（同设备持久；跨端靠 embeddedToken）
    this._embeddedToken = config.token || '';  // 嵌入站点的 PAT（跨端免输入）；401/403 后置 invalid 改走弹框
    this._embeddedValid = !!this._embeddedToken;
    // GET 缓存破坏计数器：GitHub Contents API 的 GET 响应带 max-age≈60s 缓存头，
    // 同一浏览器短时间内会读到旧 sha，导致 PUT 因 sha 不匹配而 409。每次 GET 追加递增参数强制走源站。
    this._bust = 0;
    // 同步状态
    this._dirty = false;       // 本地有未 push 的改动
    this._syncing = false;     // 一次 _sync 进行中
    this._syncTimer = null;    // 写入后防抖 push 的 setTimeout
    this._pullTimer = null;    // 20s 定时拉取的 setInterval
    this._status = 'idle';     // idle|pending|syncing|synced|error|nologin
    this._dot = null;          // 状态徽标 DOM
    this._btn = null;          // 「立即同步」按钮 DOM
    // 远端拉取到本地没有的新任务时回调（供 App 刷新列表），可选
    this.onSyncUpdate = null;
  }

  // ===== 本地缓存层 =====
  _ensureLoaded() {
    if (this._cache) return;
    this._cache = this._loadLocal();
  }

  _loadLocal() {
    try {
      const raw = localStorage.getItem(this._localKey);
      if (raw) {
        const d = JSON.parse(raw);
        return {
          tasks: Array.isArray(d.tasks) ? d.tasks : [],
          sha: d.sha || null,
          lastSyncedAt: d.lastSyncedAt || null,
          tombstones: Array.isArray(d.tombstones) ? d.tombstones : [],
        };
      }
    } catch (e) { console.warn('本地云端缓存读取失败', e); }
    return { tasks: [], sha: null, lastSyncedAt: null, tombstones: [] };
  }

  _saveLocal() {
    try {
      localStorage.setItem(this._localKey, JSON.stringify({
        tasks: this._cache.tasks,
        sha: this._cache.sha,
        lastSyncedAt: this._cache.lastSyncedAt,
        tombstones: this._cache.tombstones,
      }));
    } catch (e) { console.warn('本地云端缓存写入失败', e); }
  }

  // 写操作收尾：持久化 + 标脏 + 防抖 push
  _touch() {
    this._dirty = true;
    this._saveLocal();
    this._setStatus('pending');
    if (this._syncTimer) clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => {
      this._syncTimer = null;
      this._sync();
    }, 4000);
  }

  // ===== Token 门 =====
  // 优先级：嵌入 token（config.token，跨端免输入）→ localStorage（同设备持久）→ 弹框输入。
  // 401/403 时 _clearToken 会把嵌入 token 标失效并清 localStorage，从而回落到弹框。
  ensureToken() {
    const embedded = this._embeddedValid ? this._embeddedToken : '';
    const stored = localStorage.getItem(this._tokenKey);
    const cached = embedded || stored;
    if (cached) return Promise.resolve(cached);
    if (this._tokenPromise) return this._tokenPromise;
    this._tokenPromise = this._promptForToken().then(token => {
      this._tokenPromise = null;
      if (!token) throw new Error('NO_TOKEN'); // 用户取消
      localStorage.setItem(this._tokenKey, token);
      return token;
    });
    return this._tokenPromise;
  }

  _promptForToken() {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.id = 'ghTokenOverlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999;';
      const box = document.createElement('div');
      box.style.cssText = 'background:var(--bg-card,#fff);color:var(--text,#111);padding:24px;border-radius:12px;width:360px;max-width:90vw;box-shadow:0 10px 40px rgba(0,0,0,.3);';
      box.innerHTML = `
        <h3 style="margin:0 0 8px;font-size:16px;">联网模式登录</h3>
        <p style="margin:0 0 12px;font-size:13px;opacity:.8;line-height:1.5;">请输入访问该数据仓库的 GitHub Token（fine-grained，仅 Contents 读写权限）。仅存于本浏览器会话，关闭即失效。</p>
        <input id="ghTokenInput" type="password" placeholder="github_pat_..." style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:8px;font-size:14px;margin-bottom:12px;" />
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="ghTokenCancel" style="padding:8px 14px;border:none;border-radius:8px;background:#eee;cursor:pointer;">取消</button>
          <button id="ghTokenSubmit" style="padding:8px 14px;border:none;border-radius:8px;background:#3b82f6;color:#fff;cursor:pointer;">确定</button>
        </div>`;
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      const input = box.querySelector('#ghTokenInput');
      input.focus();
      const finish = (val) => { overlay.remove(); resolve(val); };
      box.querySelector('#ghTokenSubmit').onclick = () => {
        const v = input.value.trim();
        if (v) finish(v);
      };
      box.querySelector('#ghTokenCancel').onclick = () => finish(null);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') box.querySelector('#ghTokenSubmit').click(); });
    });
  }

  _clearToken() {
    // token 失效：清 localStorage + 把嵌入 token 标失效，强制下次走弹框
    localStorage.removeItem(this._tokenKey);
    this._embeddedValid = false;
  }

  _delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ===== HTTP =====
  async _request(method, body) {
    const token = await this.ensureToken();
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
    };
    const opts = { method, headers, cache: 'no-store' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let url = this.apiBase;
    if (method === 'GET') {
      // ref=分支 + 递增破坏参数：双重保证不读到浏览器/GitHub CDN 缓存的旧 sha
      url += `?ref=${this.branch}&_=${this._bust++}`;
    }
    const res = await fetch(url, opts);
    if (res.status === 401 || res.status === 403) {
      this._clearToken();
      const err = new Error('TOKEN_INVALID'); err.code = 'TOKEN_INVALID'; err.status = res.status;
      throw err;
    }
    return res;
  }

  // ===== 文件读写（纯网络，不碰本地缓存）=====
  // 拉取 tasks.json。404 视为文件尚未创建（空数据）。返回 { tasks, sha }，不改 this._cache。
  async _fetchFile() {
    let res;
    try {
      res = await this._request('GET');
    } catch (e) {
      if (e.code === 'TOKEN_INVALID') throw e;
      throw new Error('读取云端数据失败：' + (e.message || e));
    }
    if (res.status === 404) return { tasks: [], sha: null };
    if (!res.ok) throw new Error('读取云端数据失败：HTTP ' + res.status);
    const data = await res.json();
    const sha = data.sha;
    let tasks;
    if (data.content) {
      tasks = this._parseTasks(this._base64ToUtf8(data.content));
    } else if (data.download_url) {
      // 大文件回退：走 download_url；私有仓库需带 token（嵌入或 localStorage）
      const token = this._embeddedValid ? this._embeddedToken : localStorage.getItem(this._tokenKey);
      const r2 = await fetch(data.download_url, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!r2.ok) throw new Error('下载云端数据失败：HTTP ' + r2.status);
      tasks = this._parseTasks(await r2.text());
    } else {
      tasks = [];
    }
    return { tasks, sha };
  }

  _parseTasks(text) {
    if (!text) return [];
    try {
      const data = JSON.parse(text);
      return Array.isArray(data) ? data : [];
    } catch (e) {
      console.error('云端 tasks.json 解析失败', e);
      return [];
    }
  }

  // 写入 tasks.json。传入显式 sha；409（sha 冲突）时重新拉取并重试两次。返回新 sha。
  async _putFile(tasks, sha) {
    const content = this._utf8ToBase64(JSON.stringify(tasks));
    const attempt = async (s) => {
      const body = { message: `chore: update tasks (${new Date().toISOString().slice(0, 19)}Z)`, content, branch: this.branch };
      if (s) body.sha = s;
      let res;
      try {
        res = await this._request('PUT', body);
      } catch (e) {
        if (e.code === 'TOKEN_INVALID') throw e;
        throw new Error('写入云端数据失败：' + (e.message || e));
      }
      if (res.status === 409) return { conflict: true };
      if (!res.ok && res.status !== 201) {
        const txt = await res.text().catch(() => '');
        throw new Error('写入云端数据失败：HTTP ' + res.status + ' ' + txt);
      }
      const data = await res.json();
      return { conflict: false, sha: data.content && data.content.sha };
    };
    let r = await attempt(sha);
    for (let i = 0; r.conflict && i < 2; i++) {
      await this._delay(300 * (i + 1));
      const fresh = await this._fetchFile();
      r = await attempt(fresh.sha);
    }
    if (r.conflict) throw new Error('CLOUD_CONFLICT');
    return r.sha || sha;
  }

  // ===== 合并（轻量 LWW，单用户低并发）=====
  // 软删除模型：删除 = 标 deletedAt 留在数组里（随 tasks.json 跨端传播）。
  // 同 id 取「最后修改时间」较新者；最后修改时间 = max(updatedAt, deletedAt)。
  // 这样 A 端删除（deletedAt 较新）会传播到 B 端，B 端 getAllTasks 过滤后不显示——删除不再被复活。
  _lastMod(t) {
    const u = t.updatedAt ? Date.parse(t.updatedAt) : 0;
    const d = t.deletedAt || 0;
    return Math.max(u, d);
  }

  _merge(localTasks, remoteTasks) {
    const byId = new Map();
    for (const r of remoteTasks) byId.set(r.id, r);
    for (const l of localTasks) {
      const r = byId.get(l.id);
      if (!r) { byId.set(l.id, l); continue; }
      byId.set(l.id, this._lastMod(l) >= this._lastMod(r) ? l : r);
    }
    return Array.from(byId.values());
  }

  // 清理软删除超 30 天的任务（所有端此时都已同步过该删除）
  _pruneDeleted(tasks) {
    const now = Date.now();
    const EXPIRE = 30 * 24 * 3600 * 1000;
    return (tasks || []).filter(t => !t.deletedAt || now - t.deletedAt < EXPIRE);
  }

  // ===== 同步核心：pull + push =====
  async _sync() {
    if (this._syncing) return;
    this._syncing = true;
    this._setStatus('syncing');
    try {
      this._ensureLoaded();
      await this.ensureToken();
      const remote = await this._fetchFile(); // { tasks, sha }
      const beforeLocal = JSON.stringify(this._cache.tasks); // 同步前本地快照
      let merged = this._merge(this._cache.tasks, remote.tasks);
      merged = this._pruneDeleted(merged); // 清理 30 天前的软删除
      const needPush = this._dirty || JSON.stringify(merged) !== JSON.stringify(remote.tasks);
      let newSha;
      if (needPush) {
        newSha = await this._putFile(merged, remote.sha);
      } else {
        newSha = remote.sha;
      }
      this._cache.tasks = merged;
      this._cache.sha = newSha;
      this._cache.lastSyncedAt = Date.now();
      this._dirty = false;
      this._saveLocal();
      this._setStatus('synced');
      // 合并结果与同步前本地不同（远端新增/修改/删除），刷新 UI。
      // 本地刚操作的改动 App 已知晓，刷新一次内容一致无害。
      const hasRemoteChange = JSON.stringify(merged) !== beforeLocal;
      if (hasRemoteChange && typeof this.onSyncUpdate === 'function') {
        try { this.onSyncUpdate(); } catch (_) {}
      }
    } catch (e) {
      if (e && e.message === 'NO_TOKEN') {
        this._setStatus('nologin');
      } else {
        console.warn('同步失败', e);
        this._setStatus('error');
        // 保留 _dirty，下次定时/手动重试
      }
    } finally {
      this._syncing = false;
    }
  }

  // ===== 生命周期：启动同步 =====
  startSync() {
    this._ensureLoaded();
    this._createStatusBadge();
    this._setStatus(this._dirty ? 'pending' : 'idle');
    this._sync(); // 首次后台同步（拉取远端 + push 本地改动）
    this._pullTimer = setInterval(() => this._sync(), 20000);
    document.addEventListener('visibilitychange', () => this._sync());
    // 关闭前尽力 flush：仅当已有可用 token（嵌入或 localStorage）且有未 push 改动（避免关闭时弹 token 框）
    window.addEventListener('beforeunload', () => {
      const hasToken = (this._embeddedValid && this._embeddedToken) || localStorage.getItem(this._tokenKey);
      if (hasToken && this._dirty) this._sync();
    });
  }

  // ===== 同步状态徽标 + 手动同步按钮 =====
  _createStatusBadge() {
    if (document.getElementById('cloudSyncWrap')) return;
    const wrap = document.createElement('div');
    wrap.id = 'cloudSyncWrap';
    wrap.style.cssText = 'position:fixed;right:16px;bottom:16px;display:flex;align-items:center;gap:8px;z-index:9000;font-size:12px;font-family:inherit;user-select:none;';
    const dot = document.createElement('span');
    dot.style.cssText = 'display:inline-flex;align-items:center;padding:6px 12px;border-radius:999px;background:var(--bg-card,#fff);color:var(--text,#333);box-shadow:0 2px 10px rgba(0,0,0,.15);transition:opacity .3s,background .3s,color .3s;';
    const btn = document.createElement('button');
    btn.textContent = '立即同步';
    btn.style.cssText = 'padding:6px 14px;border:none;border-radius:999px;background:#3b82f6;color:#fff;cursor:pointer;font-size:12px;box-shadow:0 2px 10px rgba(0,0,0,.15);';
    btn.onclick = () => { if (!this._syncing) this._sync(); };
    wrap.appendChild(dot);
    wrap.appendChild(btn);
    document.body.appendChild(wrap);
    this._dot = dot;
    this._btn = btn;
  }

  _setStatus(s) {
    this._status = s;
    if (!this._dot) return;
    const map = {
      synced:  { t: '✓ 已同步', bg: 'rgba(34,197,94,.16)',  col: '#16a34a', op: '.7',  btn: true },
      syncing: { t: '⟳ 同步中', bg: 'rgba(59,130,246,.16)', col: '#2563eb', op: '1',   btn: false },
      pending: { t: '… 待同步', bg: 'rgba(234,179,8,.18)',  col: '#ca8a04', op: '1',   btn: true },
      error:   { t: '⚠ 同步失败', bg: 'rgba(239,68,68,.16)', col: '#dc2626', op: '1',   btn: true },
      nologin: { t: '待登录',   bg: 'rgba(0,0,0,.08)',      col: 'var(--text,#666)', op: '1', btn: true },
      idle:    { t: '● 就绪',   bg: 'var(--bg-card,#fff)',  col: 'var(--text,#666)', op: '.7', btn: true },
    };
    const c = map[s] || map.idle;
    this._dot.textContent = c.t;
    this._dot.style.background = c.bg;
    this._dot.style.color = c.col;
    this._dot.style.opacity = c.op;
    this._btn.disabled = !c.btn;
    this._btn.style.opacity = c.btn ? '1' : '.5';
    this._btn.style.cursor = c.btn ? 'pointer' : 'default';
  }

  // ===== UTF-8 安全的 base64（任务含中文与图片 base64，可能很大）=====
  _utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  _base64ToUtf8(b64) {
    const clean = (b64 || '').replace(/\s/g, '');
    const bin = atob(clean);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  // ===== DataStore 接口（与 LocalStore 同构；全部本地即时，零网络）=====
  // 软删除：带 deletedAt 的任务保留在 _cache.tasks 里（用于跨端传播），但对 App 不可见。
  async getAllTasks() {
    this._ensureLoaded();
    let maxId = 0;
    for (const t of this._cache.tasks) if (t.id) maxId = Math.max(maxId, t.id);
    const active = this._cache.tasks.filter(t => !t.deletedAt);
    for (const t of active) if (!t.id) t.id = ++maxId;
    return active;
  }

  async getTask(id) {
    this._ensureLoaded();
    const t = this._cache.tasks.find(t => t.id === id);
    return (t && !t.deletedAt) ? t : null;
  }

  async addTask(task) {
    this._ensureLoaded();
    const maxId = this._cache.tasks.reduce((m, t) => Math.max(m, t.id || 0), 0);
    task.id = maxId + 1;
    this._cache.tasks.unshift(task);
    this._touch();
    return task.id;
  }

  async updateTask(task) {
    this._ensureLoaded();
    const idx = this._cache.tasks.findIndex(t => t.id === task.id);
    if (idx === -1) throw new Error('任务不存在');
    this._cache.tasks[idx] = task;
    this._touch();
    return task.id;
  }

  // 软删除：标记 deletedAt 留在数组里，随 tasks.json 传播；不再用本地墓碑。
  async deleteTask(id) {
    this._ensureLoaded();
    const t = this._cache.tasks.find(x => x.id === id);
    if (!t) throw new Error('任务不存在');
    t.deletedAt = Date.now();
    this._touch();
  }

  // 整体替换活跃任务；保留当前缓存里未超期的软删除（避免导入/撤销时丢失尚未同步的删除）。
  async saveAll(tasks) {
    this._ensureLoaded();
    const activeIds = new Set(tasks.map(t => t.id));
    const keepDeleted = this._cache.tasks.filter(t => t.deletedAt && !activeIds.has(t.id));
    this._cache.tasks = [...tasks, ...keepDeleted];
    this._touch();
  }
}

// 暴露到全局，供 app.js 在联网模式下实例化
window.CloudStore = CloudStore;
