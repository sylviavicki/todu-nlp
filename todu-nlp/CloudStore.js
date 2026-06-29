/**
 * CloudStore —— 联网模式数据存储实现
 *
 * 通过 GitHub Contents API 把全部任务读写到仓库里的一个 JSON 文件（如 todu-nlp/tasks.json）。
 * 整文件“读-改-写”：个人单用户、低并发场景足够；用 sha 乐观锁防止多端互相覆盖。
 *
 * 访问凭证 = GitHub fine-grained PAT（仅给目标仓库 Contents 读写权限）。
 * 首次使用弹框输入，存 sessionStorage（关浏览器即失效，避免长期驻留）。
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
    // 内存缓存：减少 GET 次数；写入后失效或更新
    this._cache = null; // { tasks: [], sha: null | string }
    this._tokenKey = 'zhiban_gh_token';
  }

  // ===== Token 门 =====
  // 确保已获得 token：sessionStorage 有就直接返回；没有则弹框让用户输入。
  // 返回 Promise<string>。输入错误（后续请求 401/403）会清 token 并重新弹框。
  ensureToken() {
    const existing = sessionStorage.getItem(this._tokenKey);
    if (existing) return Promise.resolve(existing);
    if (this._tokenPromise) return this._tokenPromise;
    this._tokenPromise = this._promptForToken().then(token => {
      this._tokenPromise = null;
      if (!token) throw new Error('NO_TOKEN'); // 用户取消
      sessionStorage.setItem(this._tokenKey, token);
      return token;
    });
    return this._tokenPromise;
  }

  _promptForToken() {
    return new Promise(resolve => {
      // 构建遮罩与输入框（动态创建，不依赖 index.html 增加节点）
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
    sessionStorage.removeItem(this._tokenKey);
  }

  // ===== HTTP =====
  async _request(method, body) {
    const token = await this.ensureToken();
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
    };
    const opts = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(this.apiBase + (method === 'GET' ? `?ref=${this.branch}` : ''), opts);
    if (res.status === 401 || res.status === 403) {
      // token 失效：清掉重新弹框，并抛出以便上层重试
      this._clearToken();
      const err = new Error('TOKEN_INVALID'); err.code = 'TOKEN_INVALID'; err.status = res.status;
      throw err;
    }
    return res;
  }

  // ===== 文件读写 =====
  // 拉取 tasks.json。404 视为文件尚未创建（空数据）。
  async _fetchFile() {
    let res;
    try {
      res = await this._request('GET');
    } catch (e) {
      if (e.code === 'TOKEN_INVALID') throw e;
      throw new Error('读取云端数据失败：' + (e.message || e));
    }
    if (res.status === 404) {
      this._cache = { tasks: [], sha: null };
      return this._cache;
    }
    if (!res.ok) throw new Error('读取云端数据失败：HTTP ' + res.status);
    const data = await res.json();
    const sha = data.sha;
    let tasks;
    if (data.content) {
      // 内联 base64（<1MB）
      tasks = this._parseTasks(this._base64ToUtf8(data.content));
    } else if (data.download_url) {
      // 大文件回退：走 download_url（私有仓库需带 token）
      const token = sessionStorage.getItem(this._tokenKey);
      const r2 = await fetch(data.download_url, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!r2.ok) throw new Error('下载云端数据失败：HTTP ' + r2.status);
      tasks = this._parseTasks(await r2.text());
    } else {
      tasks = [];
    }
    this._cache = { tasks, sha };
    return this._cache;
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

  // 写入 tasks.json。409（sha 冲突）时重新拉取并重试一次，避免覆盖他端改动。
  async _putFile(tasks) {
    const content = this._utf8ToBase64(JSON.stringify(tasks));
    const attempt = async (sha) => {
      const body = { message: `chore: update tasks (${new Date().toISOString().slice(0, 19)}Z)`, content, branch: this.branch };
      if (sha) body.sha = sha;
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
    let cur = this._cache ? this._cache.sha : null;
    let r = await attempt(cur);
    if (r.conflict) {
      // 冲突：拉最新，再重试一次（用最新 sha，但用我们这次要写的内容覆盖）
      const fresh = await this._fetchFile();
      r = await attempt(fresh.sha);
      if (r.conflict) throw new Error('CLOUD_CONFLICT'); // 仍冲突，放弃
    }
    this._cache = { tasks, sha: r.sha || (this._cache && this._cache.sha) };
    return this._cache;
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

  // ===== DataStore 接口（与 LocalStore 同构）=====
  async getAllTasks() {
    const c = await this._fetchFile();
    // 补全缺失 id（与本地一致）
    let maxId = 0;
    for (const t of c.tasks) if (t.id) maxId = Math.max(maxId, t.id);
    for (const t of c.tasks) if (!t.id) t.id = ++maxId;
    return c.tasks;
  }

  async getTask(id) {
    const tasks = await this.getAllTasks();
    return tasks.find(t => t.id === id) || null;
  }

  async addTask(task) {
    const tasks = await this.getAllTasks();
    const maxId = tasks.reduce((m, t) => Math.max(m, t.id || 0), 0);
    task.id = maxId + 1;
    tasks.unshift(task);
    await this.saveAll(tasks);
    return task.id;
  }

  async updateTask(task) {
    const tasks = await this.getAllTasks();
    const idx = tasks.findIndex(t => t.id === task.id);
    if (idx === -1) throw new Error('任务不存在');
    tasks[idx] = task;
    await this.saveAll(tasks);
    return task.id;
  }

  async deleteTask(id) {
    const tasks = await this.getAllTasks();
    const filtered = tasks.filter(t => t.id !== id);
    if (filtered.length === tasks.length) throw new Error('任务不存在');
    await this.saveAll(filtered);
  }

  async saveAll(tasks) {
    await this._putFile(tasks);
  }
}

// 暴露到全局，供 app.js 在联网模式下实例化
window.CloudStore = CloudStore;
