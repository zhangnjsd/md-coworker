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
