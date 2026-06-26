# 智办 — 自然语言待办工具

> 离线运行 · localStorage 持久化 · 中文自然语言解析 · 超期预警
> 双击 `todu-nlp/index.html` 即可使用，无需服务器、无需联网、零依赖。

「智办」是一个纯前端的待办管理工具，核心能力是把一句中文自然语言直接解析成结构化任务（标题、描述、干系人、截止时间、备注、状态），并用 localStorage 离线保存。所有逻辑跑在浏览器本地，数据不离开本机。

本仓库包含两部分：主应用 `todu-nlp` 与其测试套件 `todu-nlp-tests`。

---

## 📁 仓库结构

```
.
├── todu-nlp/                       # 主应用
│   ├── index.html                  # 主界面：HTML + CSS（内联，无外部资源）
│   ├── guide.html                  # 功能使用介绍页
│   └── app.js                      # 全部业务逻辑：存储 / NLP / 渲染 / 交互（约 1590 行）
└── todu-nlp-tests/                 # 测试套件（零第三方依赖，基于 node:test）
    ├── nlp.test.js                 # NLP 解析回归测试（67 条用例）
    ├── app.test.js                 # app.js 核心逻辑（存储 CRUD）
    ├── app-supplement.test.js      # 补充测试（导入导出 / 合并策略）
    └── _changed_methods_regression.js  # 视觉改动方法级回归（主题/横幅/toast）
```

应用三个文件全部内联、零外部依赖（字体用系统自带字体，图标用内联 SVG）。测试通过文件系统读取 `../todu-nlp/app.js` 在 Node 中加载断言。

---

## ✨ 功能特性

### 自然语言解析（`NLP.parse`）
输入一句话即可创建完整任务，自动识别：

- **截止时间**：`今天 / 明天 / 后天 / 大前天 / 一周后 / 半个月后`、`下周三 / 本周三 / 上周三`、`6月20日`、纯数字 `20260617 / 0617 / 2026-6-17`、`20260701之前`、带时分 `明天下午3点 / 14:30` 等；未识别到日期时默认今天 23:59。
- **干系人**：`负责人:张三`、`分配给李四`、`由王五负责`、`@张三 @李四` 多人提及。
- **备注**：`备注:...`、`注意:...`、`附注:...`，句首或句中均可。
- **状态**：`已完成 / 做完`、`正在 / 进行中`、`待办 / 未开始 / 计划`。
- **标题/描述分离**：按标点或连词智能断句，长文本自动拆出标题与描述。
- 中文数字转整数（`十五 / 二十三`）用于相对日期偏移。

### 任务管理
- 增删改查、状态流转（待办 / 进行中 / 完成）。
- **超期预警**：已超期任务自动置顶并标注「(已超期)」。
- **重复任务**：按 日 / 周 / 月 / 季 设置循环提醒。
- **图片附件**：粘贴或上传图片作为附件，支持大图浮窗预览。
- **搜索过滤**：实时关键字检索。
- **导入 / 导出**：JSON 备份恢复，支持覆盖、合并、交叉合并三种策略。
- **数据备份提醒**：当日未导出时弹横幅，可当天关闭。
- **明暗主题切换**：跟随系统或手动切换，SVG 图标不依赖系统 emoji 字体（麒麟等无彩色 emoji 字体的系统也能正常显示）。
- **实时解析预览**：输入时即时展示解析结果。

---

## 🚀 快速开始

### 使用应用
1. 下载 `todu-nlp/` 下三个文件到同一目录。
2. 双击 `index.html` 用浏览器打开即可。例如输入：

```
明天下午3点 完成季度汇报PPT，负责人:张三，备注:含财务数据 @李四
```

解析结果实时预览，回车即创建任务。

> 因使用 `localStorage`（键名 `zhiban_tasks`），本地 `file://` 或任意静态服务器打开均可，数据按浏览器/域名隔离。

### 运行测试
前置：Node.js 18+（需支持 `node:test`）。

```bash
# 运行全部 node:test 用例
node --test

# 或单独运行
node todu-nlp-tests/nlp.test.js
node --test todu-nlp-tests/app.test.js
node --test todu-nlp-tests/app-supplement.test.js
node todu-nlp-tests/_changed_methods_regression.js
```

> `nlp.test.js` 与 `_changed_methods_regression.js` 是自执行脚本（内部 `process.exit`），直接 `node <file>` 运行；`app.test.js` / `app-supplement.test.js` 用 `node:test`，可由 `node --test` 统一调度。

---

## 🧪 测试设计要点

- **为什么 NLP 测试用固定 `Date` 桩**：相对日期断言（`上周X / 下周X / 0628`）若用真实 `new Date()` 会随运行日期漂移、隔天就坏。`nlp.test.js` 把 `Date` 固定到 `2026-06-23（周二）10:00`，期望值原样成立且永不再漂。
- **加载方式**：`app.test.js` / `app-supplement.test.js` 通过 mock `global.localStorage` / `global.document` 后 `require` 加载；`nlp.test.js` / `_changed_methods_regression.js` 使用 `vm` 上下文加载并截掉末尾自启动段，避免触发 `App.init()` 访问真实 DOM。
- **DOM 桩**：`_changed_methods_regression.js` 自带能记录操作的 DOM 桩，`getElementById` 返回带真实 `classList / style / textContent` 的元素，`documentElement / body` 可被 `setAttribute / appendChild` 真实操作。
- **NLP 用例**：sections A–H 共 67 条，覆盖纯数字日期、中文日期、星期、相对时间、时分、干系人多种写法、@提及、备注、状态关键词、标题/描述断句。

---

## 🔒 数据与隐私

- 全部数据保存在浏览器 `localStorage`，**不上传任何服务器**。
- 建议定期用「导出」功能备份 JSON，避免清浏览器缓存时丢失。

---

## 📝 技术说明

- 纯原生 HTML / CSS / JavaScript（ES6+），无构建步骤、无 npm 依赖。
- 主题色板采用 teal / amber / coral / sage 暖色调，圆角卡片风格。
- 测试同样零第三方依赖，仅用 Node 内置 `node:test` 与 `node:assert`。
