/**
 * 联网模式配置（部署版专用）
 *
 * 仓库坐标公开；Token 可选填入下方 token 字段随站点发布，实现「跨端免输入」。
 * ⚠ 注意：本文件会随公开仓库发布到 GitHub Pages。若填入 token，任何访问站点的人都能
 *   提取它并读写该数据仓库（仅限此 fine-grained PAT 授权范围）。仅当数据不敏感时才填。
 *   不填则保持原行为：首次访问弹框输入，存 localStorage（同设备持久，换设备需再输一次）。
 *
 * 本地双击 index.html（file:// 协议）即使加载了本文件，也会被 app.js 强制走本地存储，
 * 不会进入联网模式——见 app.js init() 中的协议判定。
 *
 * ===== 数据仓库建议 =====
 * GitHub Pages 免费版只能托管「公开仓库」的前端。但任务数据应私密，因此推荐：
 *   - 前端仓库（公开，托管 Pages）：就是你现在的 todu-nlp 代码仓库
 *   - 数据仓库（私有，只放一个 tasks.json）：另建一个私有仓库，CloudStore 指向它
 * 这样前端能白嫖 GitHub Pages，数据又不被公开读取（写入靠你的 PAT）。
 * 若不在意数据公开，也可直接用同一个公开仓库存 tasks.json。
 */
window.CLOUD_CONFIG = {
  owner: 'sylviavicki',          // GitHub 用户名
  repo: 'todu-nlp-data',         // 存 tasks.json 的仓库（推荐私有数据仓库）
  path: 'tasks.json',            // 仓库内 tasks.json 的路径
  branch: 'main',                // 分支
  token: ''                      // 可选：填入 fine-grained PAT 即跨端免输入（会随公开站点发布，数据不敏感时才填）
};
