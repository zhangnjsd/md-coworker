// Markdown → PDF, produced entirely in the browser.
//
// The PDF is built from the rendered preview with html2pdf.js: jsPDF lays out
// A4 pages, html2canvas photographs the styled DOM. That is the established
// one-call approach for "download what I'm looking at as a PDF", so we do not
// hand-roll pagination, and nothing is sent to the server — the workspace never
// sees the export.
//
// The stylesheet that makes the paper white lives in ../styles/pdf.css and is
// loaded with the workspace view; this module only builds the page and hands it
// over.
//
// html2canvas is stricter than a browser: its colour parser reads hex/rgb()/
// rgba()/hsl()/named only, and it gives up on a pseudo element whose `content`
// is an empty string. Preview styles therefore avoid colour functions in the
// parts that reach the paper (see styles/prose.css), and the `onclone` hook
// below translates whatever else it finds.
import html2pdfModule from "html2pdf.js";

// html2pdf ships a UMD bundle (no ESM build), so the interop shape varies.
const html2pdf =
  html2pdfModule && html2pdfModule.default
    ? html2pdfModule.default
    : html2pdfModule;

/** A4 width at 96 dpi — the measure `styles/pdf.css` is tuned for. */
const PAPER_WIDTH_PX = 794;
/** Never let one unreachable image hold the export hostage. */
const IMAGE_TIMEOUT_MS = 4000;
/** Above this height a 2× raster gets too big for a phone-class canvas budget. */
const LONG_DOCUMENT_PX = 6000;
/** Ink of the exported paper — plain hex, see the `onclone` hook below. */
const PAPER_INK = "#0f141a";


/** Colour functions html2canvas' parser cannot read. */
const MODERN_COLOUR = /oklch\(|oklab\(|color-mix\(|lab\(|lch\(|\d+\s+\d+\s+\d+\s*\//i;
/** Properties holding a single colour value. */
const SINGLE_COLOUR_PROPS = [
  "color",
  "-webkit-text-fill-color",
  "background-color",
  "border-top-color",
  "border-bottom-color",
  "border-left-color",
  "border-right-color",
  "outline-color",
  "text-decoration-color",
  "text-emphasis-color",
  "column-rule-color",
  "caret-color",
  "accent-color",
  "fill",
  "stroke",
];
/** Properties holding colours among other tokens, or images to drop. */
const MIXED_COLOUR_PROPS = ["box-shadow", "text-shadow"];
const IMAGE_PROPS = ["background-image"];

/**
 * Turn every modern colour function in the cloned document into sRGB through a
 * canvas sample, so html2canvas can parse it. Only values it cannot read are
 * touched, and only inside the throwaway clone.
 * @param {Document} clonedDoc
 */
function normaliseCloneColours(clonedDoc) {
  const view = clonedDoc.defaultView;
  if (!view) return;
  const canvas = clonedDoc.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  const cache = new Map();
  const toRgb = (value) => {
    if (cache.has(value)) return cache.get(value);
    // Paint the colour, then read the pixel: exact sRGB, no maths on our side.
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    const out =
      a === 255
        ? `rgb(${r}, ${g}, ${b})`
        : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
    cache.set(value, out);
    return out;
  };

  const visit = (node) => {
    if (!node || node.nodeType !== 1) return;
    const style = node.style;
    const cs = view.getComputedStyle(node);
    for (const prop of SINGLE_COLOUR_PROPS) {
      const value = cs.getPropertyValue(prop);
      if (value && MODERN_COLOUR.test(value)) style.setProperty(prop, toRgb(value), "important");
    }
    // A shadow is a list with colours inside; the paper does not need them.
    for (const prop of MIXED_COLOUR_PROPS) {
      const value = cs.getPropertyValue(prop);
      if (value && MODERN_COLOUR.test(value)) style.setProperty(prop, "none", "important");
    }
    // Gradients would need token-by-token rewriting; the paper has none.
    for (const prop of IMAGE_PROPS) {
      const value = cs.getPropertyValue(prop);
      if (value && value !== "none" && MODERN_COLOUR.test(value))
        style.setProperty(prop, "none", "important");
    }
    for (const child of node.children) visit(child);
  };
  visit(clonedDoc.body);
}

/**
 * `notes/todo.md` → `todo.pdf`. Characters a filesystem dislikes become dashes.
 * @param {string} path
 * @returns {string}
 */
export function pdfFileName(path, fallback = "document") {
  const base =
    String(path || "")
      .split("/")
      .pop() || "";
  const stem = base.replace(/\.(md|markdown)$/i, "").trim();
  return `${(stem || fallback).replace(/[\\/:*?"<>|]+/g, "-")}.pdf`;
}

/**
 * Resolve once every image in `root` has loaded, failed, or timed out.
 * @param {HTMLElement} root
 */
function whenImagesSettled(root) {
  const images = [...root.querySelectorAll("img")];
  return Promise.all(
    images.map(
      (img) =>
        new Promise((resolve) => {
          if (img.complete) {
            resolve();
            return;
          }
          const done = () => resolve();
          img.addEventListener("load", done, { once: true });
          img.addEventListener("error", done, { once: true });
          setTimeout(done, IMAGE_TIMEOUT_MS);
        }),
    ),
  );
}

/**
 * Build the off-screen page: a clone of the rendered preview inside the white
 * paper shell. Cloning (instead of moving) keeps the live preview untouched.
 * @param {HTMLElement} source rendered preview host
 * @param {string} [title] document path, used as PDF metadata
 */
function buildPaper(source, title) {
  const stage = document.createElement("div");
  stage.className = "pdf-stage";
  stage.setAttribute("aria-hidden", "true");

  const paper = document.createElement("article");
  paper.className = "pdf-paper";

  const body = document.createElement("div");
  body.className = "pdf-body markdown-body";
  for (const child of source.children) {
    const clone = child.cloneNode(true);
    // Lazy images would stay blank inside an off-screen box.
    if (clone.nodeName === "IMG") clone.setAttribute("loading", "eager");
    for (const img of clone.querySelectorAll?.("img") || []) {
      img.setAttribute("loading", "eager");
    }
    body.append(clone);
  }

  paper.append(body);
  stage.append(paper);
  if (title) paper.setAttribute("data-title", title);
  return { stage, paper };
}

/**
 * Render the preview to a PDF file and hand it to the browser's download UI.
 * @param {{ source: HTMLElement, filename?: string, title?: string }} opts
 * @returns {Promise<string>} the filename that was handed to the browser
 */
export async function exportMarkdownPdf(opts) {
  const { source, filename = "document.pdf", title = "" } = opts || {};
  if (!source || !source.firstChild) {
    throw new Error("预览还没有内容，暂时无法导出");
  }
  if (typeof html2pdf !== "function") {
    throw new Error("PDF 组件加载失败，请刷新页面重试");
  }

  const { stage, paper } = buildPaper(source, title);
  document.body.append(stage);

  try {
    // Fonts and diagrams settle asynchronously; photographing too early gives
    // fallback glyphs and half-drawn SVGs.
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready.catch(() => {});
    }
    await whenImagesSettled(paper);
    // Let the freshly appended stage finish layout: two frames is enough, but
    // requestAnimationFrame stops firing in a background tab, so the timeout is
    // the floor that keeps the export from hanging forever.
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 250);
    });

    const tall = paper.scrollHeight > LONG_DOCUMENT_PX;
    const options = {
      margin: [14, 14, 16, 14],
      filename,
      // JPEG keeps long documents to a few MB; text stays crisp at scale 2.
      image: { type: "jpeg", quality: 0.95 },
      html2canvas: {
        scale: tall ? 1.6 : 2,
        backgroundColor: "#ffffff",
        useCORS: true,
        allowTaint: false,
        logging: false,
        scrollX: 0,
        scrollY: 0,
        windowWidth: Math.max(
          document.documentElement.clientWidth,
          PAPER_WIDTH_PX,
        ),
        // html2canvas hands every colour it meets to its own small parser,
        // which knows only hex/rgb()/rgba()/hsl()/named colours — while this
        // design system is written in oklch() and mixes with color-mix().
        // It clones the whole document, not just the paper, so the app shell
        // around it reaches that parser too. Rather than ban colour functions
        // from the design system, translate them: the browser itself converts
        // any CSS Color 4 value to sRGB when it paints, so a 1×1 canvas is a
        // reliable converter, and the result is cached per value.
        onclone: (clonedDoc) => {
          for (const node of [clonedDoc.documentElement, clonedDoc.body]) {
            if (!node || !node.style) continue;
            node.style.backgroundColor = "#ffffff";
            node.style.color = PAPER_INK;
          }
          // html2canvas clones the whole page and walks the ancestors of the
          // captured element, so the live shell's colours reach its parser
          // even though only the paper is rendered. Hand the clone a body that
          // holds nothing but the paper: same element, same geometry, no app.
          const stage = clonedDoc.querySelector(".pdf-stage");
          if (stage && stage.parentNode !== clonedDoc.body) {
            clonedDoc.body.replaceChildren(stage);
          }
          normaliseCloneColours(clonedDoc);
        },
      },
      jsPDF: {
        unit: "mm",
        format: "a4",
        orientation: "portrait",
        compress: true,
      },
      pagebreak: {
        mode: ["css", "legacy"],
        avoid: [
          "pre",
          "table",
          "img",
          "blockquote",
          "figure",
          "h2",
          "h3",
          "h4",
        ],
      },
    };

    await html2pdf()
      .set(options)
      .from(paper)
      .toPdf()
      .get("pdf")
      .then((pdf) => {
        try {
          pdf.setProperties({
            title: title || filename,
            subject: title || filename,
            creator: "md-coworker",
          });
        } catch {
          /* metadata is a nicety, never a reason to fail the export */
        }
      })
      .save();

    return filename;
  } catch (err) {
    console.error("[pdf] export failed", err);
    throw new Error(
      err && err.message
        ? `导出 PDF 失败：${err.message}`
        : "导出 PDF 失败，请重试",
    );
  } finally {
    stage.remove();
  }
}
