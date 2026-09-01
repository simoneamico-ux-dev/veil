/* DESIGN
   ------
   * This file handles everything related to OCR (Optical Character
   * Recognition) in veil. When a PDF is scanned (just images, no
   * native text), the user can't select or copy anything. This module
   * runs Tesseract.js (a neural network compiled to WebAssembly) in a
   * Web Worker to recognize text in those images, then builds a
   * transparent text layer on top so the text becomes selectable.
   *
   * I also run OCR on individual images inside native PDFs (charts,
   * diagrams, screenshots). No other PDF reader does this: the text
   * inside a bar chart or a photographed whiteboard becomes selectable.
   *
   * The module communicates with app.js through a context object (ctx)
   * passed via initOcr(). This avoids circular imports: app.js imports
   * from ocr.js, never the reverse. The context provides read access
   * to app state (generation counters, page slots, scale) via getters.
   *
   * Key architectural decisions:
   *
   * - Priority queue (a queue that serves the most important job first,
   *   not the one that arrived first): when the user scrolls quickly 
   *   past 30 pages, each page enqueues an OCR job. Without prioritization, 
   *   page 30 (where the user stopped) would wait behind pages 2-29.
   *   The queue sorts by distance from the current visible page before 
   *   each job.
   *
   * - Fingerprint deduplication: many PDFs repeat the same image (logo,
   *   header, watermark) on every page. I hash an 8x8 grid of pixel
   *   samples to create a lightweight fingerprint. If the same image
   *   appears on another page, OCR is skipped entirely.
   *
   * - Text heuristic: before sending an image to Tesseract (expensive,
   *   ~2-3 seconds), I check if it likely contains text by measuring
   *   edge density. Photos and gradients have low edge density and get
   *   skipped. Both fingerprint and text detection run from the same
   *   getImageData call, halving GPU readbacks.
   *
   * - Canvas preprocessing: converting to grayscale and boosting
   *   contrast before OCR improves recognition accuracy. Tesseract's
   *   documentation recommends this, and testing on real medical
   *   documents confirmed measurable improvement (e.g. "17:28" became
   *   the correct "17:25" after preprocessing).
   *
   * - Vertical text: chart Y-axis labels and rotated annotations are
   *   recognized in a separate pass with the canvas rotated 90 degrees.
   *   This pass runs on-demand (triggered by Option/Alt key) to avoid
   *   doubling the OCR workload automatically.
   *
   * The file follows this flow:
   *
   * 1. CONSTANTS (line 73)
   * 2. MODULE STATE (line 93)
   * 3. INITIALIZATION AND PUBLIC API (line 107)
   * 4. PREPROCESSING (line 141)
   * 5. FINGERPRINTING AND TEXT DETECTION (line 176)
   * 6. QUEUE PROCESSOR (line 256)
   * 7. TESSERACT WORKER (line 305)
   * 8. IMAGE REGION OCR (line 358)
   * 9. OCR TEXT LAYER BUILDER (line 565)
   * 10. TEXT LAYER SCHEDULING (line 734)
*/

import {
  OCR_CONFIDENCE_THRESHOLD,
  normalizeLigatures,
  isOcrArtifact,
  detectLanguageFromText,
  getNavigatorLanguage,
} from './core.js';


// --- CONSTANTS ---

// Minimum rendering scale for OCR. Display canvases on Retina (DPR 2)
// produce ~144 DPI, but Tesseract needs at least 200 DPI for reliable
// recognition. Scale 3 gives ~216 DPI. If the display canvas is below
// this, I render a separate high-res canvas just for Tesseract
const OCR_MIN_SCALE = 3;

// Grayscale + contrast preprocessing. Tesseract's docs recommend
// binarizing the image before recognition. 1.4x contrast sharpens
// the edges between text and background without clipping
const OCR_CONTRAST = 1.4;

// Maximum images to OCR automatically per page. Pages with 10+ charts
// would otherwise queue 20+ Tesseract jobs (2 passes each). The largest
// images are processed first (most likely to contain useful text).
// Remaining images get OCR'd on-demand when the user clicks them
const OCR_IMAGE_BUDGET = 6;


// --- MODULE STATE ---

let tesseractWorker = null;   // shared Tesseract.js worker (created once, lives for the session)
let tesseractLoading = false; // prevents multiple workers from being created simultaneously
const ocrCache = new Map();   // cacheKey -> Tesseract result data (survives page eviction)
const ocrFingerprints = new Map(); // image hash -> true (skip duplicate images across pages)
const ocrQueue = [];          // priority queue of pending OCR jobs
let ocrProcessing = false;    // true while the queue consumer is running

// App context, set once via initOcr(). Provides read access to app
// state without circular imports (app.js imports us, never the reverse)
let ctx = null;


// --- INITIALIZATION AND PUBLIC API ---

export function initOcr(appContext) {
  ctx = appContext;
}

export { ocrCache, ocrFingerprints, ocrQueue };

// preserveCache: during engine reset (memory pressure on iOS), I cancel
// all pending jobs but keep the OCR results already computed. Without this,
// every engine reset would force re-OCR of pages the user already visited
export function resetOcrState(preserveCache = false) {
  ocrQueue.forEach(j => { j.cancelled = true; });
  ocrQueue.length = 0;
  if (!preserveCache) {
    ocrCache.clear();
    ocrFingerprints.clear();
  }
}

export function enqueueOcrJob(job) {
  ocrQueue.push(job);
  processOcrQueue();
}

export function cancelOcrJobsForPage(pageNum) {
  for (const job of ocrQueue) {
    if (job.pageNum === pageNum) {
      job.cancelled = true;
    }
  }
}


// --- PREPROCESSING ---

/*
 * Converts the canvas to grayscale and boosts contrast before sending
 * to Tesseract. I use ctx.filter when the browser supports it (Chrome,
 * Firefox) for GPU-accelerated processing. On Safari, where ctx.filter
 * doesn't actually apply during drawImage, I fall back to manual
 * pixel manipulation with the same BT.601 luminance formula used
 * in the already-dark detection (see core.js)
 */
export function preprocessCanvasForOcr(sourceCanvas) {
  const c = document.createElement('canvas');
  c.width = sourceCanvas.width;
  c.height = sourceCanvas.height;
  const ctxC = c.getContext('2d');

  if (ctx.supportsCtxFilter) {
    ctxC.filter = `grayscale(1) contrast(${OCR_CONTRAST})`;
    ctxC.drawImage(sourceCanvas, 0, 0);
  } else {
    ctxC.drawImage(sourceCanvas, 0, 0);
    const imgData = ctxC.getImageData(0, 0, c.width, c.height);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const grey = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
      const c1 = (grey - 128) * OCR_CONTRAST + 128;
      const v = Math.max(0, Math.min(255, c1));
      d[i] = d[i+1] = d[i+2] = v;
    }
    ctxC.putImageData(imgData, 0, 0);
  }
  return c;
}


// --- FINGERPRINTING AND TEXT DETECTION ---

/*
 * Analyzes an image region in a single GPU readback (one getImageData
 * call instead of two). Returns both a fingerprint for deduplication
 * and a text likelihood score.
 *
 * The fingerprint samples an 8x8 grid of pixels and hashes their
 * colors. If the same hash appears on another page (e.g. a company
 * logo repeated on every page), Tesseract is skipped entirely.
 *
 * The text heuristic samples pixels across the image and counts
 * how many have a sharp brightness change next to them (an "edge").
 * Text and charts produce many edges, photos and gradients produce
 * few. If more than 1.5% of sampled pixels have edges, the image
 * likely contains text and gets sent to Tesseract. Below that,
 * it's probably a photo and gets skipped
 */
function analyzeImageRegion(canvas) {
  const w = canvas.width;
  const h = canvas.height;

  // Too small for either analysis
  if (w < 8 || h < 8) return { fingerprint: null, likelyText: false };

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, w, h).data;

  // --- Fingerprint: 8×8 grid hash ---
  const stepX = Math.floor(w / 8);
  const stepY = Math.floor(h / 8);
  let hash = '';
  for (let fy = 0; fy < 8; fy++) {
    for (let fx = 0; fx < 8; fx++) {
      const idx = (fy * stepY * w + fx * stepX) * 4;
      hash += ((data[idx] >> 4) << 8 | (data[idx + 1] >> 4) << 4 | (data[idx + 2] >> 4)).toString(36);
    }
  }

  // --- Text detection: edge density ---
  let likelyText = false;
  if (w >= 50 && h >= 50) {
    const step = Math.max(4, Math.floor(Math.min(w, h) / 60));
    let edges = 0;
    let samples = 0;
    const lum = (i) => data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;

    for (let y = step; y < h - step; y += step) {
      for (let x = step; x < w - step; x += step) {
        const idx = (y * w + x) * 4;
        const idxR = (y * w + x + step) * 4;
        const idxD = ((y + step) * w + x) * 4;
        if (idxR < data.length && idxD < data.length) {
          const l = lum(idx);
          const diffH = Math.abs(l - lum(idxR));
          const diffV = Math.abs(l - lum(idxD));
          if (diffH > 40 || diffV > 40) edges++;
          samples++;
        }
      }
    }
    likelyText = samples > 0 && (edges / samples) > 0.015;
  }

  return { fingerprint: hash, likelyText };
}

// A result is "valid" if it has at least one word that passes all three
// filters: non-empty text, confidence above threshold, and not an artifact.
// Without this check, Tesseract garbage from stamps and borders would
// create empty or misleading text layer regions
function hasValidOcrWords(data) {
  return (data.words || []).some(
    w => w.text && w.text.trim() &&
         w.confidence >= OCR_CONFIDENCE_THRESHOLD &&
         !isOcrArtifact(w.text)
  );
}


// --- QUEUE PROCESSOR ---

/*
 * Processes OCR jobs one at a time, always picking the job closest
 * to the page the user is currently viewing. This is inspired by
 * Google Maps' tile loading: when you pan the map, tiles near the
 * center load first, not the ones you scrolled past.
 *
 * Each job checks for cancellation before executing. When a page is
 * evicted (scrolled far away), its jobs are cancelled in the queue
 * so Tesseract never wastes time on pages the user has already left
 */
async function processOcrQueue() {
  if (ocrProcessing) return;
  ocrProcessing = true;

  while (ocrQueue.length > 0) {
    const visPage = ctx.currentVisiblePage || 1;
    ocrQueue.sort((a, b) => {
      const da = Math.abs(a.pageNum - visPage);
      const db = Math.abs(b.pageNum - visPage);
      return da - db;
    });

    let job = null;
    while (ocrQueue.length > 0) {
      const candidate = ocrQueue.shift();
      if (!candidate.cancelled) {
        job = candidate;
        break;
      }
    }
    if (!job) break;

    try {
      await job.execute();
    } catch (err) {
      console.warn('OCR job failed:', err);
    } finally {
      const slot = ctx.pageSlots.get(job.pageNum);
      // Clean up the indicator universally (handles silent early-returns too)
      if (slot) ctx.ocrFinished(slot);
    }
  }

  ocrProcessing = false;
}


// --- TESSERACT WORKER ---

/*
 * Creates or returns the shared Tesseract worker. The worker is
 * loaded lazily (only when OCR is actually needed) and lives for
 * the entire session. I load the language model based on the user's
 * OS language (see getNavigatorLanguage in core.js) so the first
 * OCR run already uses the right language without a detection pass.
 *
 * The polling loop (while tesseractLoading) handles the case where
 * multiple pages trigger OCR simultaneously: only the first call
 * creates the worker, the rest wait for it to finish
 */
export async function ensureTesseractWorker() {
  if (tesseractWorker) return tesseractWorker;
  if (tesseractLoading) {
    while (tesseractLoading) {
      await new Promise(r => setTimeout(r, 100));
    }
    return tesseractWorker;
  }

  tesseractLoading = true;
  try {
    const navLang = getNavigatorLanguage();
    const langs = navLang ? 'eng+' + navLang : 'eng';
    tesseractWorker = await createTesseractWorker(langs);

    return tesseractWorker;
  } catch (err) {
    console.warn('Tesseract.js failed to load:', err);
    return null;
  } finally {
    tesseractLoading = false;
  }
}

export async function createTesseractWorker(langs) {
  const mod = await import(ctx.DEPS.TESSERACT);
  const createWorker = mod.createWorker || (mod.default && mod.default.createWorker);
  if (!createWorker) throw new Error('createWorker not found in Tesseract module');

  return createWorker(langs, 1, {
    workerPath: ctx.DEPS.TESSERACT_WORKER,
    corePath: ctx.DEPS.TESSERACT_CORE,
    langPath: ctx.DEPS.TESSERACT_LANG,
    cachePath: 'veil-tesseract-4.0.0_best_int',
    workerBlobURL: false, // Keep the worker inside the same-origin CSP
    logger: () => {},
  });
}


// --- IMAGE REGION OCR ---

/*
 * OCR on individual images inside native PDFs. For each image region
 * (chart, diagram, screenshot), I extract the pixels, check the
 * fingerprint cache, run the text heuristic, preprocess, and send
 * to Tesseract. The recognized text becomes a selectable overlay
 * positioned exactly over the image.
 *
 * Every step checks globalGeneration to abort if the user opened a
 * new PDF or resized the window while OCR was running. Every step
 * also checks that the container slot still belongs to this page
 * (virtual scrolling can recycle the container mid-OCR)
 */

function rotateCanvas90CW(source) {
  const rotated = document.createElement('canvas');
  rotated.width = source.height;
  rotated.height = source.width;
  const rCtx = rotated.getContext('2d');
  rCtx.translate(rotated.width, 0);
  rCtx.rotate(Math.PI / 2);
  rCtx.drawImage(source, 0, 0);
  return rotated;
}

export async function ocrImageRegions(currentSlot, regions, dpr, myGen, pageNum) {
  if (regions.length === 0) return;

  for (const region of regions) {
    if (ctx.globalGeneration !== myGen) return;
    if (ctx.pageSlots.get(pageNum) !== currentSlot) return; // Stale closure abort

    const worker = await ensureTesseractWorker();
    if (!worker || ctx.globalGeneration !== myGen) return;

    const mainCanvas = currentSlot.mainCanvas;
    const textLayerDiv = currentSlot.textLayer;

    const sx = Math.max(0, region.x);
    const sy = Math.max(0, region.y);
    const sw = Math.min(region.width, mainCanvas.width - sx);
    const sh = Math.min(region.height, mainCanvas.height - sy);
    if (sw <= 0 || sh <= 0) continue;

    const regionCssX = sx / dpr;
    const regionCssY = sy / dpr;
    const regionCssW = sw / dpr;
    const regionCssH = sh / dpr;

    const cacheKey = `img-${pageNum}-${Math.round(sx)}-${Math.round(sy)}`;
    const cached = ocrCache.get(cacheKey);

    let data;
    if (cached) {
      data = cached;
    } else {
      const regionCanvas = document.createElement('canvas');
      regionCanvas.width = sw;
      regionCanvas.height = sh;
      regionCanvas.getContext('2d', { willReadFrequently: true }).drawImage(
        mainCanvas, sx, sy, sw, sh, 0, 0, sw, sh
      );

      // Fingerprint and text detection in one call. Reading pixels from
      // a canvas (getImageData) is slow because the browser must copy
      // data from the GPU to the CPU. I do it once and reuse the pixels
      // for both analyses instead of reading them twice
      const { fingerprint: fp, likelyText } = analyzeImageRegion(regionCanvas);

      // Skip images too small for analysis (< 8x8px after scaling).
      // Setting canvas.width = 0 releases the GPU backing store memory.
      // I do this throughout this file whenever a temporary canvas is
      // no longer needed, especially on mobile where VRAM is limited
      if (!fp) {
        regionCanvas.width = 0;
        continue;
      }

      if (ocrFingerprints.has(fp)) {
        regionCanvas.width = 0;
        continue;
      }

      if (!likelyText) {
        regionCanvas.width = 0;
        ocrFingerprints.set(fp, true);
        continue;
      }

      const processed0 = preprocessCanvasForOcr(regionCanvas);
      regionCanvas.width = 0;
      try {
        const result = await worker.recognize(processed0);
        data = result.data;
        processed0.width = 0;

        if (ctx.globalGeneration !== myGen) return;
        ocrCache.set(cacheKey, data);
        if (fp) ocrFingerprints.set(fp, true);
      } catch (err) {
        processed0.width = 0;
        if (ctx.globalGeneration !== myGen) return;
        continue;
      }
    }

    if (hasValidOcrWords(data)) {
      const div0 = document.createElement('div');
      div0.className = 'ocr-image-region';
      div0.style.position = 'absolute';
      div0.style.left = regionCssX + 'px';
      div0.style.top = regionCssY + 'px';
      div0.style.width = regionCssW + 'px';
      div0.style.height = regionCssH + 'px';
      div0.style.overflow = 'hidden';

      buildOcrTextLayerDirect(div0, data, sw, sh, regionCssW, regionCssH);

      if (div0.querySelector('span:not([data-gap])')) {
        textLayerDiv.appendChild(div0);
      }
    }

    if (ctx.globalGeneration !== myGen) return;
  }
}

/*
 * Vertical text pass: rotates the image 90 degrees clockwise before
 * sending to Tesseract. This catches Y-axis labels, rotated annotations,
 * and vertical captions that the horizontal pass misses entirely.
 *
 * I don't run this automatically because it doubles the OCR work per
 * image. Instead, it triggers on the keydown of Option/Alt, not on the
 * drag itself. The key press is the user's signal of intent: they're
 * about to select vertical text. By starting OCR at that moment (~2-3
 * seconds), the text layer is already ready by the time they actually
 * drag to select. The user perceives it as instant.
 *
 * The recognized text layer is rotated back (-90deg CSS transform)
 * so it aligns visually with the original vertical text in the image
 */
export async function ocrImageVertical(mainCanvas, verticalLayerDiv, region, dpr, myGen) {
  const sx = Math.max(0, region.x);
  const sy = Math.max(0, region.y);
  const sw = Math.min(region.width, mainCanvas.width - sx);
  const sh = Math.min(region.height, mainCanvas.height - sy);
  if (sw <= 0 || sh <= 0) return;

  const regionCanvas = document.createElement('canvas');
  regionCanvas.width = sw;
  regionCanvas.height = sh;
  regionCanvas.getContext('2d', { willReadFrequently: true }).drawImage(
    mainCanvas, sx, sy, sw, sh, 0, 0, sw, sh
  );

  const rotated = rotateCanvas90CW(regionCanvas);
  regionCanvas.width = 0;

  const worker = await ensureTesseractWorker();
  if (!worker || ctx.globalGeneration !== myGen) { rotated.width = 0; return; }

  const processed90 = preprocessCanvasForOcr(rotated);
  rotated.width = 0;

  try {
    const { data } = await worker.recognize(processed90);
    processed90.width = 0;

    if (ctx.globalGeneration !== myGen) return;

    if (hasValidOcrWords(data)) {
      const regionCssX = sx / dpr;
      const regionCssY = sy / dpr;
      const regionCssW = sw / dpr;
      const regionCssH = sh / dpr;
      const rotCssW = regionCssH;
      const rotCssH = regionCssW;

      const div90 = document.createElement('div');
      div90.className = 'ocr-image-region ocr-image-region-rotated';
      div90.style.position = 'absolute';

      const centerX = regionCssX + regionCssW / 2;
      const centerY = regionCssY + regionCssH / 2;
      div90.style.left = (centerX - rotCssW / 2) + 'px';
      div90.style.top = (centerY - rotCssH / 2) + 'px';
      div90.style.width = rotCssW + 'px';
      div90.style.height = rotCssH + 'px';
      div90.style.overflow = 'hidden';
      div90.style.transform = 'rotate(-90deg)';
      div90.style.transformOrigin = 'center center';

      buildOcrTextLayerDirect(div90, data, sh, sw, rotCssW, rotCssH);

      if (div90.querySelector('span:not([data-gap])')) {
        verticalLayerDiv.appendChild(div90);
      }
    }
  } catch (e) {
    console.warn('[OCR] Vertical pass failed:', e);
    processed90.width = 0;
  }
}


// --- OCR TEXT LAYER BUILDER ---

/*
 * Builds a transparent text layer from Tesseract's OCR results.
 * Each recognized word becomes a span positioned over the scanned
 * text in the canvas. The spans are invisible (color: transparent)
 * but selectable, so the user can highlight and copy text from
 * a scanned document as if it were a native PDF.
 *
 * I use Tesseract's own line grouping (data.lines) rather than
 * grouping words manually. Tesseract's layout engine understands
 * the original document structure (columns, paragraphs, tables)
 * better than a simple geometric threshold on Y coordinates.
 *
 * The "two cursors" pattern:
 *
 * Each line needs two different heights, and a single variable
 * can't serve both purposes:
 *
 * 1. Visual height (how tall the blue selection highlight appears).
 *    This must be tight around the text (fontSize). If it's too
 *    tall, the highlight shows ugly bars between lines.
 *
 * 2. Reserved space (how far the next line must start to avoid
 *    overlapping). This must be the full bounding box height
 *    (medianHeight), which includes the space above and below
 *    the text that Tesseract reports.
 *
 * I track both independently:
 *   actualDomBottom = where the div physically ends in the DOM
 *   logicalReservedBottom = where the "reserved space" ends
 *
 * The marginTop of the next div is calculated from actualDomBottom
 * (so the DOM flows correctly), but the next line can't start
 * above logicalReservedBottom (so lines never overlap)
 */
export function buildOcrTextLayerDirect(container, ocrData, canvasW, canvasH, cssW, cssH) {
  container.innerHTML = '';

  const scaleX = cssW / canvasW;
  const scaleY = cssH / canvasH;

  const ocrLines = ocrData.lines || [];
  const flatWords = ocrData.words || [];

  const linesToProcess = ocrLines.length > 0
    ? ocrLines
    : [{ words: flatWords, baseline: null }];

  const fragment = document.createDocumentFragment();
  const measureCtx = document.createElement('canvas').getContext('2d');

  let actualDomBottom = 0;
  let logicalReservedBottom = 0;

  for (const line of linesToProcess) {
    const words = (line.words || [])
      .filter(w => w.text && w.text.trim() && w.confidence >= OCR_CONFIDENCE_THRESHOLD && !isOcrArtifact(w.text));

    if (words.length === 0) continue;

    words.sort((a, b) => a.bbox.x0 - b.bbox.x0);

    const wordHeights = words.map(w => (w.bbox.y1 - w.bbox.y0) * scaleY);
    wordHeights.sort((a, b) => a - b);
    const medianHeight = wordHeights[Math.floor(wordHeights.length / 2)];
    // Tesseract's bounding boxes include padding above and below the text
    // (ascenders, descenders, and extra margin). The actual text fills
    // roughly 85% of the bbox height. Without this factor, the spans
    // would be taller than the visible text and misalign vertically
    const fontSize = medianHeight * 0.85;

    if (fontSize < 1) continue;

    let baselineY;
    if (line.baseline && line.baseline.y0 != null) {
      baselineY = ((line.baseline.y0 + line.baseline.y1) / 2) * scaleY;
    } else {
      // Fallback when Tesseract doesn't provide baseline data: estimate
      // it from the average top of words plus 78% of the line height.
      // In most Latin fonts, the baseline sits at roughly 75-80% of
      // the total line height from the top (ascenders above, descenders below)
      const medianY0 = words.reduce((s, w) => s + w.bbox.y0, 0) / words.length;
      baselineY = (medianY0 * scaleY) + medianHeight * 0.78;
    }

    const lineTop = baselineY - fontSize;

    const lineDiv = document.createElement('div');
    lineDiv.className = 'text-line';
    lineDiv.style.fontSize = fontSize + 'px';

    const targetTop = Math.max(logicalReservedBottom, lineTop);

    const margin = targetTop - actualDomBottom;
    lineDiv.style.marginTop = margin + 'px';

    lineDiv.style.height = fontSize + 'px';

    actualDomBottom = targetTop + fontSize;
    logicalReservedBottom = targetTop + medianHeight;

    measureCtx.font = `${fontSize}px sans-serif`;

    let prevWordEnd = 0;

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const wordText = normalizeLigatures(word.text);

      // Insert a space character between words for copy/paste. The space
      // has fontSize 0 so it takes zero width in the layout (each word
      // is positioned by its own marginLeft from OCR coordinates). But
      // getSelection().toString() still includes it, so copied text
      // has proper spaces between words
      if (i > 0) {
        const gap = document.createElement('span');
        gap.textContent = ' ';
        gap.style.fontSize = '0';
        gap.dataset.gap = '';
        lineDiv.appendChild(gap);
      }

      const span = document.createElement('span');
      span.textContent = wordText;
      span.style.fontSize = fontSize + 'px';

      const wordLeft = word.bbox.x0 * scaleX;
      const wordMargin = wordLeft - prevWordEnd;
      if (Math.abs(wordMargin) > 0.5) {
        span.style.marginLeft = wordMargin + 'px';
      }

      // Match the span's width to the OCR bounding box. The text inside
      // the span has a "natural" width (how wide sans-serif renders it),
      // which may differ from how wide the word appears in the scanned
      // image. scaleX stretches or compresses the span horizontally so
      // the selection highlight covers exactly the right area.
      // Same technique used in the native text layer (see buildTextLayer
      // in app.js) for the same reason
      const wordWidth = (word.bbox.x1 - word.bbox.x0) * scaleX;
      if (wordWidth > 0) {
        const naturalWidth = measureCtx.measureText(wordText).width;
        if (naturalWidth > 0) {
          span.style.display = 'inline-block';
          span.style.width = wordWidth + 'px';
          span.style.transform = `scaleX(${wordWidth / naturalWidth})`;
          span.style.transformOrigin = 'left top';
        }
      }

      prevWordEnd = wordLeft + wordWidth;

      lineDiv.appendChild(span);
    }

    // Constrain line width to actual text content so WebKit/Safari
    // doesn't extend the selection highlight to the full page width
    if (prevWordEnd > 0) {
      lineDiv.style.width = prevWordEnd + 'px';
    }

    fragment.appendChild(lineDiv);
  }

  container.appendChild(fragment);
}


// --- TEXT LAYER SCHEDULING ---

/*
 * The bridge between the rendering pipeline (app.js) and OCR. After
 * a page is rendered, this function decides what to do with the text:
 *
 * - Scanned document: check the OCR cache first. On cache hit, build
 *   the text layer instantly. On miss, enqueue an OCR job (Tesseract
 *   will process it when the queue reaches this page).
 *
 * - Native PDF: build the text layer from PDF.js textContent (instant,
 *   no OCR needed). Then enqueue OCR jobs for any images on the page
 *   (charts, diagrams) up to OCR_IMAGE_BUDGET.
 *
 * This function also manages the renderCanvas lifecycle: it must be
 * returned to the pool (ctx.returnCanvas) when no longer needed, or
 * passed to the OCR job which returns it after use
 */
export function scheduleTextLayer(slot, state, pageNum, page, renderCanvas, textContent, scaledViewport, regions, w, h, dpr, myGen) {
  const cssW = Math.floor(w / dpr);
  const cssH = Math.floor(h / dpr);

  if (ctx.isScannedDocument) {
    const cacheKey = `page-${pageNum}`;
    const cached = ocrCache.get(cacheKey);
    if (cached) {
      // Cache hit, renderCanvas not needed, return it to the pool
      ctx.returnCanvas(renderCanvas);
      buildOcrTextLayerDirect(
        slot.textLayer, cached, cached._canvasW, cached._canvasH, cssW, cssH
      );
    } else {
      state.ocrInProgress = true;
      state._ocrStartTime = Date.now();
      const effectiveScale = ctx.currentScale * dpr;

      enqueueOcrJob({
        id: cacheKey,
        pageNum,
        cancelled: false,
        execute: async () => {
          if (ctx.globalGeneration !== myGen) { ctx.returnCanvas(renderCanvas); return; }

          let ocrCanvas;
          let ocrCanvasIsBorrowed = false;
          if (effectiveScale >= OCR_MIN_SCALE) {
            ocrCanvas = renderCanvas;
            ocrCanvasIsBorrowed = true; // this IS the pool canvas
          } else {
            // Scale too low for OCR, return the borrowed canvas to the pool
            // and create a dedicated high-res canvas for Tesseract.
            ctx.returnCanvas(renderCanvas);
            const ocrViewport = page.getViewport({ scale: OCR_MIN_SCALE });
            ocrCanvas = ctx.createOffscreenCanvas(
              Math.floor(ocrViewport.width),
              Math.floor(ocrViewport.height)
            );
            await page.render({
              canvasContext: ocrCanvas.getContext('2d'),
              viewport: ocrViewport,
            }).promise;
            if (ctx.globalGeneration !== myGen) { ocrCanvas.width = 0; return; }
          }

          const worker = await ensureTesseractWorker();
          if (!worker || ctx.globalGeneration !== myGen) {
            if (ocrCanvasIsBorrowed) ctx.returnCanvas(ocrCanvas);
            else ocrCanvas.width = 0;
            return;
          }

          const processed = preprocessCanvasForOcr(ocrCanvas);
          if (ocrCanvasIsBorrowed) ctx.returnCanvas(ocrCanvas);
          else ocrCanvas.width = 0;

          const { data } = await worker.recognize(processed);

          if (ctx.globalGeneration !== myGen) { processed.width = 0; return; }

          data._canvasW = processed.width;
          data._canvasH = processed.height;
          ocrCache.set(cacheKey, data);

          const currentSlot = ctx.pageSlots.get(pageNum);
          if (currentSlot) {
            buildOcrTextLayerDirect(
              currentSlot.textLayer, data, processed.width, processed.height, cssW, cssH
            );
          }
        },
      });
    }
    return;
  }

  // Native PDF: build text layer from PDF.js textContent
  ctx.buildTextLayer(slot.textLayer, textContent, scaledViewport, dpr);
  ctx.returnCanvas(renderCanvas);

  // OCR on images within native PDFs
  if (regions.length > 0) {
    // Filter out tiny images (icons, decorations, bullets) that are
    // too small to contain readable text. Area >= 4000px ensures a
    // minimum meaningful size (e.g. 80x50 or 100x40). The 20px minimum
    // on each dimension accepts narrow shapes like axis labels
    const candidates = regions
      .filter(r => (r.width * r.height >= 4000) && r.width >= 20 && r.height >= 20)
      .sort((a, b) => (b.width * b.height) - (a.width * a.height));

    state.imageRegionsRaw = candidates.map(r => ({ ...r }));
    state.imageRegionsCss = candidates.map(r => ({
      x: Math.max(0, r.x) / dpr,
      y: Math.max(0, r.y) / dpr,
      w: Math.min(r.width, w - Math.max(0, r.x)) / dpr,
      h: Math.min(r.height, h - Math.max(0, r.y)) / dpr,
    }));

    const autoOcr = candidates.slice(0, OCR_IMAGE_BUDGET);
    if (autoOcr.length > 0) {
      state.ocrInProgress = true;
      state._ocrStartTime = Date.now();

      enqueueOcrJob({
        id: `img-${pageNum}`,
        pageNum,
        cancelled: false,
        execute: async () => {
          const currentSlot = ctx.pageSlots.get(pageNum);
          if (!currentSlot) return;
          await ocrImageRegions(
            currentSlot,
            autoOcr.map(r => ({ ...r })), dpr, myGen, pageNum
          );
        },
      });
    }
  }
}
