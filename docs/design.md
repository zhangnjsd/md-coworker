# md-coworker 前端设计规范（v2 · "Ink & Signal"）

本文件是前端视觉/交互的唯一事实来源。改样式前先读本文件，**只允许使用 `web/src/styles/tokens.css` 里的 token**，禁止在组件里写硬编码颜色/字号/间距/缓动。

参考规范：`frontend-design-pro`（字体个性、OKLCH、8px 栅格、禁 bounce、focus 可见、skeleton 优于 spinner）
\+ `ui-ux-pro-max`（Developer Tool/IDE → Dark + Minimalism；Collaboration Tool → 在线状态指示器是核心；Knowledge Base → 层级清晰、颜色极简、代码高亮）。

---

## 1. 设计方向

**Ink & Signal**：一个安静的、以文档为主角的写作工作台。

- **文档优先**：屏幕属于 CodeMirror / Monaco / 预览三块正文，其他一切都是薄薄的一层"仪表"。
- **信号系统**：协作这件事靠颜色点（presence dot）统一表达——文件树、协作者栏、远端光标、状态栏用同一套点 + 用户名。
- **瑞士网格**：8px 节奏、数学化间距、单一强调色、hairline 边框只在承担结构时出现（不做"卡片套卡片"）。
- **技术感来自排版而非装饰**：元信息（路径、行列、计数、快捷键）用等宽字体、11px、大写、`letter-spacing: .08em`；标题用 Space Grotesk。

反面清单（出现即为 bug）：纯黑 `#000`、纯灰（无色调）中性色、Inter/Arial/system-ui 当主字体、蓝紫渐变、彩色底上的灰字、卡片套卡片、bounce/elastic 缓动、`outline: none` 且无替代、spinner 当默认加载态、超过 600ms 的动画、13px/22px 这类随手 padding。

---

## 2. 字体

| 角色 | token | 字体栈 | 用法 |
| --- | --- | --- | --- |
| 正文 / UI | `--font-sans` | `'Geist Variable'` + 中文回退栈 | 所有界面文字，13px 基准 |
| 标题 / 品牌 | `--font-display` | `'Space Grotesk Variable'` + `--font-sans` | 页面标题、弹窗标题、品牌字、登录主标题 |
| 代码 / 元信息 | `--font-mono` | `'Geist Mono Variable'` + 等宽回退 | 代码、路径、行号、计数、快捷键、`kbd` |

中文回退栈（**不要用 system-ui**）：`'PingFang SC', 'Hiragino Sans GB', 'Source Han Sans SC', 'Noto Sans CJK SC', 'Microsoft YaHei'`。

字号阶梯（1.25，全部有 token）：`--fs-meta:11 · --fs-xs:12 · --fs-sm:13 · --fs-md:14 · --fs-lg:16 · --fs-xl:20 · --fs-2xl:25 · --fs-3xl:31`（px）；两个功能字号：`--fs-code:13.5`（编辑器源码）、`--fs-prose:15`（预览正文，`--preview-host` 的 `container-type: inline-size` 让标题用 `cqi` 跟随分栏宽度）。

规则：
- 界面正文 `--fs-sm`（13px），次要文字 `--fs-xs`，元信息 `--fs-meta`。
- 只有页面标题用 `--fs-2xl`/`--fs-3xl`，且 `letter-spacing: -0.02em`；同一视图内最多 3 级字阶差。
- 行高：正文 1.6，UI 控件 1.2，标题 1.15。
- 代码与路径一律 `--font-mono`；数字用 `font-variant-numeric: tabular-nums`。
- 中英混排：拉丁字用 Geist/Space Grotesk，中文自动落回回退栈，不要在中文之间手动加空格。

---

## 3. 颜色（OKLCH）

中性色带冷色调（hue 255，chroma 0.006–0.012），**不用纯灰**；深色底不用纯黑。

| token | 值 | 用途 |
| --- | --- | --- |
| `--bg` | `oklch(0.205 0.014 250)` | 应用底色（墨蓝 slate，禁纯黑） |
| `--bg-1` | `oklch(0.235 0.014 250)` | 顶栏 / 侧栏 / 状态栏 / 面板 |
| `--bg-2` | `oklch(0.265 0.014 250)` | 输入框、按钮、被抬起的行 |
| `--bg-3` | `oklch(0.305 0.014 250)` | hover / active 最强态 |
| `--bg-editor` | `oklch(0.195 0.012 250)` | 源码画布（比面板深一档，源码不是主角） |
| `--bg-preview` | `oklch(0.248 0.012 250)` | 预览画布：比源码亮一档，让渲染后的文档成为主角 |
| `--line` | `oklch(0.35 0.016 250)` | 结构分界线（顶栏下沿、分割条、表格行） |
| `--line-soft` | `oklch(0.285 0.014 250)` | 组内细分隔 |
| `--fg` | `oklch(0.95 0.006 250)` | 主文字（对 `--bg` ≥ 12:1） |
| `--fg-2` | `oklch(0.78 0.010 250)` | 次要文字（≥ 6:1） |
| `--fg-3` | `oklch(0.70 0.012 250)` | 元信息 / 占位（≥ 4.5:1，**不允许更低**） |
| `--accent` | `oklch(0.82 0.12 172)` | 唯一强调色（青玉）：focus、当前项、主按钮底、在线点 |
| `--accent-ink` | `oklch(0.22 0.05 172)` | 强调色填充上的文字 |
| `--accent-soft` | `color-mix(in oklab, var(--accent) 14%, transparent)` | 选中底/悬停底 |
| `--accent-line` | `color-mix(in oklab, var(--accent) 42%, transparent)` | 强调边框 |
| `--danger` | `oklch(0.72 0.17 25)` | 危险动作、错误文字 |
| `--warn` | `oklch(0.84 0.13 82)` | 警告、2FA 未启用、管理员徽标 |
| `--ok` | `var(--accent)` | 已保存 / 在线 |

保留的兼容 token（旧代码/内联样式仍在用，新代码可以直接用上面的）：`--bg-panel`→`--bg-1`、`--bg-raised`→`--bg-2`、`--bg-hover`→`--bg-3`、`--bg-active`→`--bg-3`、`--border`→`--line`、`--border-soft`→`--line-soft`、`--fg-dim`→`--fg-2`、`--fg-faint`→`--fg-3`。

对比度硬要求：正文 ≥ 7:1；次要文字 ≥ 4.5:1；**不允许彩色底上放灰字**（强调底上放 `--accent-ink`，危险底上放接近白的红调 `oklch(0.95 0.04 25)`）。

用户配色（presence）来自服务端 `user.color`，一律以**内联样式**渲染成 6px 圆点或 2px 左边条，不要改它的亮度，也不要给点加发光。

---

## 4. 空间与形状

间距只用 token：`--sp-1:4 --sp-2:8 --sp-3:12 --sp-4:16 --sp-5:24 --sp-6:32 --sp-7:40 --sp-8:56`（px）。

- 组件内 padding：按钮 `0 var(--sp-3)`、输入 `var(--sp-2) var(--sp-3)`、面板 `var(--sp-4)`、弹窗 `var(--sp-5) var(--sp-6)`。
- 组与组之间 `--sp-4`/`--sp-5`；同组内 `--sp-2`。
- 圆角：`--r-xs:4px`（徽标、点）、`--r-sm:6px`（按钮、输入）、`--r-md:10px`（面板、弹窗内部块）、`--r-lg:14px`（弹窗）、`--r-full:999px`。
- 边框一律 1px `--line`；**不要给每个盒子都加边框**——同组元素靠间距分组，只在结构转折处画线。
- 阴影只有两档：`--shadow-1`（行/徽标轻浮起）、`--shadow-pop`（弹窗、下拉）。面板不用阴影，用 `--bg-1` + 一条 `--line` 就够了。
- 正文可读宽度上限 `65ch`（预览正文用 `max-width: 68ch` 居中）。

布局尺寸：`--topbar-h:48px`、`--status-h:28px`、`--rail-w:236px`（协作者栏）、`--tree-w:264px`（文件树）。桌面only，`body { min-width: 1024px }` 保留。

---

## 5. 动效

- 缓动只有一条：`--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`；线性/`ease`/`ease-in-out` 只在颜色渐变里可用。
- 时长：`--dur-1:120ms`（hover/press/focus）、`--dur-2:180ms`（展开收起、toast 进出）、`--dur-3:320ms`（弹窗、视图切换）。**任何动画不超过 500ms**。
- 只动 `opacity` 和 `transform`（必要时 `background-color`、`border-color`）。禁止动 `width/height/margin`（拖拽分隔条除外）。
- 禁止 bounce / elastic / spring 回弹；禁止 `transform: scale(1.1)` 这类夸张 hover。
- 所有 `transition`/`animation` 必须在 `@media (prefers-reduced-motion: reduce)` 里被压成 `0.01ms`（在 tokens.css 里有统一兜底，组件不要再各写一遍）。
- 骨架屏用 1.6s 的 `opacity` 呼吸（`--anim-shimmer`），不要旋转 spinner。

---

## 6. 组件规范

**按钮**（`.btn`，高 30px；`.btn-sm` 26px）
- 层级只有三种：`.btn-primary`（`--accent` 底 + `--accent-ink` 字，全页最多一个视觉重心）、`.btn`（`--bg-2` 底 + `--line` 边）、`.btn-ghost`（透明底、`--fg-2` 字，hover 才出底）。
- `.btn-danger` 只在真正破坏性动作上（删除用户、删除文件），平时低调：透明底 + `--danger` 字 + `--danger` 边框 30%。
- hover 只改 `background-color`/`border-color`/`color`；`:active` 不加位移（禁止 `translateY`）。
- 禁用：`opacity: .45` + `cursor: not-allowed`，**并且**必须能说明原因（`title` 或旁边的 hint 文案）。
- 文案动词开头："创建用户"、"重置密钥"、"保存更改"、"关闭 2FA"；不用"确定/确认/提交"。

**输入**（`.input`）
- 高 32px（`textarea` 自适应），`--bg-2` 底、`--line` 边、`--r-sm`。
- 占位符 `--fg-3`，示例要真实（"例如 alice"）。
- focus：`border-color: var(--accent)` + `box-shadow: 0 0 0 3px var(--accent-soft)`，且必须有 `:focus-visible` 的 2px ring（见 §7）。
- 错误：`border-color: var(--danger)` + 下方 `.field-error` 具体说明怎么改。

**徽标**（`.badge`，高 18px、`--r-full`、11px、`text-transform` 见组件）
- `.badge-admin`（`--warn` 系）、`.badge-user`（`--fg-2` 系，中性）、`.badge-ok`（accent 系）、`.badge-muted`（`--line` 系）。
- 徽标是"标签"不是"按钮"，不加 hover。

**文件树行**（`.tree-row`，高 28px）
- 缩进 `12px × 深度 + 8px`；行内：折叠箭头 → 图标 → 文件名 → 右侧"正在编辑"圆点。
- 当前打开：`--bg-3` 底 + 左侧 2px `--accent` 竖条（不用整行描边）。
- 被他人编辑：文件名的圆点用对方颜色（`.tree-presence-dot`，6px），并在 `title` 里给出"谁在编辑"。
- hover 出现行尾操作按钮（重命名/删除），默认 `opacity: 0`；键盘 focus 时也要出现（`:focus-within`）。

**面板头**（`.pane-head`，高 34px）
- 左侧标题 12px `--fg-2` + 右侧元信息（`--fs-meta` 等宽 大写）；下沿 1px `--line`；背景 `--bg-1`（比画布浅一档，让画布更沉）。
- 不要圆角、不要阴影、不要卡片边框。

**协作者栏**（`.collab-panel`）
- 顶部：`在线 N 人`（数字用等宽、`--fg`）、空态文案 + "打开同一文件即可看到彼此的光标"这样的下一步。
- 每个人一行：颜色点 + 用户名 + `我在编辑`/文件名 + 行列号（等宽）。
- 名单变化用 180ms 的 `opacity`+`translateY(4px)` 入场，禁止横向滑入。

**状态栏**（`.statusbar`，高 28px）
- 左侧：当前文件路径（等宽、`--fg-3`）；右侧：`行 x, 列 y`、`在线 n 人`、保存状态（点 + "已保存"/"保存中…"）。
- 全部 `--fs-meta`，数字 tabular；分隔用 `--line-soft` 竖线，不用圆点堆叠。

**弹窗**（`.modal`）
- 遮罩 `oklch(0.12 0.012 250 / .62)`（墨色而非纯黑）+ 4px `backdrop-filter: blur`；面板 `--bg-1`、`--r-lg`、`--shadow-pop`、最大宽 520px（密钥类 640px）。
- 头：标题（`--font-display`、`--fs-lg`）+ 一行说明（`--fg-2`）；底：右对齐按钮，主按钮在右。
- 进出：`opacity` + `translateY(8px)→0`，`--dur-3`。

**Toast**（`.toast`）
- 右下角，`--bg-1` + `--line` + `--shadow-pop`，左侧 3px 色条区分 `ok/warn/danger`；`--fs-xs`；进出 180ms；同一时刻最多 3 条，超出从旧到新淘汰。

**管理员表格**（`.admin-table`）
- 行高 44px，行间 `--line-soft` 细线；表头 `--fs-meta` 大写 `--fg-3`，粘性；hover 行 `--bg-2`。
- 操作列右对齐，`btn-sm` 低调款；删除用 `.btn-danger` 但只有 hover 到行内才出现（可见性靠 `opacity`，不要 `display:none` 破坏可访问性）。
- 用户列表首列：颜色点 + 用户名 + （我）标记。

---

## 7. 状态与可访问性

每个异步区域都要有四种状态：**空 / 加载 / 错误 / 有数据**，缺一不可。

- 加载：骨架屏（`.skeleton`，等宽高度、`--bg-2` 底、呼吸动画），**不要** spinner，不要闪白。
- 空：一句说明 + 一个下一步动作（例如"还没有文件。点上方 新建 创建第一个 .md"）。
- 错误：`--danger` 文字 + 重试按钮；文案要说清"发生了什么 + 怎么办"，不许"出错了"。
- 禁用：必须有理由（`title` 或可见 hint）。

键盘与焦点：
- 所有可交互元素 `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: inherit; }`，禁止裸 `outline: none`。
- Tab 顺序跟随视觉顺序；弹窗内 `aria-modal="true"` 且焦点先落在首个输入/主按钮，Esc 关闭。
- 图标按钮必须有 `aria-label`；纯装饰 SVG `aria-hidden="true"`。
- 在线状态不只靠颜色：始终配文字（"在线 N 人"）。

---

## 8. 文案

- 按钮：动词开头（创建用户 / 重置密钥 / 关闭 2FA / 返回工作区 / 重新连接）。
- 错误：具体 + 可操作。"密钥与该用户不匹配，请粘贴完整私钥（44 字符）或重新选择 .key 文件" 优于 "登录失败"。
- 加载："正在载入文件树…" 而不是 "请稍候…"。
- 空态：说明原因 + 下一步。
- 技术名词保持原文（CRDT、Yjs、TOTP、Ed25519），不要翻译成"分布式数据类型"。

---

## 9. 文件归属（并行改造时不越界）

| 文件 | 负责人 | 内容 |
| --- | --- | --- |
| `web/src/styles/tokens.css` | lead | token、reset、排版基座、focus、滚动条、工具类、reduced-motion 兜底 |
| `web/src/styles/prose.css` | lead | 预览正文（markdown-body）、代码高亮、KaTeX/Mermaid、远端光标、文件树编辑标记 |
| `web/src/styles/shell.css` | shell | 顶栏、侧栏+文件树、分栏、协作者栏、状态栏、编辑器外壳 |
| `web/src/styles/views.css` | views | 登录、管理员、设置页 |
| `web/src/styles/overlays.css` | views | 弹窗、toast、密钥展示、骨架屏 |
| `web/src/styles/index.css` | lead | 只做 `@import` 汇总 |
| `web/src/views/app.js`、`web/src/ui/tree.js` | shell | 结构与文案改动 |
| `web/src/views/{login,admin,settings}.js`、`web/src/ui/{modal,toast,secret}.js` | views | 结构与文案改动 |

**禁止**：改 `web/src/net/*`、`web/src/editor/*`、`web/src/main.js`、`web/index.html`、`web/vite.config.js`、`web/package.json`（需要就告诉 lead）。
**禁止**：跑 `npm run build`（lead 统一构建）；可以用 `npx vite --port 51xx` 自检。
**必须保留**的结构/选择器（自动化测试依赖）：`.tree-row[data-path]`、`.cm-content`、`.markdown-body svg`、`.login-submit`、`input.input`、`textarea.key-input`、`.app-shell`、`.tree-presence-dot`、`data-editors`、`.collab-panel` 内文本、状态栏文本。

---

## 9.1 上传相关组件（v1.2）

| 组件 | 规则 |
| --- | --- |
| 上传按钮 | `.sidebar-tools` 里的 `.icon-btn`（`aria-label="上传文件"`），收起侧栏时在 `.sidebar-rail` 里保留一个；快捷键 `Mod+Shift+U` |
| 目标目录 | 取文件树当前选中项：选中目录用它自己、选中文件用其父目录、未选中用工作区根（文案「工作区根目录」）；选中项用与打开文件相同的 `--bg-3` + inset 2px accent 表达 |
| 拖拽遮罩 | `.drop-overlay`（`position:fixed`、z-index 90、`pointer-events:none`），只播 opacity 与 8px translateY，`dragenter/dragleave` 计数避免抖动；文案给出「目标目录 + 单文件上限 + 批次上限」三件事 |
| 进度 | `.upload-progress`：文件名 + 百分比 + 细轨道（`transform: scaleX()`，不用 width），`role="progressbar"` + `aria-valuenow`/`aria-valuetext`；未知总长时显示不确定态 |
| 409 覆盖 | 只在 `file_exists` 时用 `confirmDialog` 询问（列出具体路径），确认后对同批 `overwrite=1` 重试 |
| 管理台「上传限制」 | `.admin-settings` 作为用户列表的兄弟面板（同一 surface、hairline 分隔，不再套盒子）；输入 MiB、实时换算字节、非法值禁用保存并给 `role=alert` 文案；加载用与表单同几何的 skeleton |
| 单位 | 一律二进制单位 MiB / KiB（`10 MiB = 10485760 字节`），不写 MB |
| 预览图片 | 相对路径改写成 `/api/raw?path=…`，`loading="lazy"`；`http(s)`、`data:`、站内绝对路径原样保留 |

## 9.2 滚动同步（v1.3）

编辑区与预览共用一套「源码行锚点」，不按文档比例对齐（比例会随渲染高度漂移）。

| 环节 | 做法 |
| --- | --- |
| 锚点 | 预览渲染时给每个块级 token 加 `data-line`（该块起始的源码行），Mermaid 与代码块自绘的 HTML 同样带 `data-line` |
| 编辑器 → 预览 | 编辑器滚动时用 `lineBlockAtHeight` 算出「顶行 + 块内比例」，预览把同一行的锚点贴到顶边 |
| 预览 → 编辑器 | 预览滚动时用 `[data-line]` 反算顶块行与块内比例，编辑器 `scrollToLine(line, frac)` |
| 回声抑制 | 每次程序化写入后记住实际 `scrollTop`，收到的滚动事件在 ±2px 内视为自身回声，否则当作用户滚动 |
| 重渲染不打断阅读 | 渲染前捕获「当前意图锚点」，替换 DOM 后回填；替换后 150ms 内的滚动事件忽略（替换本身会把滚动归零） |
| 迟到的布局变化 | 图片解码、Mermaid 完成会改变页面高度，按**最新意图**重锚；用户 700ms 内刚滚动过就放手 |
| 竞态 | 用递增序号保护：早于最新意图的重渲染不得把读者拽回旧位置 |

验收：在长文档里滚动任一侧，另一侧顶部落在同一处正文（同一块）；连续打字时两侧 `scrollTop` 变化都小于一行的量级。

---

## 10. 验收

1. `npx vite --port 51xx` 打开后：登录页 / 工作区 / 管理员页 / 设置弹窗 四屏无一处硬编码颜色（`grep -n "#[0-9a-fA-F]\{3,6\}" styles/*.css` 只允许出现在 tokens.css 的注释里）。
2. 键盘走一遍：Tab 到每个可交互元素都有可见 ring；弹窗 Esc 可关。
3. 缩放系统字体（浏览器 zoom 125%）不破版：顶栏、状态栏、文件树不重叠。
4. `prefers-reduced-motion: reduce` 下无动画仍有完整功能。
5. 每个列表区域都有空/加载/错误三态。
6. 1400×900 截图与设计方向一致：文档是主角、协作信号清晰、没有卡片套卡片。
