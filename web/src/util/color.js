// Colour helpers for collaborator dots / remote cursors.

/** #rrggbb or #rgb -> {r,g,b} */
function parseHex(hex) {
  let h = String(hex || "")
    .trim()
    .replace(/^#/, "");
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function toHex({ r, g, b }) {
  const c = (v) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Light tint used as the remote selection background. */
export function colorLight(color, alpha = 0.22) {
  const rgb = parseHex(color);
  if (!rgb) return "rgba(79,156,249,0.22)";
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
}

/** Stronger tint, e.g. for presence chips. */
export function colorSoft(color, alpha = 0.16) {
  const rgb = parseHex(color);
  if (!rgb) return "rgba(79,156,249,0.16)";
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
}

export function lighten(color, amount = 0.45) {
  const rgb = parseHex(color);
  if (!rgb) return color;
  return toHex({
    r: rgb.r + (255 - rgb.r) * amount,
    g: rgb.g + (255 - rgb.g) * amount,
    b: rgb.b + (255 - rgb.b) * amount,
  });
}

/** Awareness `user` payload consumed by y-codemirror / y-monaco cursor rendering. */
export function awarenessUser(user) {
  const color = user?.color || "#4f9cf9";
  return {
    name: user?.username || "匿名",
    color,
    colorLight: colorLight(color, 0.22),
  };
}
