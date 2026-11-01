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

import { renderPaperDiagrams } from "./preview.js";

// html2pdf ships a UMD bundle (no ESM build), so the interop shape varies.
const html2pdf =
  html2pdfModule && html2pdfModule.default
    ? html2pdfModule.default
    : html2pdfModule;

/** A4 width at 96 dpi — the measure `styles/pdf.css` is tuned for. */
const PAPER_WIDTH_PX = 794;
/** Never let one unreachable image hold the export hostage. */
const IMAGE_TIMEOUT_MS = 4000;
/** Ink of the exported paper — plain hex, see the `onclone` hook below. */
const PAPER_INK = "#0f141a";
/**
 * Most pixels one capture may fill. Browser canvases are capped by memory, and
 * html2canvas walks the whole page in one go: a paper beyond this budget either
 * grinds for minutes (the page looks frozen) or throws half way and leaves its
 * container behind. Long papers therefore get a smaller raster, and absurd ones
 * are refused up front with a message the reader can act on.
 */
const CANVAS_AREA_BUDGET = 60_000_000;
/** Below this raster scale the glyphs stop being readable — refuse instead. */
const MIN_SCALE = 1.1;
/** Highest raster scale: beyond 2× the extra bytes buy nothing on paper. */
const MAX_SCALE = 2;
/**
 * html2pdf's promise can stay pending for good when a capture dies inside its
 * worker, which used to leave the export chip stuck on "导出中…" forever. The
 * watchdog is what makes a failure recoverable.
 */
const EXPORT_TIMEOUT_MS = 60_000;
/** A4 height at 96 dpi; only used to turn pixels into a page count for messages. */
const PAPER_PAGE_PX = 1123;
/** Everything html2canvas / html2pdf append to the live page while capturing. */
const CAPTURE_NODE_SELECTOR =
  ".pdf-stage, .html2pdf__container, .html2pdf__overlay, .html2canvas-container";

/** Colour functions html2canvas' parser cannot read. */
const MODERN_COLOUR =
  /oklch\(|oklab\(|color-mix\(|lab\(|lch\(|\d+\s+\d+\s+\d+\s*\//i;
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
      if (value && MODERN_COLOUR.test(value))
        style.setProperty(prop, toRgb(value), "important");
    }
    // A shadow is a list with colours inside; the paper does not need them.
    for (const prop of MIXED_COLOUR_PROPS) {
      const value = cs.getPropertyValue(prop);
      if (value && MODERN_COLOUR.test(value))
        style.setProperty(prop, "none", "important");
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

/** Ownership token of the running export, so stale sweepers stay out of its way. */
let exportSerial = 0;

/**
 * Remove what a capture appends to the live page. html2canvas renders through an
 * iframe and html2pdf wraps the paper in a container; both clean up after a
 * successful capture, but one that throws or times out leaves them behind —
 * off-screen, invisible and yet in front of everything, which is what made the
 * workspace look dead after a failed export.
 * @param {Set<Element>} [preexisting] body children that must survive
 */
function sweepCaptureNodes(preexisting) {
  for (const node of document.querySelectorAll(CAPTURE_NODE_SELECTOR)) {
    node.remove();
  }
  if (!preexisting || !preexisting.size) return;
  for (const node of [...document.body.children]) {
    if (preexisting.has(node)) continue;
    // html2canvas' own iframe is appended to the body and carries no marker.
    if (node.tagName === "IFRAME") node.remove();
  }
}

/**
 * Resolve with `work`, or reject once it overstays. A promise that never settles
 * is worse than an error: the caller's `finally` would never run, and the export
 * chip would stay disabled for the rest of the session.
 * @template T
 * @param {PromiseLike<T>} work
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
function withTimeout(work, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(work).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Most paper one capture can hold: past this the raster budget cannot be met. */
const MAX_PAPER_HEIGHT_PX = Math.floor(
  CANVAS_AREA_BUDGET / (PAPER_WIDTH_PX * MIN_SCALE * MIN_SCALE),
);

/**
 * The refusal a too-tall document gets. Long papers are the one case this
 * exporter cannot serve: they either freeze the tab for a minute or lose pages
 * silently, so the reader is told what to do instead.
 * @param {number} paperHeight pixels the paper would be tall
 */
function tooLongMessage(paperHeight) {
  const pages = Math.max(1, Math.ceil(paperHeight / PAPER_PAGE_PX));
  return `文档太长了（约 ${pages} 页），一次性导出会让浏览器卡住。请拆分文件后再导出。`;
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
  // Refuse before cloning a document no capture could hold: building its paper
  // takes seconds on its own, which the reader experiences as the freeze this
  // check exists to prevent.
  if (source.scrollHeight + 160 > MAX_PAPER_HEIGHT_PX) {
    throw new Error(tooLongMessage(source.scrollHeight + 160));
  }

  // A previous attempt may have died mid-capture, and its leftovers would sit on
  // top of the page; start from a clean one.
  sweepCaptureNodes();
  const bodyKids = new Set(document.body.children);
  const serial = ++exportSerial;

  const { stage, paper } = buildPaper(source, title);
  document.body.append(stage);
  // Diagrams arrive drawn for the dark pane; draw them again on paper ink while
  // the page is off-screen. Failing here leaves the dark ones in place.
  await renderPaperDiagrams(paper);

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

    // Photographing the whole paper in one go is what makes a long document
    // freeze the tab, so size the raster first and refuse the impossible cases
    // while the page is still responsive.
    const paperHeight = Math.max(paper.scrollHeight, 1);
    const budgetScale = Math.sqrt(
      CANVAS_AREA_BUDGET / (PAPER_WIDTH_PX * paperHeight),
    );
    if (budgetScale < MIN_SCALE) {
      throw new Error(tooLongMessage(paperHeight));
    }
    const scale = Math.min(MAX_SCALE, Math.floor(budgetScale * 100) / 100);
    const options = {
      margin: [14, 14, 16, 14],
      filename,
      // JPEG keeps long documents to a few MB; text stays crisp at scale 2.
      image: { type: "jpeg", quality: 0.95 },
      html2canvas: {
        scale,
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

    await withTimeout(
      html2pdf()
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
        .save(),
      EXPORT_TIMEOUT_MS,
      "导出超时了，已停止本次导出。文档较大时请拆分文件后再试。",
    );

    return filename;
  } catch (err) {
    console.error("[pdf] export failed", err);
    throw new Error(
      err && err.message
        ? `导出 PDF 失败：${err.message}`
        : "导出 PDF 失败，请重试",
    );
  } finally {
    // Leave the page exactly as it was found: a capture that dies half way
    // leaves its stage, container and iframe behind, and those invisible nodes
    // are what made the workspace look dead afterwards.
    stage.remove();
    sweepCaptureNodes(bodyKids);
    // A dead capture can still be running inside its worker and append its nodes
    // a moment later, so sweep twice more — unless a newer export owns them.
    for (const delay of [1000, 4000]) {
      setTimeout(() => {
        if (serial !== exportSerial) return;
        sweepCaptureNodes(bodyKids);
      }, delay);
    }
  }
}
