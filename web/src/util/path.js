// Workspace path helpers shared by the file tree, the tree search and the
// workspace view. A path is the wire format described in docs/protocol.md §0:
// a workspace-relative POSIX string, `/` separated, no leading slash.

/** Extensions the browser renders inline instead of opening an editor room. */
export const IMAGE_EXTS = [
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

/** @param {string} name file name (not a path) */
export function extOf(name) {
  const idx = String(name || "").lastIndexOf(".");
  return idx > 0
    ? String(name)
        .slice(idx + 1)
        .toLowerCase()
    : "";
}

/** @param {string} path */
export function isImagePath(path) {
  return IMAGE_EXTS.includes(extOf(path));
}

/** @param {string} path */
export function parentPath(path) {
  const value = String(path || "");
  const idx = value.lastIndexOf("/");
  return idx === -1 ? "" : value.slice(0, idx);
}

/** @param {string} path */
export function baseName(path) {
  const parts = String(path || "").split("/");
  return parts[parts.length - 1] || "";
}

/** @param {string} dir @param {string} name */
export function joinPath(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

/**
 * @param {any[]} nodes
 * @param {string} path
 * @returns {boolean} whether the tree contains `path`
 */
export function containsPath(nodes, path) {
  for (const node of nodes || []) {
    if (node.path === path) return true;
    if (node.children && containsPath(node.children, path)) return true;
  }
  return false;
}

/**
 * @param {any[]} nodes
 * @param {string} path
 * @returns {any|null} the node whose path is exactly `path`
 */
export function findNode(nodes, path) {
  for (const node of nodes || []) {
    if (node.path === path) return node;
    if (node.children) {
      const hit = findNode(node.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Mount point of the application: `""` at the site root, `"/cowork"` when the server was
 * started with `--base-path /cowork`.
 *
 * Only `/` (and `/index.html`) return the shell, so the mount point is exactly the
 * directory of the current document. Every absolute URL the client builds — REST, WebSocket,
 * raw downloads — must carry this prefix.
 */
export function basePrefix() {
  const { pathname } = window.location;
  if (pathname.endsWith("/index.html")) return pathname.slice(0, -11);
  return pathname.replace(/\/+$/, "");
}

/** Absolute backend URL for a path that starts with `/api`. */
export function apiUrl(path) {
  return `${basePrefix()}${path}`;
}
