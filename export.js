/* DESIGN
   ------
   * This file exports the dark mode PDF. The user drops a PDF, reads it
   * in dark mode, and downloads a new PDF with dark mode baked in.
   * The exported file works in any PDF reader on any device.
   *
   * The approach is a "sandwich PDF": each page is rasterized as a JPEG
   * image (the visible dark mode rendering), with an invisible text layer
   * on top (opacity: 0) so the text remains selectable and searchable.
   * This is the same technique used by professional document scanners.
   *
   * Key decisions:
   *
   * - JPEG at quality 0.85: I chose lossy compression because lossless
   *   (PNG) would produce files 4-5x larger. At 0.85, artifacts are
   *   invisible to the naked eye during normal reading. The trade-off
   *   is that vector text becomes raster, so extreme zoom shows pixels.
   *
   * - Multi-script fonts: the invisible text layer needs fonts that
   *   cover the document's writing system. Noto Sans Regular handles
   *   Latin, Greek, Cyrillic and math symbols. For Arabic, Hebrew, CJK,
   *   Indic and 18 other scripts, I lazy-load the matching local Noto Sans
   *   variant with fontkit for subsetting. detectScript() in
   *   core.js identifies the script per text item. Each font is
   *   loaded once and cached across exports. Latin-only documents
   *   never trigger any extra download. If a font download fails, the
   *   item falls back silently to Noto Sans Regular.
   *
   * - Width matching: the invisible text in Noto Sans has different
   *   character widths than the original font in the PDF. Without
   *   correction, selecting text in the exported PDF would overshoot
   *   or undershoot. I measure the natural width and adjust the fontSize
   *   so the selection aligns with the visible text in the image.
   *
   * - Link preservation: PDF link annotations (URLs, internal navigation)
   *   are extracted from the original and re-embedded in the exported file
   *   with the same protocol whitelist (http, https, mailto only).
   *   Internal links are deferred until all pages exist in the new PDF,
   *   because page 1 might link to page 50 which hasn't been created yet.
   *
   * - Document outline preservation: bookmarks are a separate navigation
   *   tree from link annotations, so preserving one does not preserve the
   *   other. I rebuild the outline after every output page exists, resolving
   *   named and explicit internal destinations against the new page refs.
   *   External actions are deliberately not copied.
   *
   * - Memory management: each page's JPEG bytes are nulled after
   *   embedding, the outPdf reference is nulled after save(), and
   *   every 5 pages I pause for 100ms to let the browser's GC (garbage
   *   collector) clean up released memory. These techniques were
   *   originally developed for iOS (where the system memory manager,
   *   Jetsam, kills browser tabs that exceed ~300MB), but they benefit
   *   every platform: without them, each successive export gets slower
   *   as the heap fills up with unreleased data from the previous run.
   *   This is a curb cut effect: like sidewalk ramps designed for
   *   wheelchairs that end up helping everyone with strollers, bikes,
   *   and luggage, optimizations born from iOS constraints improve
   *   the experience on every device.
   *
   * - Canvas recycling: two canvases (renderCanvas and finalCanvas) are
   *   created once and reused for every page instead of allocating new
   *   ones per page. This avoids 400+ GPU context allocations on long
   *   documents. Same curb cut: born from iOS, valuable everywhere.
   *
   * - Export generation counter: prevents race conditions when the user
   *   cancels and immediately re-exports. Each export captures its own
   *   generation number and checks it before every async step.
   *
   * The module communicates with app.js through a context object (ctx)
   * passed via initExport(). This avoids circular imports.
   *
   * The file follows this flow:
   *
   * 1. MODULE STATE (line 102)
   * 2. INITIALIZATION AND PUBLIC API (line 151)
   * 3. LAZY LOADERS (line 175)
   * 4. PROGRESS UI (line 270)
   * 5. LINK ANNOTATIONS (line 285)
   * 6. DOCUMENT OUTLINE (line 428)
   * 7. PER-PAGE EXPORT (line 520)
   * 8. MAIN EXPORT ORCHESTRATOR (line 826)
*/

import {
  OCR_CONFIDENCE_THRESHOLD,
  normalizeLigatures,
  isOcrArtifact,
  compositeImageRegions,
  getNavigatorLanguage,
  detectScript,
  groupItemsIntoLines,
  isBlankPaper,
  OCR_OVERLAY_COVERAGE_THRESHOLD,
  OCR_OVERLAY_CHAR_THRESHOLD,
  transformPdfDestination,
} from './core.js';

import { createTesseractWorker, preprocessCanvasForOcr } from './ocr.js';
import { loadBinaryAsset } from './assets.js';


// --- MODULE STATE ---

let pdfLibModule = null;     // pdf-lib module (lazy-loaded on first export)
let fontkitModule = null;    // fontkit for Unicode font embedding (lazy-loaded)
let cachedFontBytes = null;  // Noto Sans Regular TTF bytes (loaded once, reused)
let exporting = false;
let exportGeneration = 0;    // increments on every export/cancel, never decreases

/*
 * I use different Noto Sans variants for different writing systems
 * (Arabic text needs Noto Sans Arabic, Chinese needs Noto Sans SC).
 * Each font is loaded once and cached in fontBytesCache, then
 * embedded once per export into fontRegistry. Latin-only documents
 * never trigger any download.
 *
 * The map keys match the script names returned by detectScript() in
 * core.js. The values are DEPS keys in app.js. Scripts not listed
 * here fall through to the latin font (Noto Sans Regular)
 */
const SCRIPT_FONT_MAP = {
  arabic:     'NOTO_SANS_ARABIC',
  hebrew:     'NOTO_SANS_HEBREW',
  devanagari: 'NOTO_SANS_DEVANAGARI',
  bengali:    'NOTO_SANS_BENGALI',
  gurmukhi:   'NOTO_SANS_GURMUKHI',
  gujarati:   'NOTO_SANS_GUJARATI',
  tamil:      'NOTO_SANS_TAMIL',
  telugu:     'NOTO_SANS_TELUGU',
  kannada:    'NOTO_SANS_KANNADA',
  malayalam:  'NOTO_SANS_MALAYALAM',
  sinhala:    'NOTO_SANS_SINHALA',
  thai:       'NOTO_SANS_THAI',
  lao:        'NOTO_SANS_LAO',
  tibetan:    'NOTO_SANS_TIBETAN',
  myanmar:    'NOTO_SANS_MYANMAR',
  georgian:   'NOTO_SANS_GEORGIAN',
  armenian:   'NOTO_SANS_ARMENIAN',
  ethiopic:   'NOTO_SANS_ETHIOPIC',
  khmer:      'NOTO_SANS_KHMER',
  japanese:   'NOTO_SANS_JP',
  korean:     'NOTO_SANS_KR',
  cjk:        'NOTO_SANS_SC',
};

const fontBytesCache = {};   // { arabic: Uint8Array, ... } persists across exports

let ctx = null;


// --- INITIALIZATION AND PUBLIC API ---

export function initExport(exportContext) {
  ctx = exportContext;
}

/*
 * Cancellation feels instant even though the export can't actually
 * stop mid-render. The UI hides the progress bar and re-enables the
 * button immediately. Behind the scenes, the running export continues
 * until it reaches its next generation check and discovers the
 * mismatch. The user perceives a fast, responsive cancel while the
 * system quietly finishes its current step and exits
 */
export function cancelExport() {
  exportGeneration++;
  hideExportProgress();
  exporting = false;
  ctx.btnExport.disabled = false;
}

export { exportGeneration };


// --- LAZY LOADERS ---

// pdf-lib and fontkit load only when the user exports for the first time

async function ensurePdfLib() {
  if (pdfLibModule) return pdfLibModule;
  pdfLibModule = await import(ctx.DEPS.PDF_LIB);
  return pdfLibModule;
}

// Loads fontkit (font parser) and Noto Sans (Unicode font).
// See DESIGN block for why both are needed
async function ensureUnicodeFont() {
  if (!fontkitModule) {
    try {
      const mod = await import(ctx.DEPS.FONTKIT);
      fontkitModule = mod.default || mod;
    } catch (e) {
      console.warn('Failed to load fontkit:', e);
      return null;
    }
  }

  if (!cachedFontBytes) {
    try {
      cachedFontBytes = await loadBinaryAsset(ctx.DEPS.NOTO_SANS);
    } catch (e) {
      console.warn('Failed to load Unicode font:', e);
      return null;
    }
  }

  return { fontkit: fontkitModule, fontBytes: cachedFontBytes };
}

/*
 * I select the correct Noto Sans variant for a given script. On the
 * first call for each script, I load and embed the font in the PDF.
 * Subsequent calls return the cached PDFFont.
 *
 * Font bytes persist across exports (fontBytesCache) so a second
 * export skips the load entirely. PDFFont objects (fontRegistry)
 * are reset per export because they are tied to a specific
 * PDFDocument instance.
 *
 * For non-Latin scripts, I disable OpenType shaping features (GSUB)
 * during embedding. The text layer is invisible (opacity: 0) so
 * visual shaping (connected Arabic letters, ligatures) does not
 * matter. What matters is that the ToUnicode CMap maps each glyph
 * back to the correct Unicode codepoint for copy/paste. When GSUB
 * is active, fontkit substitutes glyph IDs for contextual forms and
 * then generates a corrupted reverse mapping (e.g. Arabic "ta" gets
 * mapped to "ya" because they share a base skeleton). Disabling
 * GSUB keeps the mapping 1:1 and clean.
 *
 * Latin falls through to the main Noto Sans Regular font passed as
 * latinFont. Scripts without a DEPS entry also fall through
 */
const NO_SHAPING_FEATURES = {
  init: false, medi: false, fina: false, isol: false,
  liga: false, rlig: false, clig: false, calt: false, ccmp: false,
};

async function getFontForScript(script, outPdf, latinFont, fontRegistry) {
  if (script === 'latin' || !SCRIPT_FONT_MAP[script]) return latinFont;
  if (fontRegistry[script]) return fontRegistry[script];

  const depKey = SCRIPT_FONT_MAP[script];
  const asset = ctx.DEPS[depKey];
  if (!asset) return latinFont;

  // Load font bytes once per script, then reuse them across exports
  if (!fontBytesCache[script]) {
    try {
      fontBytesCache[script] = await loadBinaryAsset(asset);
    } catch (e) {
      console.warn(`[Export] Failed to load font for ${script}:`, e);
      return latinFont;
    }
  }

  // Embed with shaping disabled so ToUnicode stays clean
  try {
    fontRegistry[script] = await outPdf.embedFont(fontBytesCache[script], {
      subset: true,
      features: NO_SHAPING_FEATURES,
    });
    return fontRegistry[script];
  } catch (e) {
    console.warn(`[Export] Failed to embed font for ${script}:`, e);
    return latinFont;
  }
}


// --- PROGRESS UI ---

function showExportProgress(current, total) {
  ctx.exportProgressEl.hidden = false;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  ctx.exportProgressFill.style.width = pct + '%';
  ctx.exportProgressText.textContent = `${current} / ${total}`;
}

export function hideExportProgress() {
  ctx.exportProgressEl.hidden = true;
  ctx.exportProgressFill.style.width = '0%';
}


// --- LINK ANNOTATIONS ---

/*
 * PDF.js exposes internal destinations in two shapes: a named destination
 * or an explicit array whose first value is a source page ref or page index.
 * I resolve both shapes here so link annotations and document outlines
 * cannot drift into subtly different low-level PDF representations.
 */
async function buildInternalDestination(outPdf, dest, destinationViewports) {
  const { PDFName } = pdfLibModule;
  let explicitDest = null;

  try {
    if (typeof dest === 'string') {
      explicitDest = await ctx.pdfDoc.getDestination(dest);
    } else if (Array.isArray(dest) && dest.length > 0) {
      explicitDest = dest;
    }
  } catch (e) {
    console.warn('[Export] Failed to resolve internal destination:', e);
    return null;
  }

  if (!Array.isArray(explicitDest) || explicitDest.length === 0) {
    return null;
  }

  try {
    const target = explicitDest[0];
    const pageIndex = Number.isInteger(target)
      ? target
      : await ctx.pdfDoc.getPageIndex(target);
    if (pageIndex < 0 || pageIndex >= outPdf.getPageCount()) return null;

    let viewport = destinationViewports.get(pageIndex);
    if (!viewport) {
      const targetPage = await ctx.pdfDoc.getPage(pageIndex + 1);
      viewport = targetPage.getViewport({ scale: 1 });
      destinationViewports.set(pageIndex, viewport);
    }

    const context = outPdf.context;
    const destValues = [outPdf.getPage(pageIndex).ref];
    const transformedValues = transformPdfDestination(explicitDest, viewport);

    for (const value of transformedValues) {
      if (value === null || value === undefined) {
        destValues.push(context.obj(null));
      } else if (typeof value === 'object' && value.name) {
        destValues.push(PDFName.of(value.name));
      } else if (typeof value === 'string') {
        const name = value.startsWith('/') ? value.slice(1) : value;
        destValues.push(PDFName.of(name));
      } else if (typeof value === 'number') {
        destValues.push(context.obj(value));
      } else {
        destValues.push(context.obj(null));
      }
    }

    return context.obj(destValues);
  } catch (e) {
    console.warn('[Export] Failed to build internal destination:', e);
    return null;
  }
}

/*
 * Re-embeds link annotations from the original PDF into the exported one.
 * External links (URLs) get an action dictionary with the sanitized URI.
 * Internal links (page navigation) need special handling: the destination
 * page might not exist yet when the source page is processed (page 1
 * linking to page 50), so all annotations are collected during the page
 * loop and embedded at the end when all pages exist.
 *
 * I use pdf-lib's low-level API here because the friendly high-level
 * methods (page.drawText, page.drawImage) don't support link annotations.
 * The low-level API builds PDF objects manually: PDFName for keywords
 * like /Link and /URI, PDFString for text values, and context.obj()
 * to create dictionaries that get written directly into the PDF file
 */
async function embedLinkAnnotations(outPdf, outPage, annotations, destinationViewports) {
  const { PDFName, PDFString } = pdfLibModule;

  for (const annot of annotations) {
    if (annot.subtype !== 'Link') continue;
    if (!annot.rect || annot.rect.length < 4) continue;

    const url = annot.url || null;
    const dest = annot.dest || null;
    if (!url && !dest) continue;

    const [x1, y1, x2, y2] = annot.rect;

    try {
      const context = outPdf.context;

      const annotDict = context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [x1, y1, x2, y2],
        Border: [0, 0, 0],
        F: 4,
      });

      if (url) {
        // Sanitize URL protocol, same whitelist as the viewer.
        // Without this, a malicious PDF could export javascript: URIs
        // that the viewer correctly blocks but the exported PDF wouldn't.
        try {
          const parsed = new URL(url);
          if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) continue;
        } catch (_) { continue; }

        const actionDict = context.obj({
          Type: 'Action',
          S: 'URI',
          URI: PDFString.of(url),
        });
        annotDict.set(PDFName.of('A'), context.register(actionDict));
      } else if (dest) {
        const destArray = await buildInternalDestination(outPdf, dest, destinationViewports);
        if (!destArray) continue;
        annotDict.set(PDFName.of('Dest'), destArray);
      }

      const annotRef = context.register(annotDict);
      const pageDict = outPage.node;
      let annots = pageDict.lookup(PDFName.of('Annots'));

      if (annots instanceof pdfLibModule.PDFArray) {
        annots.push(annotRef);
      } else {
        const newAnnots = context.obj([annotRef]);
        pageDict.set(PDFName.of('Annots'), newAnnots);
      }
    } catch (e) {
      console.warn('[LinkExport] Annotation failed:', e);
    }
  }
}


// --- DOCUMENT OUTLINE ---

/*
 * pdf-lib has no high-level outline API, and creating a new PDF does not
 * carry the source catalog across. I rebuild the linked outline tree with
 * indirect refs so readers can traverse Parent, First, Last, Prev, and Next
 * exactly as they would in the original document.
 *
 * Only internal Dest values are copied. URL, JavaScript, file-launch, and
 * other actions stay inert, which preserves their place in the hierarchy
 * without expanding the export's trust boundary.
 */
async function embedDocumentOutline(outPdf, destinationViewports) {
  let outline;

  try {
    outline = await ctx.pdfDoc.getOutline();
  } catch (e) {
    console.warn('[OutlineExport] Failed to read document outline:', e);
    return;
  }

  if (!Array.isArray(outline) || outline.length === 0) return;

  const { PDFHexString, PDFName, PDFNumber } = pdfLibModule;
  const context = outPdf.context;
  const outlinesDict = context.obj({ Type: 'Outlines' });
  const outlinesRef = context.register(outlinesDict);

  async function addLevel(items, parentRef) {
    const entries = items
      .filter(item => item && typeof item === 'object')
      .map(item => {
        const dict = context.obj({
          Title: PDFHexString.fromText(String(item.title ?? '')),
          Parent: parentRef,
        });
        return { item, dict, ref: context.register(dict) };
      });

    if (entries.length === 0) return null;

    let visibleCount = entries.length;

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];

      if (index > 0) {
        entry.dict.set(PDFName.of('Prev'), entries[index - 1].ref);
      }
      if (index < entries.length - 1) {
        entry.dict.set(PDFName.of('Next'), entries[index + 1].ref);
      }

      const destArray = await buildInternalDestination(outPdf, entry.item.dest, destinationViewports);
      if (destArray) entry.dict.set(PDFName.of('Dest'), destArray);

      const childItems = Array.isArray(entry.item.items) ? entry.item.items : [];
      const children = await addLevel(childItems, entry.ref);
      if (!children) continue;

      entry.dict.set(PDFName.of('First'), children.first);
      entry.dict.set(PDFName.of('Last'), children.last);

      const isClosed = Number.isInteger(entry.item.count) && entry.item.count < 0;
      const itemCount = isClosed ? -children.visibleCount : children.visibleCount;
      entry.dict.set(PDFName.of('Count'), PDFNumber.of(itemCount));

      if (!isClosed) visibleCount += children.visibleCount;
    }

    return {
      first: entries[0].ref,
      last: entries[entries.length - 1].ref,
      visibleCount,
    };
  }

  try {
    const root = await addLevel(outline, outlinesRef);
    if (!root) return;

    outlinesDict.set(PDFName.of('First'), root.first);
    outlinesDict.set(PDFName.of('Last'), root.last);
    outlinesDict.set(PDFName.of('Count'), PDFNumber.of(root.visibleCount));
    outPdf.catalog.set(PDFName.of('Outlines'), outlinesRef);
  } catch (e) {
    console.warn('[OutlineExport] Failed to build document outline:', e);
  }
}


// --- PER-PAGE EXPORT ---

/*
 * Processes a single page: render to canvas, apply dark mode inversion,
 * composite original images back, convert to JPEG, embed in pdf-lib,
 * add invisible text layer, collect link annotations.
 *
 * The dark mode application mirrors the browser exactly: ctx.filter
 * 'invert(0.86) hue-rotate(180deg)' on browsers that support it,
 * manual pixel manipulation on Safari where ctx.filter doesn't work.
 * This means the exported PDF looks identical to what the user sees
 * in the viewer.
 *
 * For scanned documents, OCR runs during export with a dedicated
 * Tesseract worker (separate from the viewer's worker). The recognized
 * text is embedded as invisible text positioned over each word
 */
async function exportPage(pageNum, outPdf, font, fontRegistry, exportWorker, exportScale, renderCanvas, finalCanvas, deferredAnnotations, myExportGen, totalPages) {
  const page = await ctx.pdfDoc.getPage(pageNum);
  const origVp = page.getViewport({ scale: 1 });
  const renderVp = page.getViewport({ scale: exportScale });
  const w = Math.floor(renderVp.width);
  const h = Math.floor(renderVp.height);

  renderCanvas.width = w;
  renderCanvas.height = h;
  finalCanvas.width = w;
  finalCanvas.height = h;

  const tasks = [
    page.render({
      canvasContext: renderCanvas.getContext('2d'),
      viewport: renderVp,
    }).promise,
    page.getOperatorList(),
    page.getAnnotations(),
  ];
  if (!ctx.isScannedDocument) {
    tasks.push(page.getTextContent());
  }

  const results = await Promise.all(tasks);
  if (exportGeneration !== myExportGen) return;

  const opList = results[1];
  const annotations = results[2];
  const textContent = ctx.isScannedDocument ? null : results[3];

  const isDarkBg = ctx.detectAlreadyDark(renderCanvas);
  const override = ctx.pageDarkOverride.get(pageNum);
  let applyDark;
  if (override === 'dark') applyDark = true;
  else if (override === 'light') applyDark = false;
  else applyDark = !isDarkBg;

  const fCtx = finalCanvas.getContext('2d');

  if (applyDark) {
    if (ctx.supportsCtxFilter) {
      fCtx.filter = 'invert(0.86) hue-rotate(180deg)';
      fCtx.drawImage(renderCanvas, 0, 0);
      fCtx.filter = 'none';
    } else {
      fCtx.drawImage(renderCanvas, 0, 0);
      const imgData = fCtx.getImageData(0, 0, w, h);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        // Manual invert(0.86) + hue-rotate(180deg) for Safari.
        // Step 1: invert by 86% (not 100%, which would be harsh)
        let r = d[i]   + 0.86 * (255 - 2 * d[i]);
        let g = d[i+1] + 0.86 * (255 - 2 * d[i+1]);
        let b = d[i+2] + 0.86 * (255 - 2 * d[i+2]);
        // Step 2: hue-rotate 180deg by negating chroma around luminance
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = 2 * lum - r;
        g = 2 * lum - g;
        b = 2 * lum - b;
        d[i]   = Math.max(0, Math.min(255, r));
        d[i+1] = Math.max(0, Math.min(255, g));
        d[i+2] = Math.max(0, Math.min(255, b));
      }
      fCtx.putImageData(imgData, 0, 0);
    }

    if (!ctx.isScannedDocument) {
      let regions = ctx.extractImageRegions(opList, renderVp.transform);

      // Same OCR overlay filtering as the web viewer (3 signals:
      // coverage, char density, blank paper)
      if (regions.length > 0 && textContent) {
        const pageArea = w * h;
        const charCount = textContent.items.reduce((sum, it) => sum + (it.str || '').length, 0);
        const rCtx = renderCanvas.getContext('2d');

        regions = regions.filter(region => {
          const coverage = (region.width * region.height) / pageArea;
          if (coverage < OCR_OVERLAY_COVERAGE_THRESHOLD) return true;
          if (charCount < OCR_OVERLAY_CHAR_THRESHOLD) return true;

          const rx = Math.max(0, Math.round(region.x));
          const ry = Math.max(0, Math.round(region.y));
          const rw = Math.min(w - rx, Math.round(region.width));
          const rh = Math.min(h - ry, Math.round(region.height));
          if (rw <= 0 || rh <= 0) return true;

          const imgData = rCtx.getImageData(rx, ry, rw, rh);
          return !isBlankPaper(imgData.data, rw, rh);
        });
      }

      if (regions.length > 0) {
        compositeImageRegions(fCtx, renderCanvas, regions, w, h);
      }
    }
  } else {
    fCtx.drawImage(renderCanvas, 0, 0);
  }

  const jpegBlob = await new Promise(r =>
    finalCanvas.toBlob(r, 'image/jpeg', 0.85)
  );
  let jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());

  const jpegImage = await outPdf.embedJpg(jpegBytes);
  jpegBytes = null; // pdf-lib copied the bytes internally
  const outPage = outPdf.addPage([origVp.width, origVp.height]);
  outPage.drawImage(jpegImage, {
    x: 0,
    y: 0,
    width: origVp.width,
    height: origVp.height,
  });

  if (textContent) {
    // I transform each item to get its position, then group them into
    // lines and split each line into "runs" of consecutive same-script
    // items. Each run becomes a single drawText call. This avoids two
    // problems: (1) per-item drawText produces fragmented text that
    // viewers show as one-word-per-line when pasting, and (2) mixing
    // Arabic and Latin in one drawText confuses the viewer's bidi
    // algorithm, reversing Arabic characters on mixed-script lines.
    // Same-script runs are safe to concatenate because the viewer
    // knows the direction from the characters themselves
    const exportItems = [];
    for (const item of textContent.items) {
      if (!item.str || !item.str.trim()) continue;
      const tx = item.transform;
      const baseFontSize = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
      if (baseFontSize < 1) continue;
      exportItems.push({
        str: normalizeLigatures(item.str),
        left: tx[4], top: tx[5],
        fontSize: baseFontSize,
        width: item.width,
        height: baseFontSize,
        dir: item.dir || 'ltr',
      });
    }

    const lines = groupItemsIntoLines(exportItems);

    // I reverse the line order so the content stream starts with the
    // top of the page. In PDF coordinates Y=0 is at the bottom, so
    // groupItemsIntoLines sorts bottom-first. Chrome and Acrobat
    // extract text in content stream order, which without this
    // reversal produces bottom-to-top paste. Apple Preview uses
    // spatial analysis and is unaffected by stream order
    lines.reverse();

    for (const line of lines) {
      // Sort items by position within the line
      const rtlCount = line.filter(it => it.dir === 'rtl').length;
      const isRtl = rtlCount > line.length / 2;
      line.sort((a, b) => isRtl ? b.left - a.left : a.left - b.left);

      // Split the line into runs of consecutive same-script items.
      // A "run" is a sequence where all items share the same script
      // (e.g. all Arabic or all Latin). Punctuation and numbers
      // that detectScript classifies as 'latin' attach to whichever
      // run they are adjacent to
      const runs = [];
      let currentRun = [line[0]];
      let currentScript = detectScript(line[0].str);

      for (let i = 1; i < line.length; i++) {
        const itemScript = detectScript(line[i].str);
        if (itemScript === currentScript || itemScript === 'latin' && currentScript !== 'latin') {
          // Same script, or latin punctuation/numbers inside a non-latin run
          currentRun.push(line[i]);
        } else if (currentScript === 'latin' && itemScript !== 'latin') {
          // Switching from latin to non-latin: start new run
          runs.push({ items: currentRun, script: currentScript });
          currentRun = [line[i]];
          currentScript = itemScript;
        } else {
          runs.push({ items: currentRun, script: currentScript });
          currentRun = [line[i]];
          currentScript = itemScript;
        }
      }
      runs.push({ items: currentRun, script: currentScript });

      // Write each run as a single drawText
      for (const run of runs) {
        const runText = run.items.map(it => it.str).join(' ');
        const runFont = await getFontForScript(run.script, outPdf, font, fontRegistry);
        const avgFontSize = run.items.reduce((s, it) => s + it.fontSize, 0) / run.items.length;
        const minX = Math.min(...run.items.map(it => it.left));
        const maxX = Math.max(...run.items.map(it => it.left + (it.width || 0)));
        const totalWidth = maxX - minX;

        try {
          let drawSize = avgFontSize;
          if (totalWidth > 0) {
            const naturalWidth = runFont.widthOfTextAtSize(runText, avgFontSize);
            if (naturalWidth > 0) {
              drawSize = avgFontSize * (totalWidth / naturalWidth);
            }
          }

          outPage.drawText(runText, {
            x: minX,
            y: run.items[0].top,
            size: drawSize,
            font: runFont,
            opacity: 0,
          });
        } catch (_) {}
      }
    }

  } else if (ctx.isScannedDocument && exportWorker) {
    const processed = preprocessCanvasForOcr(renderCanvas);
    const ocrBlob = await new Promise(r =>
      processed.toBlob(r, 'image/png')
    );
    processed.width = 0;
    const { data } = await exportWorker.recognize(ocrBlob);

    if (data.words) {
      const sx = origVp.width / w;
      const sy = origVp.height / h;

      for (const word of data.words) {
        if (!word.text || !word.text.trim()) continue;
        if (word.confidence < OCR_CONFIDENCE_THRESHOLD) continue;
        if (isOcrArtifact(word.text)) continue;
        const wordText = normalizeLigatures(word.text);
        // 0.85 compensates for Tesseract's bbox padding (see ocr.js)
        const baseFontSize = (word.bbox.y1 - word.bbox.y0) * sy * 0.85;
        if (baseFontSize < 1) continue;

        const script = detectScript(wordText);
        const wordFont = await getFontForScript(script, outPdf, font, fontRegistry);

        try {
          const targetWidth = (word.bbox.x1 - word.bbox.x0) * sx;
          let drawSize = baseFontSize;
          if (targetWidth > 0) {
            const naturalWidth = wordFont.widthOfTextAtSize(wordText, baseFontSize);
            if (naturalWidth > 0) {
              drawSize = baseFontSize * (targetWidth / naturalWidth);
            }
          }

          outPage.drawText(wordText, {
            x: word.bbox.x0 * sx,
            y: origVp.height - word.bbox.y1 * sy,
            size: drawSize,
            font: wordFont,
            opacity: 0,
          });
        } catch (_) {}
      }
    }
  }

  // Defer link annotations until all pages exist (see DESIGN block)
  if (annotations.length > 0) {
    deferredAnnotations.push({ outPage, annotations });
  }

  // Release per-page resources. page.cleanup() frees PDF.js internal
  // caches (decoded images, font programs). clearRect releases the
  // canvas pixel data while keeping the element for reuse next page
  page.cleanup();
  renderCanvas.getContext('2d').clearRect(0, 0, w, h);
  finalCanvas.getContext('2d').clearRect(0, 0, w, h);

  if (exportGeneration === myExportGen) {
    showExportProgress(pageNum, totalPages);
  }

  // Every 5 pages, I pause for 100ms to let the browser's garbage
  // collector clean up the JPEG bytes and canvas data I've released.
  // On other pages, I yield via MessageChannel (faster, but only gives
  // the browser a micro-instant). Without these periodic pauses,
  // each successive export gets slower as unreleased memory accumulates
  if (pageNum % 5 === 0) {
    await new Promise(r => setTimeout(r, 100));
  } else {
    await ctx.yieldToUI();
  }
}


// --- MAIN EXPORT ORCHESTRATOR ---

/*
 * The entry point for export. Creates a new PDF, processes every page
 * sequentially (parallel would spike memory), embeds deferred navigation
 * structures at the end, and triggers the download.
 *
 * For scanned documents, a dedicated Tesseract worker is created for
 * the export (separate from the viewer's worker) so the viewer's OCR
 * isn't disrupted. This worker uses the user's language from
 * navigator.languages, same as the viewer
 */
export async function exportDarkPdf() {
  if (!ctx.pdfDoc || exporting) return;

  exporting = true;
  const myExportGen = ++exportGeneration;
  ctx.btnExport.disabled = true;

  try {
    const { PDFDocument, StandardFonts } = await ensurePdfLib();

    let outPdf = await PDFDocument.create();
    const fontRegistry = {};

    // Try Noto Sans (Unicode coverage) first, fall back to Helvetica
    // (256 chars only). The fallback is silent because the text is
    // invisible anyway, just missing some special characters
    let font;
    const fontResources = await ensureUnicodeFont();
    if (fontResources) {
      try {
        outPdf.registerFontkit(fontResources.fontkit);
        font = await outPdf.embedFont(fontResources.fontBytes, { subset: true });
      } catch (e) {
        console.warn('[Export] Failed to embed Unicode font, falling back to Helvetica:', e);
        font = await outPdf.embedFont(StandardFonts.Helvetica);
      }
    } else {
      font = await outPdf.embedFont(StandardFonts.Helvetica);
    }

    const totalPages = ctx.pdfDoc.numPages;

    // Export at higher resolution than the display for sharper text.
    // Desktop renders at 3x (216 DPI). The mobile path exists as a
    // safety net but the export button is currently hidden on mobile
    const isMobile = window.matchMedia('(pointer: coarse)').matches;
    const minExportScale = isMobile ? 2 : 3;
    const exportScale = Math.max(ctx.currentScale * 2, minExportScale);

    showExportProgress(0, totalPages);
    const deferredAnnotations = [];
    const destinationViewports = new Map();

    let exportWorker = null;
    if (ctx.isScannedDocument) {
      try {
        const navLang = getNavigatorLanguage();
        const langs = navLang ? 'eng+' + navLang : 'eng';
        exportWorker = await createTesseractWorker(langs);
      } catch (err) {
        console.warn('[Export] Failed to create OCR worker:', err);
      }
    }

    const renderCanvas = document.createElement('canvas');
    const finalCanvas = document.createElement('canvas');

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      if (exportGeneration !== myExportGen) break;
      await exportPage(pageNum, outPdf, font, fontRegistry, exportWorker, exportScale, renderCanvas, finalCanvas, deferredAnnotations, myExportGen, totalPages);
    }

    renderCanvas.width = 0;
    finalCanvas.width = 0;

    if (exportGeneration !== myExportGen) {
      if (exportWorker) exportWorker.terminate().catch(() => {});
      return;
    }

    if (exportWorker) {
      await exportWorker.terminate();
    }

    for (const { outPage, annotations } of deferredAnnotations) {
      if (exportGeneration !== myExportGen) return;
      await embedLinkAnnotations(outPdf, outPage, annotations, destinationViewports);
    }
    deferredAnnotations.length = 0; // release refs before the heavy save() call
    if (exportGeneration !== myExportGen) return;

    await embedDocumentOutline(outPdf, destinationViewports);
    if (exportGeneration !== myExportGen) return;

    outPdf.setProducer('veil (https://veil.simoneamico.com)');
    outPdf.setCreator('veil');
    let pdfBytes = await outPdf.save();
    if (exportGeneration !== myExportGen) {
      pdfBytes = null;
      outPdf = null;
      return;
    }
    hideExportProgress();

    // Reset per-export font registry. The PDFFont objects are tied to
    // this specific outPdf instance and can't be reused. The font bytes
    // stay in fontBytesCache for the next export
    for (const key of Object.keys(fontRegistry)) delete fontRegistry[key];

    // Aggressive memory release: a 200-page export accumulates ~300MB
    // of embedded JPEGs inside pdf-lib. Without nulling these references,
    // the GC can't collect them and the next export would start with a
    // dirty heap, getting progressively slower
    const filename = `${ctx.originalFileName}-dark.pdf`;
    let blob = new Blob([pdfBytes], { type: 'application/pdf' });
    pdfBytes = null;
    outPdf = null;

    const url = URL.createObjectURL(blob);
    blob = null;
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // createObjectURL reserves the PDF bytes in RAM. revokeObjectURL
    // tells the browser it can free that memory. If I revoked immediately
    // after a.click(), the browser might not have started copying to disk
    // yet and the save would fail. If I never revoked, the memory would
    // stay occupied until the tab closes. 5 seconds is more than enough
    // for a RAM-to-disk copy, then the memory is released
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    ctx.announce('Export complete');

  } catch (err) {
    if (exportGeneration === myExportGen) {
      console.error('Export failed:', err);
      hideExportProgress();
      ctx.showError('Export failed. Please try again.');
    }
  } finally {
    if (exportGeneration === myExportGen) {
      exporting = false;
      ctx.btnExport.disabled = false;
    }
  }
}
