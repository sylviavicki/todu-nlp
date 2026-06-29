/**
 * 联网模式配置（部署版专用）
 *
 * 仅含公开信息（仓库坐标），不含任何 Token。Token 在浏览器访问时弹框输入、仅存 sessionStorage。
 * 提交到仓库是安全的；GitHub Pages 部署时会随站点一起发布。
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
  branch: 'main'                 // 分支
};
