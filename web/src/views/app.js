// Main workspace view (#/app).
import { api } from "../net/api.js";
import { CollabClient } from "../net/collab.js";
import { FileTree } from "../ui/tree.js";
import { confirmDialog, promptDialog } from "../ui/modal.js";
import { toastError, toastInfo, toastSuccess, toastWarn } from "../ui/toast.js";
import { countWords, el, fmtClock } from "../util/dom.js";
import { createMarkdownEditor } from "../editor/markdown.js";
import { createPreview } from "../editor/preview.js";
import { openSettings } from "./settings.js";

// Monaco (3.4 MiB) loads lazily only for non-Markdown files; first paint uses CodeMirror only.
function isMarkdownPath(path) {
  return /\.(md|markdown)$/i.test(path || "");
}

// Formats the browser shows directly. They are not collaborative documents, so
// they never join a room and never get an editor instance.
const IMAGE_EXTS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
  "svg",
];

function isImagePath(path) {
  const name = String(path || "");
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return false;
  return IMAGE_EXTS.includes(name.slice(idx + 1).toLowerCase());
}

/** Same-origin URL the browser loads the bytes from (cookie auth). */
function rawSrc(path) {
  return `/api/raw?path=${encodeURIComponent(path)}`;
}

const LS = {
  sidebar: "mc.ui.sidebarCollapsed",
  treeW: "mc.ui.treeW",
  rail: "mc.ui.railCollapsed",
  railW: "mc.ui.railW",
  split: "mc.ui.split",
  scrollSync: "mc.ui.scrollSync",
};

const SPLIT_MIN = 0.22;
const SPLIT_MAX = 0.85;
const TREE_MIN = 200;
const TREE_MAX = 460;
const TREE_RAIL = 44;
const RAIL_MIN = 180;
const RAIL_MAX = 420;
const RAIL_RAIL = 44;
// One arrow-key press on the rail handle moves it by this much.
const RAIL_STEP = 16;

function lsGet(key, fallback = null) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function hasPath(nodes, path) {
  for (const node of nodes || []) {
    if (node.path === path) return true;
    if (node.children && hasPath(node.children, path)) return true;
  }
  return false;
}

function parentPath(path) {
  const idx = String(path).lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function baseName(path) {
  const parts = String(path || "").split("/");
  return parts[parts.length - 1] || "";
}

// ---------------------------------------------------------------- icon set
// Stroke icons only: 1.5px, currentColor, aria-hidden. Shell chrome never
// depends on an icon font or on per-file-type colour.

const ICON_PATHS = {
  settings:
    '<path d="M2.6 5.4h10.8M2.6 10.6h10.8" /><circle cx="6.1" cy="5.4" r="1.6" /><circle cx="10.2" cy="10.6" r="1.6" />',
  logout:
    '<path d="M6.2 3.4H4.1c-.6 0-1.1.5-1.1 1.1v7c0 .6.5 1.1 1.1 1.1h2.1" /><path d="M9.3 5.4 11.9 8l-2.6 2.6" /><path d="M11.9 8H6.6" />',
  shield:
    '<path d="M8 2.2 3.6 3.9v3.4c0 2.3 1.7 4.4 4.4 5.6 2.7-1.2 4.4-3.3 4.4-5.6V3.9z" /><path d="M6.1 7.9l1.5 1.4 2.5-2.6" />',
  users:
    '<circle cx="6.2" cy="6" r="2.2" /><path d="M2.5 13.1c0-2 1.7-3.4 3.7-3.4s3.7 1.4 3.7 3.4" /><path d="M10.4 4.1a2 2 0 0 1 0 3.9M11.3 9.8c1.5.4 2.4 1.6 2.4 3.3" />',
  plus: '<path d="M8 3.5v9M3.5 8h9" />',
  "folder-plus":
    '<path d="M2.25 5.4c0-.77.63-1.4 1.4-1.4h2.2c.42 0 .82.19 1.09.51l.71.85h5.9c.77 0 1.4.63 1.4 1.4v4.9c0 .77-.63 1.4-1.4 1.4H3.65c-.77 0-1.4-.63-1.4-1.4z" /><path d="M8 8.5v3M6.5 10h3" />',
  upload:
    '<path d="M8 10.4V3.2" /><path d="M5.2 6 8 3.2 10.8 6" /><path d="M2.8 10.4v1.8c0 .77.63 1.4 1.4 1.4h7.6c.77 0 1.4-.63 1.4-1.4v-1.8" />',
  refresh:
    '<path d="M13.1 8A5.1 5.1 0 1 1 11.5 4.3" /><path d="M13.3 2.7v3.1h-3.1" />',
  "panel-left":
    '<rect x="2.4" y="3.1" width="11.2" height="9.8" rx="1.4" /><path d="M6.4 3.1v9.8" />',
  "panel-right":
    '<rect x="2.4" y="3.1" width="11.2" height="9.8" rx="1.4" /><path d="M9.6 3.1v9.8" />',
  doc: '<path d="M4 2.4h4.7L12 5.7v7.9H4z" /><path d="M8.7 2.4v3.3H12" /><path d="M5.9 8.7h4.2M5.9 10.8h4.2" />',
};

function icon(name, size = 14) {
  return el("span", {
    attrs: { "aria-hidden": "true" },
    style: "display:inline-flex",
    html: `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${
      ICON_PATHS[name] || ICON_PATHS.doc
    }</svg>`,
  });
}

function iconBtn(name, label, onClick, extraClass = "") {
  return el(
    "button",
    {
      class: `icon-btn${extraClass ? ` ${extraClass}` : ""}`,
      attrs: { type: "button", title: label, "aria-label": label },
      on: { click: onClick },
    },
    icon(name, 15),
  );
}

function textBtn(name, label, onClick, extraClass = "") {
  return el(
    "button",
    {
      class: `btn btn-ghost btn-sm${extraClass ? ` ${extraClass}` : ""}`,
      attrs: { type: "button" },
      on: { click: onClick },
    },
    icon(name, 14),
    el("span", { text: label }),
  );
}

/**
 * @param {HTMLElement} host
 * @param {{
 *   user: any,
 *   onLogout: () => void,
 *   onNavigateAdmin: () => void,
 *   onUserUpdate?: (user: any) => void,
 * }} opts
 */
export function mountApp(host, opts) {
  const { user, onLogout, onNavigateAdmin, onUserUpdate } = opts;

  const state = {
    user,
    tree: [],
    currentPath: null,
    imagePath: null,
    editor: null,
    editorObserver: null,
    saveState: "idle",
    saveAt: 0,
    online: 0,
    peers: 0,
    presence: [],
    cursor: null,
    seenPeers: new Set(),
    words: 0,
    treeLoaded: false,
    destroyed: false,
  };

  host.innerHTML = "";
  host.className = "view view-app";

  // ------------------------------------------------------------------ DOM

  const breadcrumb = el(
    "div",
    { class: "breadcrumb" },
    el("span", { class: "crumb-empty", text: "未打开文件" }),
  );

  const connDot = el("span", { class: "conn-dot" });
  const connText = el("span", { class: "conn-text", text: "连接中…" });
  const connBadge = el(
    "span",
    { class: "conn-badge", attrs: { role: "status" } },
    connDot,
    connText,
  );

  const saveDot = el("span", { class: "save-dot" });
  const saveText = el("span", { class: "save-text", text: "已保存" });
  const saveIndicator = el(
    "span",
    { class: "save-indicator", attrs: { role: "status" } },
    saveDot,
    saveText,
  );

  const userDot = el("span", {
    class: "dot",
    style: `background:${state.user.color || "var(--fg-3)"}`,
  });
  const userName = el("span", {
    class: "user-name",
    text: state.user.username,
  });
  const userBadge = el("span", {
    class: `badge badge-${state.user.role === "admin" ? "admin" : "user"}`,
    text: state.user.role,
  });
  const userChip = el(
    "div",
    { class: "user-chip" },
    userDot,
    userName,
    userBadge,
  );

  const settingsBtn = iconBtn("settings", "打开设置", () =>
    openSettingsDialog(),
  );
  const adminBtn = textBtn("shield", "管理后台", () => onNavigateAdmin());
  if (state.user.role !== "admin") adminBtn.style.display = "none";
  const logoutBtn = textBtn("logout", "退出登录", () => doLogout());

  const topbar = el(
    "header",
    { class: "topbar" },
    el(
      "div",
      { class: "topbar-left" },
      el("span", { class: "brand-wordmark", text: "md-coworker" }),
      el("span", { class: "topbar-sep" }),
      breadcrumb,
    ),
    el(
      "div",
      { class: "topbar-right" },
      connBadge,
      saveIndicator,
      userChip,
      settingsBtn,
      adminBtn,
      logoutBtn,
    ),
  );

  // ------------------------------------------------------------------- tree

  const treeHost = el("div", { class: "tree-scroll" });
  const tree = new FileTree(treeHost, {
    onOpen: (path) => openFile(path),
    onRename: (node) => renameEntry(node.path),
    onDelete: (node) => deleteEntry(node.path),
    onRetry: () => reloadTree(true),
    onMove: (move) => moveEntry(move),
  });
  tree.setLoading(true);

  const newFileBtn = iconBtn("plus", "新建文件", () => createEntry("file"));
  const newDirBtn = iconBtn("folder-plus", "新建文件夹", () =>
    createEntry("dir"),
  );
  const refreshBtn = iconBtn("refresh", "刷新文件树", () => reloadTree(true));
  const uploadBtn = iconBtn("upload", "上传文件", () => pickFiles());
  const collapseBtn = iconBtn(
    "panel-left",
    "收起文件树",
    () => toggleSidebar(),
    "rail-toggle",
  );
  const expandBtn = iconBtn(
    "panel-left",
    "展开文件树",
    () => toggleSidebar(),
    "rail-toggle",
  );

  // Hidden picker shared by the toolbar button and Mod+Shift+U. Hidden by class
  // (display:none), never laid out, never in the tab order.
  const uploadInput = el("input", {
    class: "hidden-file",
    attrs: {
      type: "file",
      multiple: "",
      tabindex: "-1",
      "aria-hidden": "true",
      "aria-label": "选择要上传的文件",
    },
    on: {
      change: () => {
        const picked = uploadInput.files ? Array.from(uploadInput.files) : [];
        uploadInput.value = "";
        if (picked.length) beginUpload(picked);
      },
    },
  });

  // One strip under .sidebar-head for the whole batch: name, percent, bar.
  const uploadName = el("span", { class: "upload-progress-name", text: "" });
  const uploadPct = el("span", { class: "upload-progress-pct", text: "0%" });
  const uploadFill = el("div", { class: "upload-progress-fill" });
  const uploadMeta = el("span", { class: "upload-progress-meta", text: "" });
  // Filled after a finished batch: one row per uploaded image, each with an
  // "insert at cursor" action. Empty (and hidden) the rest of the time.
  const uploadResults = el("div", { class: "upload-results" });
  uploadResults.hidden = true;
  const uploadTrack = el(
    "div",
    {
      class: "upload-progress-track",
      attrs: {
        role: "progressbar",
        "aria-label": "上传进度",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": "0",
        "aria-valuetext": "上传进度 0%",
      },
    },
    uploadFill,
  );
  const uploadProgress = el(
    "div",
    {
      class: "upload-progress",
      attrs: { role: "group", "aria-label": "上传进度" },
    },
    el("div", { class: "upload-progress-head" }, uploadName, uploadPct),
    uploadTrack,
    uploadMeta,
    uploadResults,
  );
  uploadProgress.hidden = true;

  const sidebarRail = el(
    "div",
    { class: "sidebar-rail" },
    expandBtn,
    iconBtn("plus", "新建文件", () => createEntry("file")),
    iconBtn("upload", "上传文件", () => pickFiles()),
    iconBtn("refresh", "刷新文件树", () => reloadTree(true)),
  );

  const sidebarResizer = el("div", {
    class: "sidebar-resizer",
    attrs: {
      role: "separator",
      "aria-orientation": "vertical",
      "aria-label": "调整文件树宽度",
      title: "拖拽调整文件树宽度",
    },
  });

  const sidebar = el(
    "aside",
    { class: "sidebar" },
    el(
      "div",
      { class: "sidebar-head" },
      el("span", { class: "sidebar-title", text: "文件" }),
      el(
        "div",
        { class: "sidebar-tools" },
        uploadBtn,
        newFileBtn,
        newDirBtn,
        refreshBtn,
        collapseBtn,
      ),
    ),
    uploadProgress,
    uploadInput,
    el("div", { class: "sidebar-body" }, treeHost),
    sidebarRail,
    sidebarResizer,
  );

  // ---------------------------------------------------------------- editors

  const editorHost = el("div", { class: "editor-host" });
  const editorEmpty = el(
    "div",
    { class: "pane-empty" },
    el(
      "div",
      { class: "pane-empty-inner" },
      el("span", { class: "pane-empty-icon" }, icon("doc", 28)),
      el("span", { class: "pane-empty-title", text: "还没有打开文件" }),
      el("span", {
        class: "pane-empty-hint",
        text: "从左侧文件树选一个文件；没有文件就用上方 新建文件 创建第一个 .md",
      }),
    ),
  );
  const editorMeta = el("span", { class: "pane-meta", text: "" });
  const editorPane = el(
    "section",
    { class: "pane pane-editor" },
    el(
      "div",
      { class: "pane-head" },
      el("span", { class: "pane-title", text: "编辑" }),
      editorMeta,
    ),
    el("div", { class: "pane-body" }, editorHost, editorEmpty),
  );

  const previewHost = el("div", { class: "preview-host markdown-body" });
  const previewMeta = el("span", { class: "pane-meta", text: "" });
  const syncToggle = el("button", {
    class: "chip-toggle is-on",
    attrs: { type: "button", title: "切换预览滚动同步" },
    text: "滚动同步",
    on: { click: () => toggleScrollSync() },
  });
  const previewPane = el(
    "section",
    { class: "pane pane-preview" },
    el(
      "div",
      { class: "pane-head" },
      el("span", { class: "pane-title", text: "预览" }),
      previewMeta,
      syncToggle,
    ),
    el("div", { class: "pane-body" }, previewHost),
  );

  // Image files get a viewer instead of an editor: no room is joined, nothing
  // is editable, and the two text panes make way for it.
  const imageImg = el("img", {
    class: "image-img",
    attrs: { alt: "", decoding: "async" },
  });
  const imageError = el("p", { class: "image-error", text: "" });
  imageError.hidden = true;
  const imageStage = el("div", { class: "image-stage" }, imageImg, imageError);
  const imageTitle = el("span", { class: "pane-title", text: "图片" });
  const imageMeta = el("span", { class: "pane-meta", text: "" });
  const imageName = el("span", { class: "image-name", text: "" });
  const imageSize = el("span", { class: "image-size", text: "" });
  const imageDims = el("span", { class: "image-dims", text: "" });
  const imageOpen = el("a", {
    class: "image-open",
    text: "单独打开",
    attrs: {
      href: "#",
      target: "_blank",
      rel: "noopener",
      title: "在新标签页打开原图",
    },
  });
  const imageCaption = el(
    "div",
    { class: "image-caption" },
    el("span", { class: "image-facts" }, imageName, imageSize, imageDims),
    el("span", { class: "image-note", text: "图片文件不支持协作编辑" }),
    imageOpen,
  );
  const imagePane = el(
    "section",
    { class: "pane pane-image" },
    el("div", { class: "pane-head" }, imageTitle, imageMeta),
    el("div", { class: "pane-body" }, imageStage, imageCaption),
  );
  imagePane.hidden = true;

  imageImg.addEventListener("load", () => {
    imageError.hidden = true;
    imageImg.hidden = false;
    const w = imageImg.naturalWidth;
    const h = imageImg.naturalHeight;
    imageDims.textContent = w && h ? `${w} × ${h} px` : "";
  });

  imageImg.addEventListener("error", () => {
    imageImg.hidden = true;
    imageError.hidden = false;
    imageError.textContent = `图片无法加载：${state.imagePath || "这个文件"}。它可能刚被移动或删除，刷新文件树后再点一次。`;
  });

  const splitter = el("div", {
    class: "splitter",
    attrs: { role: "separator", "aria-orientation": "vertical" },
  });
  const center = el(
    "div",
    { class: "center" },
    editorPane,
    splitter,
    previewPane,
    imagePane,
  );

  // ------------------------------------------------------------ collab panel

  const collabCount = el(
    "span",
    { class: "collab-count" },
    "在线 ",
    el("span", { class: "collab-count-num", text: "0" }),
    " 人",
  );
  const presenceList = el("div", { class: "collab-list" });

  // You are always in the rail — the list is never empty, and your own
  // cursor position updates live in the same row shape as everyone else's.
  const selfCursor = el("span", { class: "peer-cursor", text: "行 1, 列 1" });
  const selfFile = el("span", { class: "peer-file", text: "未打开文件" });
  const selfRow = el(
    "div",
    { class: "peer-row is-me" },
    el("span", {
      class: "peer-dot",
      style: `background:${state.user.color || "var(--fg-3)"}`,
    }),
    el(
      "span",
      { class: "peer-name" },
      state.user.username,
      el("span", { class: "peer-tag", text: "你" }),
    ),
    selfCursor,
    selfFile,
  );
  // Collapsing turns the rail into a 44px strip of people — the same shape as
  // the sidebar rail: dots now, names on hover.
  const railPeers = el("div", { class: "collab-rail-peers" });
  const railCountText = el("span", { class: "collab-rail-count", text: "1" });
  const collapseRailBtn = iconBtn(
    "panel-right",
    "收起协作栏",
    () => toggleRail(),
    "rail-toggle",
  );
  const expandRailBtn = iconBtn(
    "panel-right",
    "展开协作栏",
    () => toggleRail(),
    "rail-toggle",
  );
  const collabRail = el(
    "div",
    { class: "collab-rail" },
    expandRailBtn,
    railPeers,
    railCountText,
  );

  // Left-edge handle, the mirror image of .sidebar-resizer.
  const collabResizer = el("div", {
    class: "collab-resizer",
    attrs: {
      role: "separator",
      "aria-orientation": "vertical",
      "aria-label": "调整协作栏宽度",
      "aria-valuemin": String(RAIL_MIN),
      "aria-valuemax": String(RAIL_MAX),
      "aria-valuenow": String(RAIL_MIN),
      tabindex: "0",
      title: "拖拽调整协作栏宽度，双击恢复默认",
    },
  });

  const collabPanel = el(
    "aside",
    { class: "collab-panel" },
    el(
      "div",
      { class: "collab-head" },
      el("span", { class: "collab-title", text: "协作" }),
      collabCount,
      collapseRailBtn,
    ),
    presenceList,
    collabRail,
    collabResizer,
  );

  // -------------------------------------------------------------- status bar

  const statusCursor = el("span", { class: "status-item", text: "行 1, 列 1" });
  const statusWords = el("span", { class: "status-item", text: "0 字" });
  const statusOnline = el("span", { class: "status-item", text: "在线 0 人" });
  const statusFile = el("span", { class: "status-path", text: "" });
  const statusSave = el("span", { class: "status-item", text: "已保存" });
  const statusbar = el(
    "footer",
    { class: "statusbar" },
    statusFile,
    el(
      "div",
      { class: "status-right" },
      statusCursor,
      statusWords,
      statusOnline,
      statusSave,
    ),
  );

  // Full-window drop target: a scrim plus the destination, nothing more.
  // position:fixed keeps it out of .app-shell's grid rows.
  const dropTarget = el("span", { class: "drop-target", text: "工作区根目录" });
  const dropLimit = el("span", { class: "drop-limit", text: "" });
  const dropOverlay = el(
    "div",
    { class: "drop-overlay", attrs: { "aria-hidden": "true" } },
    el(
      "div",
      { class: "drop-zone" },
      el("span", { class: "drop-icon" }, icon("upload", 24)),
      el("span", { class: "drop-title" }, "松手上传到 ", dropTarget),
      dropLimit,
    ),
  );
  dropOverlay.hidden = true;

  const shell = el(
    "div",
    { class: "app-shell" },
    topbar,
    el("div", { class: "app-body" }, sidebar, center, collabPanel),
    statusbar,
  );
  shell.append(dropOverlay);
  host.append(shell);

  // ------------------------------------------------------------ collab setup

  const collab = new CollabClient({
    user: state.user,
    onStatus: (status) => {
      if (status === "open") {
        connText.textContent = "已连接";
        connBadge.classList.add("is-online");
        connBadge.classList.remove("is-offline");
      } else if (status === "connecting") {
        connText.textContent = "连接中…";
        connBadge.classList.remove("is-online", "is-offline");
      } else {
        connText.textContent = "已断开";
        connBadge.classList.add("is-offline");
        connBadge.classList.remove("is-online");
      }
    },
    onPresence: (users) => renderPresence(users),
    onPeers: (path, count) => {
      if (path === state.currentPath) {
        state.peers = count;
        renderStatus();
      }
    },
    onSaved: (path, ts) => {
      if (path !== state.currentPath) return;
      if (saveFallbackTimer) {
        clearTimeout(saveFallbackTimer);
        saveFallbackTimer = null;
      }
      state.saveState = "saved";
      state.saveAt = ts;
      renderSave();
    },
    onError: (message) => toastError(message),
  });

  // ------------------------------------------------------------- preview api

  let scrollSyncOn = lsGet(LS.scrollSync, "1") !== "0";

  // Each pane suppresses the echo of its own programmatic writes, so positions
  // can be handed back and forth without an echo loop — and without a lock,
  // which would otherwise swallow the reader's next scroll on the other side.
  const preview = createPreview({
    container: previewHost,
    onScroll: ({ line }) => {
      if (!scrollSyncOn || !state.editor) return;
      if (!isMarkdownPath(state.currentPath)) return;
      if (typeof state.editor.scrollToLine !== "function") return;
      state.editor.scrollToLine(line);
    },
  });

  function renderSyncToggle() {
    syncToggle.classList.toggle("is-on", scrollSyncOn);
    syncToggle.textContent = scrollSyncOn ? "滚动同步" : "同步已关";
  }
  renderSyncToggle();

  function toggleScrollSync() {
    scrollSyncOn = !scrollSyncOn;
    lsSet(LS.scrollSync, scrollSyncOn ? "1" : "0");
    renderSyncToggle();
    toastInfo(scrollSyncOn ? "已开启预览滚动同步" : "已关闭预览滚动同步");
  }

  // ------------------------------------------------------------------ tree IO

  async function reloadTree(notify = false) {
    if (!state.treeLoaded) tree.setLoading(true);
    try {
      const data = await api.files();
      state.tree = Array.isArray(data.tree) ? data.tree : [];
      state.treeLoaded = true;
      tree.setTree(state.tree);
      paintTreePresence();
      if (notify) toastSuccess("文件列表已刷新");
    } catch (err) {
      tree.setError(err.message || "无法加载文件列表");
      toastError(err.message || "文件树加载失败，请检查网络后重试");
    }
  }

  async function createEntry(kind) {
    const dir = state.currentPath ? parentPath(state.currentPath) : "";
    const result = await promptDialog({
      title: kind === "file" ? "新建文件" : "新建文件夹",
      subtitle: "路径相对于工作区根目录",
      label: kind === "file" ? "文件路径" : "文件夹路径",
      value: dir ? `${dir}/` : "",
      placeholder: kind === "file" ? "notes/todo.md" : "notes",
      confirmLabel: "创建",
      validate: (value) => {
        const path = value.trim().replace(/^\/+/, "");
        if (!path) return "请输入路径";
        if (path.includes("..")) return "路径不能包含 ..";
        if (kind === "file" && path.endsWith("/"))
          return "文件路径不能以 / 结尾";
        return null;
      },
    });
    if (result === null) return;
    const path = result.trim().replace(/^\/+/, "");
    try {
      await api.createEntry(path, kind, kind === "file" ? "" : "");
      await reloadTree();
      if (kind === "file") await openFile(path);
      toastSuccess(kind === "file" ? `已创建 ${path}` : `已创建文件夹 ${path}`);
    } catch (err) {
      toastError(err.message || "创建失败，请换一个路径后重试");
    }
  }

  async function renameEntry(path) {
    const result = await promptDialog({
      title: "重命名",
      subtitle: "可以连同目录一起移动",
      label: "新路径",
      value: path,
      confirmLabel: "重命名",
      validate: (value) => {
        const next = value.trim().replace(/^\/+/, "");
        if (!next) return "请输入新路径";
        if (next.includes("..")) return "路径不能包含 ..";
        if (next === path) return "新路径与原路径相同";
        return null;
      },
    });
    if (result === null) return;
    const next = result.trim().replace(/^\/+/, "");
    const openPath = await releaseOpenRoom(path);
    try {
      await api.renameEntry(path, next);
      if (openPath) {
        await reloadTree();
        await openFile(movedPath(openPath, path, next)).catch(() => {});
      } else {
        collab.dropSession(path);
        await reloadTree();
      }
      toastSuccess("重命名完成");
    } catch (err) {
      if (openPath) await openFile(openPath).catch(() => {});
      toastError(err.message || "重命名失败，请检查目标路径是否已存在");
    }
  }

  async function deleteEntry(path) {
    const ok = await confirmDialog({
      title: "删除文件",
      message: `确定删除 ${path} 吗？目录会被递归删除，此操作不可撤销。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteEntry(path);
      const affected =
        state.currentPath === path ||
        (state.currentPath || "").startsWith(`${path}/`);
      if (affected) {
        collab.dropSession(state.currentPath);
        await closeEditor();
        state.currentPath = null;
        renderBreadcrumb();
        renderStatus();
      }
      collab.dropSession(path);
      await reloadTree();
      toastSuccess("已删除");
    } catch (err) {
      toastError(err.message || "删除失败，请确认文件是否仍存在");
    }
  }

  /**
   * Drag-and-drop move. The tree computes source and destination; the server
   * treats a move as a rename, so this is the same call as 重命名 — only the
   * copy differs. Failures stay specific: every code says what to do next.
   */
  /** Sleep helper for the room-release handshake. */
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * The server refuses to rename/move a path while a collaboration room is open
   * on it — and that room is usually ours, because we have the file open. So the
   * editor steps out first: the content is already saved server-side, and the
   * caller re-opens the new path afterwards.
   * @returns {string} the path that was open, or "" when nothing was.
   */
  async function releaseOpenRoom(path) {
    const openPath = state.currentPath || "";
    if (!openPath) return "";
    if (openPath !== path && !openPath.startsWith(`${path}/`)) return "";
    collab.dropSession(openPath);
    await closeEditor();
    state.currentPath = null;
    renderBreadcrumb();
    renderStatus();
    await pause(150);
    return openPath;
  }

  /** Where an open file ends up when its path (or an ancestor) moves. */
  function movedPath(openPath, from, to) {
    return openPath === from ? to : to + openPath.slice(from.length);
  }

  /**
   * Drag-and-drop move. The tree computes source and destination; the server
   * treats a move as a rename, so this is the same call as 重命名 — only the
   * copy differs. Failures stay specific: every code says what to do next.
   */
  async function moveEntry(move) {
    if (!move) return;
    const from = move.from;
    const to = move.to;
    if (!from || !to || from === to) return;

    const openPath = await releaseOpenRoom(from);
    let error = null;
    // One retry: the room release is a websocket message, and the server only
    // clears `file_busy` once it lands.
    for (let attempt = 0; attempt < 2 && !error; attempt += 1) {
      try {
        await api.renameEntry(from, to);
        error = null;
        break;
      } catch (err) {
        error = err;
        if (!(err && err.code === "file_busy" && openPath && attempt === 0))
          break;
        await pause(300);
      }
    }

    if (error) {
      const code = error.code;
      if (code === "file_exists")
        toastError("目标文件夹里已经有同名文件，先改名再移动");
      else if (code === "file_busy")
        toastError("这个文件正在被别人编辑，等所有人离开后再移动");
      else if (code === "bad_path")
        toastError("不能把文件夹移动到它自己或它的子文件夹里");
      else if (code === "file_not_found")
        toastError("文件已经不在了，刷新文件树后再试一次");
      else toastError(error.message ? error.message : "移动失败，请稍后重试");
      await reloadTree();
      if (openPath) await openFile(openPath).catch(() => {});
      return;
    }

    if (openPath) {
      await reloadTree();
      await openFile(movedPath(openPath, from, to)).catch(() => {});
    } else {
      collab.dropSession(from);
      await reloadTree();
      tree.setSelected(to);
    }

    const dir = parentPath(to);
    toastSuccess(dir ? `已移动到「${dir}/」` : "已移动到工作区根目录");
  }

  // ---------------------------------------------------------------- upload IO

  const MAX_UPLOAD_BATCH = 20;
  // 0 means "unknown": the settings read failed, so we never pre-check and let
  // the server's 413 speak for itself. Silent degrade, never a blocked upload.
  let maxUploadBytes = 0;
  let uploading = false;
  let uploadToken = 0;
  // Auto-hide timer for the "insert at cursor" result rows, plus the batch they
  // describe so the rows can be re-evaluated when a different file is opened.
  let uploadResultsTimer = 0;
  let uploadResultsBatch = [];
  let uploadResultsLive = false;
  // dragenter/dragleave fire once per element crossed, so they are counted
  // rather than toggled; the overlay only leaves at zero.
  let dragDepth = 0;

  function trimNum(value) {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  /** Human readable size: 10 MiB, 1.5 MiB, 512 KiB — binary units, spelled MiB. */
  function fmtBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024 * 1024)
      return `${trimNum(n / (1024 * 1024 * 1024))} GiB`;
    if (n >= 1024 * 1024) return `${trimNum(n / (1024 * 1024))} MiB`;
    if (n >= 1024) return `${trimNum(n / 1024)} KiB`;
    return `${n} B`;
  }

  /** Root has no path, so it needs a name of its own in copy. */
  function dirLabel(dir) {
    return dir ? dir : "工作区根目录";
  }

  function findTreeNode(nodes, path) {
    for (const node of nodes || []) {
      if (node.path === path) return node;
      if (node.children) {
        const hit = findTreeNode(node.children, path);
        if (hit) return hit;
      }
    }
    return null;
  }

  /**
   * Selected file → its parent folder; selected folder → itself; nothing
   * selected → workspace root ('').
   */
  function uploadTargetDir() {
    const selected = tree.getSelected ? tree.getSelected() : state.currentPath;
    if (!selected) return "";
    const node = findTreeNode(state.tree, selected);
    if (node && node.kind === "dir") return selected;
    return parentPath(selected);
  }

  function pickFiles() {
    if (state.destroyed) return;
    if (uploading) {
      toastInfo("正在上传，请等这次上传完成");
      return;
    }
    uploadInput.value = "";
    uploadInput.click();
  }

  /** True only for OS file drags, so splitter/row dragging is untouched. */
  function isFileDrag(ev) {
    const dt = ev && ev.dataTransfer;
    if (!dt || !dt.types) return false;
    const types = dt.types;
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === "Files") return true;
    }
    return false;
  }

  function paintDropOverlay() {
    dropTarget.textContent = dirLabel(uploadTargetDir());
    const batchNote = `一次最多 ${MAX_UPLOAD_BATCH} 个文件`;
    dropLimit.textContent =
      maxUploadBytes > 0
        ? `单个文件上限 ${fmtBytes(maxUploadBytes)} · ${batchNote}`
        : batchNote;
  }

  function showDropOverlay() {
    paintDropOverlay();
    if (!dropOverlay.hidden) return;
    dropOverlay.hidden = false;
    dropOverlay.setAttribute("aria-hidden", "false");
  }

  function hideDropOverlay() {
    dragDepth = 0;
    if (dropOverlay.hidden) return;
    dropOverlay.hidden = true;
    dropOverlay.setAttribute("aria-hidden", "true");
  }

  function showUploadProgress(name, percent, index, count, dir) {
    const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    const position =
      count > 1 ? `正在上传 ${Math.min(index, count)}/${count} · ${pct}%` : "";
    // A new batch invalidates the previous batch's insert actions.
    clearUploadResults();
    uploadProgress.hidden = false;
    uploadName.textContent = name;
    uploadName.title = name;
    uploadPct.textContent = `${pct}%`;
    uploadFill.style.transform = `scaleX(${(pct / 100).toFixed(3)})`;
    uploadTrack.setAttribute("aria-valuenow", String(pct));
    uploadTrack.setAttribute(
      "aria-valuetext",
      position || `正在上传 ${name} ${pct}%`,
    );
    uploadMeta.textContent = position || `上传到 ${dirLabel(dir)}`;
  }

  function hideUploadProgress() {
    uploadProgress.hidden = true;
    clearUploadResults();
    uploadFill.style.transform = "scaleX(0)";
    uploadTrack.setAttribute("aria-valuenow", "0");
    uploadTrack.setAttribute("aria-valuetext", "上传进度 0%");
  }

  /**
   * `assets/x.png` seen from `notes/a.md` is `../assets/x.png`; from a document
   * in the workspace root it stays `assets/x.png`. Pure string work on `/`.
   */
  function relativeToDoc(docPath, targetPath) {
    const docDirs = String(docPath || "")
      .split("/")
      .slice(0, -1);
    const target = String(targetPath || "").split("/");
    let shared = 0;
    while (
      shared < docDirs.length &&
      shared < target.length - 1 &&
      docDirs[shared] === target[shared]
    ) {
      shared += 1;
    }
    const parts = [];
    for (let i = shared; i < docDirs.length; i += 1) parts.push("..");
    parts.push(...target.slice(shared));
    return parts.join("/");
  }

  /** A markdown document with a live editor is the only place an image can go. */
  function canInsertAtCursor() {
    return Boolean(
      isMarkdownPath(state.currentPath) &&
      state.editor &&
      typeof state.editor.insertAtCursor === "function",
    );
  }

  /** @param {string} path */
  function insertImageRef(path) {
    if (!canInsertAtCursor()) {
      toastError("插入需要先打开一个 Markdown 文档，现在没有可编辑的文件");
      return false;
    }
    const rel = relativeToDoc(state.currentPath, path);
    const ok = state.editor.insertAtCursor(`![](${rel})\n`);
    if (!ok) {
      toastError("当前没有可编辑的光标位置");
      return false;
    }
    toastSuccess("已插入图片引用");
    return true;
  }

  function clearUploadResults() {
    if (uploadResultsTimer) {
      clearTimeout(uploadResultsTimer);
      uploadResultsTimer = 0;
    }
    uploadResultsLive = false;
    uploadResultsBatch = [];
    uploadResults.innerHTML = "";
    uploadResults.hidden = true;
  }

  /** The open document decides whether "插入到光标" is offerable at all. */
  function refreshUploadResults() {
    if (!uploadResultsLive && uploadResultsBatch.length === 0) return;
    renderUploadResults(uploadResultsBatch);
  }

  /** @param {any[]} uploaded */
  function renderUploadResults(uploaded) {
    clearUploadResults();
    const images = (uploaded || []).filter(
      (item) => item && item.path && isImagePath(item.path),
    );
    if (!images.length) return;
    uploadResultsBatch = uploaded;
    uploadResultsLive = true;
    const insertable = canInsertAtCursor();
    for (const image of images) {
      const name = baseName(image.path);
      let size = image.size;
      if (typeof size !== "number") {
        const node = tree.findNode(image.path);
        size = node && node.size;
      }
      const insertBtn = el("button", {
        class: "btn btn-sm btn-ghost upload-insert",
        text: "插入到光标",
        attrs: {
          type: "button",
          title: insertable
            ? `把 ![](${relativeToDoc(state.currentPath, image.path)}) 插入到光标处`
            : "先打开一个 Markdown 文档，再把这张图片插进去",
        },
        on: {
          click: () => {
            if (insertBtn.disabled) return;
            const ok = insertImageRef(image.path);
            if (!ok) return;
            insertBtn.textContent = "已插入";
            insertBtn.classList.add("is-done");
            insertBtn.disabled = true;
          },
        },
      });
      if (!insertable) insertBtn.style.display = "none";
      uploadResults.append(
        el(
          "div",
          { class: "upload-result" },
          el("span", {
            class: "upload-result-name",
            text: name,
            attrs: { title: image.path },
          }),
          el("span", {
            class: "upload-result-size",
            text: typeof size === "number" && size > 0 ? fmtBytes(size) : "",
          }),
          insertBtn,
        ),
      );
    }
    uploadResults.hidden = false;
    uploadResultsTimer = setTimeout(() => {
      uploadResultsTimer = 0;
      hideUploadProgress();
    }, 45000);
  }

  /**
   * Batch finished: keep the strip on screen only when there is an image to
   * insert, and let it fade out on its own after a while.
   */
  function showUploadSettled(dir, uploaded) {
    uploadName.textContent = "上传完成";
    uploadName.title = "";
    uploadPct.textContent = "";
    uploadFill.style.transform = "scaleX(1)";
    uploadTrack.setAttribute("aria-valuenow", "100");
    uploadTrack.setAttribute(
      "aria-valuetext",
      `上传完成，已上传 ${uploaded.length} 个文件`,
    );
    uploadMeta.textContent = `已上传 ${uploaded.length} 个文件到${dirLabel(dir)}`;
    uploadProgress.hidden = false;
    renderUploadResults(uploaded);
    if (uploadResults.hidden) hideUploadProgress();
  }

  /**
   * Upload a FileList/array into the current target directory.
   * Oversized files are skipped one by one (with their own toast) so a single
   * 200 MiB attachment never sinks the rest of the drop. Server-side limits stay
   * authoritative: any 413 that slips through is reported per batch.
   */
  async function beginUpload(fileList, dirOverride) {
    if (state.destroyed) return;
    const picked = Array.from(fileList || []).filter(Boolean);
    if (!picked.length) return;
    if (uploading) {
      toastWarn("已有上传在进行中，请等这次上传完成");
      return;
    }
    const dir =
      typeof dirOverride === "string" ? dirOverride : uploadTargetDir();

    const accepted = [];
    for (const file of picked) {
      if (maxUploadBytes > 0 && file.size > maxUploadBytes) {
        toastWarn(
          `${file.name} 超过 ${fmtBytes(maxUploadBytes)} 上限，已跳过`,
          5200,
        );
        continue;
      }
      accepted.push(file);
    }
    if (!accepted.length) return;

    uploading = true;
    const token = ++uploadToken;
    const totalBytes =
      accepted.reduce((sum, file) => sum + (file.size || 0), 0) || 1;
    const uploaded = [];
    let sentBytes = 0;
    let cancelled = false;

    try {
      for (let start = 0; start < accepted.length; start += MAX_UPLOAD_BATCH) {
        const batch = accepted.slice(start, start + MAX_UPLOAD_BATCH);
        const batchBytes = batch.reduce(
          (sum, file) => sum + (file.size || 0),
          0,
        );
        const label =
          batch.length === 1
            ? batch[0].name
            : `${batch[0].name} 等 ${batch.length} 个文件`;
        const base = sentBytes;
        const paint = (loaded) => {
          if (token !== uploadToken) return;
          const done = Math.min(
            totalBytes,
            base + Math.max(0, Number(loaded) || 0),
          );
          showUploadProgress(
            label,
            (done / totalBytes) * 100,
            start + 1,
            accepted.length,
            dir,
          );
        };
        paint(0);

        let payload;
        try {
          payload = await api.upload(dir, batch, { onProgress: paint });
        } catch (err) {
          if (!err || err.code !== "file_exists") throw err;
          const conflictPath = dir ? `${dir}/${batch[0].name}` : batch[0].name;
          const overwrite = await confirmDialog({
            title: "同名文件已存在",
            message:
              batch.length > 1
                ? `${conflictPath} 等 ${batch.length} 个文件已存在，覆盖它们吗？`
                : `${conflictPath} 已存在，覆盖它吗？`,
            confirmLabel: "覆盖",
            cancelLabel: "放弃上传",
            danger: true,
          });
          if (!overwrite) {
            cancelled = true;
            break;
          }
          paint(0);
          payload = await api.upload(dir, batch, {
            overwrite: true,
            onProgress: paint,
          });
        }
        const list =
          payload && Array.isArray(payload.files) ? payload.files : [];
        uploaded.push(...list);
        sentBytes += batchBytes;
      }
    } catch (err) {
      if (token === uploadToken) {
        const code = err && err.code;
        if (code === "too_many_files")
          toastError("一次最多上传 20 个文件，请分批上传");
        else if (code === "bad_filename")
          toastError(
            "文件名不合法：不能以 . 开头，也不能含空字符，请改名后重试",
          );
        else if (code === "file_busy")
          toastError("目标文件正在被协作编辑，请等所有人离开后再试");
        else if (code === "too_large")
          toastError(
            err.message ||
              (maxUploadBytes > 0
                ? `单个文件不能超过 ${fmtBytes(maxUploadBytes)}`
                : "文件太大，无法上传"),
          );
        else
          toastError(err && err.message ? err.message : "上传失败，请稍后重试");
      }
      return;
    } finally {
      uploading = false;
      // A finished batch with images may still offer "插入到光标"; everything
      // else clears the strip right away.
      if (!uploaded.some((item) => item && item.path && isImagePath(item.path)))
        hideUploadProgress();
    }

    if (token !== uploadToken || state.destroyed) return;
    if (!uploaded.length) {
      if (cancelled) toastInfo("已放弃上传");
      else toastWarn("上传结束，但没有文件被保存");
      return;
    }

    await reloadTree(true);
    if (cancelled) {
      toastInfo(`已上传 ${uploaded.length} 个文件，其余已放弃`);
      return;
    }
    const firstMarkdown = uploaded.find((item) => isMarkdownPath(item.path));
    if (firstMarkdown && !state.destroyed) {
      try {
        await openFile(firstMarkdown.path);
      } catch {
        /* 树已刷新，打开失败不影响上传结果 */
      }
    }
    toastSuccess(
      `已上传 ${uploaded.length} 个文件到${dir ? `「${dir}」` : "工作区根目录"}`,
    );
    // Offer the image references once the tree and the document settled, so the
    // relative path matches what is actually open.
    showUploadSettled(dir, uploaded);
  }

  // ------------------------------------------------------------------ editor

  async function closeEditor() {
    hideImageViewer();
    if (state.editorObserver) {
      const { ytext, fn } = state.editorObserver;
      try {
        ytext.unobserve(fn);
      } catch {
        /* ignore */
      }
      state.editorObserver = null;
    }
    if (state.editor) {
      try {
        state.editor.destroy();
      } catch (err) {
        console.warn("[app] editor destroy failed", err);
      }
      state.editor = null;
    }
    editorHost.innerHTML = "";
    editorEmpty.style.display = "";
    previewMeta.textContent = "";
    if (preview.setBasePath) preview.setBasePath("");
    preview.renderEmpty("无可预览内容", "打开一个 Markdown 文件即可实时预览");
  }

  function setEditorMeta(text) {
    editorMeta.textContent = text || "";
  }

  /** @param {string} path */
  function showImageViewer(path) {
    const name = baseName(path);
    const node = tree.findNode(path);
    const src = rawSrc(path);
    state.imagePath = path;
    imageTitle.textContent = name;
    imageTitle.title = path;
    imageMeta.textContent = "图片";
    imageName.textContent = name;
    imageSize.textContent =
      node && typeof node.size === "number" && node.size > 0
        ? fmtBytes(node.size)
        : "";
    imageDims.textContent = "";
    imageError.hidden = true;
    imageError.textContent = "";
    imageImg.hidden = false;
    imageImg.alt = name;
    imageImg.title = name;
    imageImg.src = src;
    imageOpen.href = src;
    imageOpen.title = `在新标签页打开 ${name}`;
    imagePane.hidden = false;
    center.classList.add("has-image");
    // No line/column for a picture, and no word count either.
    statusCursor.textContent = "图片";
    statusWords.hidden = true;
    selfCursor.textContent = "—";
  }

  function hideImageViewer() {
    if (!state.imagePath && imagePane.hidden) return;
    state.imagePath = null;
    imagePane.hidden = true;
    imageImg.removeAttribute("src");
    center.classList.remove("has-image");
    statusCursor.textContent = "行 1, 列 1";
    statusWords.hidden = false;
  }

  /** @param {string} path */
  async function openImage(path) {
    if (state.currentPath === path && state.imagePath === path) {
      tree.setCurrent(path);
      return;
    }
    const previous = state.currentPath;
    tree.setCurrent(path);
    // Re-rendering the tree drops the presence dots; put them back immediately.
    paintTreePresence();
    if (previous && previous !== path) collab.leaveFile(previous);
    await closeEditor();

    state.currentPath = path;
    state.saveState = "idle";
    state.cursor = null;
    state.words = 0;
    renderBreadcrumb();
    // Paint the viewer first: renderStatus() reads state.imagePath for its copy.
    showImageViewer(path);
    renderStatus();
    refreshUploadResults();
  }

  /** @param {string} path */
  async function openFile(path) {
    if (!path) return;
    if (isImagePath(path)) {
      await openImage(path);
      return;
    }
    hideImageViewer();
    if (state.currentPath === path && state.editor) {
      tree.setCurrent(path);
      return;
    }
    const previous = state.currentPath;
    tree.setCurrent(path);
    // Re-rendering the tree drops the presence dots; put them back immediately.
    paintTreePresence();

    if (previous && previous !== path) collab.leaveFile(previous);
    await closeEditor();

    state.currentPath = path;
    state.saveState = "idle";
    renderBreadcrumb();
    renderStatus();

    let session;
    try {
      const joined = await collab.joinFile(path);
      session = joined.session;
      if (joined.timedOut) {
        toastWarn("实时会话连接较慢，正在继续尝试同步…");
      }
    } catch (err) {
      toastError(err.message || "无法打开文件，请稍后重试");
      return;
    }
    if (state.destroyed || state.currentPath !== path) return;

    const ytext = session.ydoc.getText("content");
    const md = isMarkdownPath(path);
    editorEmpty.style.display = "none";
    previewMeta.textContent = md ? "gfm · 只读" : baseName(path);

    try {
      if (md) {
        state.editor = createMarkdownEditor({
          parent: editorHost,
          ytext,
          awareness: session.awareness,
          onCursor: (pos) => {
            renderCursor(pos);
            collab.reportPresence(pos, 0);
          },
          onScroll: ({ line }) => {
            if (!scrollSyncOn) return;
            preview.scrollToLine(line);
          },
          onDocChange: () => markSaving(),
        });
      } else {
        const { createCodeEditor } = await import("../editor/code.js");
        state.editor = createCodeEditor({
          parent: editorHost,
          path,
          ytext,
          awareness: session.awareness,
          onCursor: (pos) => {
            renderCursor(pos);
            collab.reportPresence(pos, 0);
          },
        });
      }
    } catch (err) {
      console.error("[app] editor init failed", err);
      toastError("编辑器初始化失败，请刷新页面重试");
      return;
    }

    collab.setCurrentPath(path);
    setEditorMeta(
      md ? "CodeMirror · Markdown" : `Monaco · ${path.split(".").pop()}`,
    );

    // Relative image paths (![](assets/x.png)) resolve against the open
    // document; a non-markdown file gets no base, its preview is plain text.
    if (preview.setBasePath) preview.setBasePath(md ? path : "");

    // Realtime preview / word count from the shared text.
    const updateText = () => {
      const text = ytext.toString();
      if (md) preview.render(text);
      else
        preview.renderPlain(
          text.length > 400000
            ? `${text.slice(0, 400000)}\n\n… 文件过大，仅显示前 400000 个字符`
            : text,
          `${path}（只读预览）`,
        );
      state.words = countWords(text);
      renderWords();
    };
    const observer = (event, transaction) => {
      if (transaction && transaction.origin !== "remote") markSaving();
      updateText();
    };
    ytext.observe(observer);
    state.editorObserver = { ytext, fn: observer };

    if (md) preview.renderNow(ytext.toString());
    else updateText();

    const pos = state.editor.cursor
      ? state.editor.cursor()
      : { line: 0, ch: 0 };
    renderCursor(pos);
    collab.reportPresence(pos, 0);
    refreshUploadResults();
    renderStatus();
  }

  let saveFallbackTimer = null;
  function markSaving() {
    state.saveState = "saving";
    renderSave();
    // Safety net: never leave the indicator spinning if the server stays silent.
    if (saveFallbackTimer) clearTimeout(saveFallbackTimer);
    saveFallbackTimer = setTimeout(() => {
      saveFallbackTimer = null;
      if (state.saveState !== "saving") return;
      state.saveState = "saved";
      state.saveAt = state.saveAt || Date.now();
      renderSave();
    }, 2500);
  }

  // ---------------------------------------------------------------- rendering

  function renderBreadcrumb() {
    breadcrumb.innerHTML = "";
    if (!state.currentPath) {
      breadcrumb.append(
        el("span", { class: "crumb-empty", text: "未打开文件" }),
      );
      statusFile.textContent = "";
      return;
    }
    const parts = state.currentPath.split("/");
    parts.forEach((part, index) => {
      const isLast = index === parts.length - 1;
      breadcrumb.append(
        el("span", {
          class: `crumb${isLast ? " crumb-current" : ""}`,
          text: part,
        }),
      );
      if (!isLast)
        breadcrumb.append(el("span", { class: "crumb-sep", text: "/" }));
    });
    statusFile.textContent = state.currentPath;
  }

  function renderSave() {
    const saving = state.saveState === "saving";
    saveDot.className = `save-dot${saving ? " is-saving" : " is-saved"}`;
    saveText.textContent = saving ? "保存中…" : "已保存";
    saveIndicator.title = state.saveAt
      ? `最后保存 ${fmtClock(state.saveAt)}`
      : "编辑内容已实时保存";
    statusSave.textContent = saving ? "保存中…" : "已保存";
    statusSave.title = state.saveAt
      ? `最后保存 ${fmtClock(state.saveAt)}`
      : "编辑内容已实时保存";
  }

  function renderCursor(pos) {
    if (!pos) return;
    state.cursor = pos;
    const label = `行 ${pos.line + 1}, 列 ${pos.ch + 1}`;
    statusCursor.textContent = label;
    selfCursor.textContent = label;
  }

  function renderWords() {
    statusWords.textContent = `${state.words} 字`;
  }

  function renderStatus() {
    statusOnline.textContent = `在线 ${state.online} 人`;
    collabCount.replaceChildren(
      "在线 ",
      el("span", { class: "collab-count-num", text: String(state.online) }),
      " 人",
    );
    statusFile.textContent = state.currentPath || "";
    if (state.currentPath) {
      selfFile.replaceChildren(
        state.imagePath ? "正在查看 " : "正在编辑 ",
        el("span", {
          class: "peer-file-name",
          text: baseName(state.currentPath),
        }),
      );
    } else {
      selfFile.textContent = "未打开文件";
    }
    renderSave();
    renderWords();
  }

  /** The collapsed strip: one dot per person, own row included. */
  function renderRailPeers() {
    railPeers.innerHTML = "";
    for (const peer of state.presence) {
      const isMe = Boolean(
        peer.id && state.user.id && peer.id === state.user.id,
      );
      railPeers.append(
        el("span", {
          class: "collab-rail-dot",
          style: `background:${peer.color || "var(--fg-3)"}`,
          attrs: {
            title: `${peer.username || "匿名"}${isMe ? "（你）" : ""}`,
          },
        }),
      );
    }
    railCountText.textContent = String(state.online);
    railCountText.title = `在线 ${state.online} 人`;
  }

  function renderPresence(users) {
    state.presence = users || [];
    state.online = state.presence.length;
    presenceList.innerHTML = "";
    presenceList.append(selfRow);

    const others = state.presence.filter(
      (peer) => !(peer.id && state.user.id && peer.id === state.user.id),
    );
    if (!others.length) {
      presenceList.append(
        el(
          "div",
          { class: "collab-empty" },
          el("span", { class: "collab-empty-title", text: "现在只有你在线" }),
          el("span", {
            class: "collab-empty-hint",
            text: "把同一个文件名分享给同事，打开后就能看到彼此的光标",
          }),
        ),
      );
    } else {
      const sorted = [...others].sort((a, b) => {
        const aSame = a.path === state.currentPath ? 0 : 1;
        const bSame = b.path === state.currentPath ? 0 : 1;
        if (aSame !== bSame) return aSame - bSame;
        return String(a.username).localeCompare(String(b.username));
      });
      for (const peer of sorted) {
        presenceList.append(renderPeer(peer, !state.seenPeers.has(peer.id)));
      }
    }
    state.seenPeers = new Set(state.presence.map((peer) => peer.id));
    paintTreePresence();
    renderRailPeers();
    renderStatus();
  }

  // Mark "who is editing this file" on the file tree (the second job of live presence)
  function paintTreePresence() {
    const byPath = new Map();
    for (const peer of state.presence) {
      if (!peer.path) continue;
      const list = byPath.get(peer.path) || [];
      list.push(peer);
      byPath.set(peer.path, list);
    }
    for (const row of treeHost.querySelectorAll(".tree-row")) {
      const path = row.getAttribute("data-path");
      const users = byPath.get(path) || [];
      row.classList.toggle("is-editing", users.length > 0);
      for (const old of row.querySelectorAll(".tree-presence-dot"))
        old.remove();
      if (!users.length) {
        row.removeAttribute("data-editors");
        continue;
      }
      row.setAttribute("data-editors", users.map((u) => u.username).join("、"));
      const dot = el("span", {
        class: "tree-presence-dot",
        style: `background:${users[0].color || "var(--fg-3)"}`,
        attrs: {
          title: `正在编辑：${users.map((u) => u.username).join("、")}`,
        },
      });
      const actions = row.querySelector(".tree-row-actions");
      if (actions) row.insertBefore(dot, actions);
      else row.append(dot);
    }
  }

  function renderPeer(peer, isNew) {
    const sameFile = peer.path && peer.path === state.currentPath;
    const color = peer.color || "var(--fg-3)";
    const dot = el("span", { class: "peer-dot", style: `background:${color}` });
    const cursorText = peer.cursor
      ? `行 ${peer.cursor.line + 1}, 列 ${peer.cursor.ch + 1}`
      : "—";
    const fileLine = peer.path
      ? el(
          "span",
          { class: "peer-file" },
          "正在编辑 ",
          el("span", { class: "peer-file-name", text: baseName(peer.path) }),
        )
      : el("span", { class: "peer-file", text: "未打开文件" });
    const row = el(
      "button",
      {
        class: `peer-row${sameFile ? " is-current" : ""}${isNew ? " is-new" : ""}`,
        attrs: {
          type: "button",
          title: peer.path
            ? `打开 ${peer.path}`
            : `${peer.username} 未打开文件`,
        },
        on: {
          click: async () => {
            if (!peer.path) {
              toastInfo(`${peer.username} 当前未打开任何文件`);
              return;
            }
            await openFile(peer.path);
            if (peer.cursor && state.editor && state.editor.setCursor) {
              state.editor.setCursor(peer.cursor);
            }
          },
        },
      },
      dot,
      el("span", { class: "peer-name", text: peer.username || "匿名" }),
      el("span", { class: "peer-cursor", text: cursorText }),
      fileLine,
    );
    return row;
  }

  // ------------------------------------------------------------- interactions

  let sidebarCollapsed = lsGet(LS.sidebar, "0") === "1";
  let treeWidth = Number(lsGet(LS.treeW, "0")) || 0;
  if (treeWidth) treeWidth = Math.min(TREE_MAX, Math.max(TREE_MIN, treeWidth));

  function applyTreeWidth() {
    if (sidebarCollapsed) {
      shell.style.setProperty("--tree-w", `${TREE_RAIL}px`);
      return;
    }
    if (treeWidth)
      shell.style.setProperty("--tree-w", `${Math.round(treeWidth)}px`);
    else shell.style.removeProperty("--tree-w");
  }

  function applySidebar() {
    shell.classList.toggle("sidebar-collapsed", sidebarCollapsed);
    lsSet(LS.sidebar, sidebarCollapsed ? "1" : "0");
    applyTreeWidth();
  }
  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
    applySidebar();
    state.editor && state.editor.layout && state.editor.layout();
  }
  applySidebar();

  // Sidebar width drag with persisted width.
  let resizingTree = false;
  const onTreeMove = (ev) => {
    if (!resizingTree) return;
    const rect = shell.getBoundingClientRect();
    treeWidth = Math.min(TREE_MAX, Math.max(TREE_MIN, ev.clientX - rect.left));
    applyTreeWidth();
  };
  const onTreeUp = () => {
    if (!resizingTree) return;
    resizingTree = false;
    sidebarResizer.classList.remove("is-dragging");
    document.body.classList.remove("is-resizing");
    if (treeWidth) lsSet(LS.treeW, String(Math.round(treeWidth)));
    state.editor && state.editor.layout && state.editor.layout();
  };
  sidebarResizer.addEventListener("pointerdown", (ev) => {
    if (sidebarCollapsed) return;
    resizingTree = true;
    sidebarResizer.classList.add("is-dragging");
    sidebarResizer.setPointerCapture?.(ev.pointerId);
    document.body.classList.add("is-resizing");
  });
  window.addEventListener("pointermove", onTreeMove);
  window.addEventListener("pointerup", onTreeUp);

  // Splitter drag with persisted ratio.
  let splitRatio = Number(lsGet(LS.split, "0.52"));
  if (!Number.isFinite(splitRatio)) splitRatio = 0.52;
  splitRatio = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, splitRatio));
  function applySplit() {
    center.style.setProperty("--split", `${(splitRatio * 100).toFixed(2)}%`);
  }
  applySplit();

  let dragging = false;
  const onSplitMove = (ev) => {
    if (!dragging) return;
    const rect = center.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = (ev.clientX - rect.left) / rect.width;
    splitRatio = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio));
    applySplit();
  };
  const onSplitUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("is-resizing");
    lsSet(LS.split, String(splitRatio));
    state.editor && state.editor.layout && state.editor.layout();
  };
  splitter.addEventListener("pointerdown", (ev) => {
    dragging = true;
    splitter.setPointerCapture?.(ev.pointerId);
    document.body.classList.add("is-resizing");
  });
  window.addEventListener("pointermove", onSplitMove);
  window.addEventListener("pointerup", onSplitUp);

  // Collab rail: same interaction language as the file tree — drag the left
  // edge, double click for the default width, one button to fold it away.
  let railCollapsed = lsGet(LS.rail, "0") === "1";

  /** Read a layout token as a number so the rail default tracks the design. */
  function tokenPx(name, fallback) {
    try {
      const raw = getComputedStyle(shell).getPropertyValue(name).trim();
      const num = parseFloat(raw);
      return Number.isFinite(num) ? num : fallback;
    } catch {
      return fallback;
    }
  }
  const RAIL_DEFAULT = Math.round(tokenPx("--rail-w", 236));
  let railWidth = Number(lsGet(LS.railW, "0")) || 0;
  if (railWidth) railWidth = Math.min(RAIL_MAX, Math.max(RAIL_MIN, railWidth));

  function applyRailWidth() {
    const value = Math.round(railWidth || RAIL_DEFAULT);
    collabResizer.setAttribute("aria-valuenow", String(value));
    if (railCollapsed) {
      shell.style.setProperty("--rail-w", `${RAIL_RAIL}px`);
      return;
    }
    if (railWidth) shell.style.setProperty("--rail-w", `${value}px`);
    else shell.style.removeProperty("--rail-w");
  }

  function applyRail() {
    shell.classList.toggle("rail-collapsed", railCollapsed);
    lsSet(LS.rail, railCollapsed ? "1" : "0");
    applyRailWidth();
  }

  function toggleRail() {
    railCollapsed = !railCollapsed;
    applyRail();
    state.editor && state.editor.layout && state.editor.layout();
  }
  applyRail();

  let resizingRail = false;
  function setRailWidth(next) {
    railWidth = Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(next)));
    applyRailWidth();
  }
  const onRailMove = (ev) => {
    if (!resizingRail) return;
    const rect = shell.getBoundingClientRect();
    setRailWidth(rect.right - ev.clientX);
  };
  const onRailUp = () => {
    if (!resizingRail) return;
    resizingRail = false;
    collabResizer.classList.remove("is-dragging");
    document.body.classList.remove("is-resizing");
    lsSet(LS.railW, String(Math.round(railWidth || RAIL_DEFAULT)));
    state.editor && state.editor.layout && state.editor.layout();
  };
  collabResizer.addEventListener("pointerdown", (ev) => {
    if (railCollapsed) return;
    resizingRail = true;
    collabResizer.classList.add("is-dragging");
    collabResizer.setPointerCapture?.(ev.pointerId);
    document.body.classList.add("is-resizing");
  });
  collabResizer.addEventListener("dblclick", () => {
    if (railCollapsed) return;
    railWidth = 0;
    lsSet(LS.railW, "0");
    applyRailWidth();
    state.editor && state.editor.layout && state.editor.layout();
    toastInfo("协作栏已恢复默认宽度");
  });
  // Keyboard equivalent of dragging: the handle is focusable, arrows resize.
  collabResizer.addEventListener("keydown", (ev) => {
    if (railCollapsed) return;
    let step = 0;
    if (ev.key === "ArrowLeft") step = RAIL_STEP;
    else if (ev.key === "ArrowRight") step = -RAIL_STEP;
    if (!step) return;
    ev.preventDefault();
    setRailWidth((railWidth || RAIL_DEFAULT) + step);
    lsSet(LS.railW, String(Math.round(railWidth)));
    state.editor && state.editor.layout && state.editor.layout();
  });
  window.addEventListener("pointermove", onRailMove);
  window.addEventListener("pointerup", onRailUp);

  // Ctrl/Cmd+S is meaningless here: the server persists every change.
  const onKeyDown = (ev) => {
    const mod = ev.ctrlKey || ev.metaKey;
    // Mod+Shift+U opens the file picker (plain Mod+U belongs to the browser).
    if (
      mod &&
      ev.shiftKey &&
      !ev.altKey &&
      (ev.key === "u" || ev.key === "U")
    ) {
      ev.preventDefault();
      pickFiles();
      return;
    }
    if (mod && (ev.key === "s" || ev.key === "S")) {
      ev.preventDefault();
      toastInfo("已开启实时保存，编辑内容会自动同步到服务端");
      return;
    }
    if (ev.key === "Escape" && dragDepth > 0) hideDropOverlay();
  };
  window.addEventListener("keydown", onKeyDown, true);

  // ------------------------------------------------------------ drag & drop

  const onShellDragEnter = (ev) => {
    if (!isFileDrag(ev)) return;
    ev.preventDefault();
    dragDepth += 1;
    showDropOverlay();
  };
  const onShellDragOver = (ev) => {
    if (!isFileDrag(ev)) return;
    ev.preventDefault();
    if (ev.dataTransfer)
      ev.dataTransfer.dropEffect = uploading ? "none" : "copy";
    showDropOverlay();
  };
  const onShellDragLeave = (ev) => {
    if (!isFileDrag(ev)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideDropOverlay();
  };
  const onShellDrop = (ev) => {
    if (!isFileDrag(ev)) return;
    ev.preventDefault();
    const dir = uploadTargetDir();
    const dropped =
      ev.dataTransfer && ev.dataTransfer.files
        ? Array.from(ev.dataTransfer.files)
        : [];
    hideDropOverlay();
    if (dropped.length) beginUpload(dropped, dir);
  };

  shell.addEventListener("dragenter", onShellDragEnter);
  shell.addEventListener("dragover", onShellDragOver);
  shell.addEventListener("dragleave", onShellDragLeave);
  shell.addEventListener("drop", onShellDrop);
  // Dropping outside the window (or cancelling the drag) fires no dragleave.
  window.addEventListener("dragend", hideDropOverlay);

  // Keep Monaco sized with its pane.
  const resizeObserver =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          if (state.editor && state.editor.layout) state.editor.layout();
        })
      : null;
  if (resizeObserver) resizeObserver.observe(editorHost);

  function applyUser(next) {
    state.user = { ...state.user, ...next };
    userDot.style.background = state.user.color || "var(--fg-3)";
    userName.textContent = state.user.username;
    userBadge.className = `badge badge-${state.user.role === "admin" ? "admin" : "user"}`;
    userBadge.textContent = state.user.role;
    adminBtn.style.display = state.user.role === "admin" ? "" : "none";
    onUserUpdate && onUserUpdate(state.user);
  }

  function openSettingsDialog() {
    openSettings({ user: state.user, onUserUpdate: (next) => applyUser(next) });
  }

  async function doLogout() {
    const ok = await confirmDialog({
      title: "退出登录",
      message:
        "确定要退出当前账号吗？未同步的本地改动将丢失（正常情况下服务端已实时保存）。",
      confirmLabel: "退出登录",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.logout();
    } catch {
      /* logging out locally is enough */
    }
    onLogout();
  }

  // ------------------------------------------------------------------ boot

  renderSave();
  renderStatus();
  if (preview.setBasePath) preview.setBasePath("");
  preview.renderEmpty("无可预览内容", "打开一个 Markdown 文件即可实时预览");
  // Upload limit comes from the server; if that read fails we keep 0 (unknown)
  // and skip the pre-check entirely — the backend's 413 stays authoritative.
  api
    .settings()
    .then((settings) => {
      const limit = Number(settings && settings.max_upload_bytes);
      if (!Number.isFinite(limit) || limit <= 0) return;
      maxUploadBytes = limit;
      paintDropOverlay();
    })
    .catch(() => {});

  // Restore the file the user had open last time (only if it still exists).
  reloadTree().then(() => {
    if (state.destroyed) return;
    const lastPath = lsGet("mc.lastPath", "");
    if (lastPath && hasPath(state.tree, lastPath))
      openFile(lastPath).catch(() => {});
  });

  return () => {
    state.destroyed = true;
    // Invalidate any in-flight upload so its callbacks stop touching a dead view.
    uploadToken += 1;
    hideDropOverlay();
    if (saveFallbackTimer) {
      clearTimeout(saveFallbackTimer);
      saveFallbackTimer = null;
    }
    if (state.currentPath) {
      lsSet("mc.lastPath", state.currentPath);
      collab.leaveFile(state.currentPath);
    }
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("dragend", hideDropOverlay);
    shell.removeEventListener("dragenter", onShellDragEnter);
    shell.removeEventListener("dragover", onShellDragOver);
    shell.removeEventListener("dragleave", onShellDragLeave);
    shell.removeEventListener("drop", onShellDrop);
    window.removeEventListener("pointermove", onTreeMove);
    window.removeEventListener("pointerup", onTreeUp);
    window.removeEventListener("pointermove", onSplitMove);
    window.removeEventListener("pointerup", onSplitUp);
    window.removeEventListener("pointermove", onRailMove);
    window.removeEventListener("pointerup", onRailUp);
    resizeObserver && resizeObserver.disconnect();
    try {
      if (state.editorObserver)
        state.editorObserver.ytext.unobserve(state.editorObserver.fn);
    } catch {
      /* ignore */
    }
    state.editor && state.editor.destroy && state.editor.destroy();
    state.editor = null;
    preview.destroy();
    collab.destroy();
    tree.destroy && tree.destroy();
    host.innerHTML = "";
  };
}
