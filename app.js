/* DESIGN
   ------
   * This is the main orchestrator of veil. It wires together the
   * rendering pipeline, the UI, and the browser APIs into a single
   * sequential flow. I deliberately kept it as one file rather than
   * splitting into app-render.js, app-ui.js, etc. because the state
   * is shared and the functions are intrinsically coupled: focus mode
   * needs to know about scroll, zoom needs to know about rendering,
   * rendering needs to know about eviction. Splitting would distribute
   * the complexity across files without reducing it, and the resulting
   * modules would not be reusable or independently testable. The
   * modules I did extract (core.js, ocr.js, export.js, session.js, assets.js)
   * are genuinely independent and can be taken into another project.
   *
   * The pure functions live in core.js, the OCR pipeline in ocr.js,
   * the export in export.js, the session persistence in session.js.
   * This file is the glue that connects them to the DOM and to
   * each other.
   *
   * State is organized in 4 objects declared at the top of the file:
   * - pdfState: the loaded document, its geometry, and rendering state
   * - renderPipeline: the canvas pool, render queue, and spacer element
   * - scrollState: velocity detection and presentation mode
   * - uiState: focus mode timers, error timeouts, zoom hints
   *
   * Key architectural decisions:
   *
   * - Virtual scrolling with recycled containers: instead of creating
   *   one DOM container per page (which exhausted GPU memory on 500+
   *   page documents), I maintain a pool of 7-15 containers that get
   *   repositioned as the user scrolls. The document appears continuous
   *   but only a handful of pages exist in the DOM at any time
   *
   * - Canvas pool: reusable offscreen canvases for PDF.js rendering.
   *   Borrowing and returning canvases instead of creating new ones
   *   avoids GPU context allocation churn on every page render
   *
   * - Engine reset on memory-constrained devices: PDF.js accumulates
   *   internal state (font programs, decoded images, XRef tables) in
   *   its worker thread. After a threshold of page renders (15 on
   *   large documents on iOS and Android with 4GB or less RAM, 40 on
   *   desktop), I destroy and recreate the entire PDF.js instance to
   *   release that state. The user never notices because the visible
   *   canvases stay painted during the reset
   *
   * - Unified scroll coordinator: a single scroll listener reads
   *   scrollTop once per frame and dispatches to velocity detection,
   *   container reconciliation, and page position saving. Three
   *   separate listeners were causing 6-15ms of layout reflow per
   *   frame on Android budget devices
   *
   * - Focus mode: the toolbar auto-hides after 1.5 seconds (2.5 on
   *   mobile) to maximize reading space. Scroll does NOT interrupt
   *   focus mode because reading (scrolling through pages) is the
   *   primary action. The toolbar returns on mouse near top edge,
   *   tap in the top zone, or Tab key (with a longer 6-second timeout
   *   for keyboard users who need more time to navigate)
   *
   * - File System Access API on desktop: when the user picks a file
   *   via the file picker, I store a lightweight file handle (~30
   *   bytes) in IndexedDB. On next visit, the browser asks permission
   *   to re-read the original file from disk, zero duplication. Safari
   *   doesn't support this API, so dropped files there fall back to
   *   the mobile path. Mobile stores the full ArrayBuffer in IndexedDB
   *   (up to 120MB). The file lives on the device's storage (not RAM),
   *   but at boot the entire buffer must be deserialized into RAM to
   *   give it to PDF.js. 120MB is the limit where a budget tablet can
   *   still deserialize without running out of memory before the UI
   *   appears
   *
   * - Clean clipboard: the copy event is intercepted to strip the
   *   invisible text layer's styling (color:transparent, dark
   *   background). The pasted text arrives in the target app's
   *   default font with no veil artifacts
   *
   * The test suite (412 unit + 86 e2e) acts as the "eyes" for this
   * file, following Salvatore Sanfilippo's (antirez) insight that
   * without tests, a coding agent iterates blind. The pure functions
   * are tested in core.js. The integration (does the page render,
   * is text selectable, does export produce a valid PDF) is tested
   * via Playwright e2e.
   *
   * If you read from top to bottom, you're reading the story of what
   * happens when a user opens veil and drops a PDF.
   *
   * The file follows this flow:
   *
   * 1. CONSTANTS (line 238)
   * 2. STATE (line 328)
   * 3. DOM REFERENCES (line 361)
   * 4. FOCUS MODE (line 413)
   * 5. ERROR DISPLAY (line 577)
   * 6. SESSION PERSISTENCE (line 637)
   * 7. FILE HANDLING (line 905)
   * 8. PDF LOADING (line 951)
   * 9. SCANNED DOCUMENT DETECTION (line 1032)
   * 10. OCR LOADING INDICATOR (line 1091)
   * 11. CLEANUP (line 1382)
   * 12. SCALE CALCULATION (line 1394)
   * 13. VIRTUAL SCROLLING (line 1423)
   *     Page geometry, container pool, reconciliation, eviction
   * 14. DEVICE DETECTION AND MEMORY PROFILES (line 1858)
   * 15. UNIFIED SCROLL COORDINATOR (line 1906)
   * 16. CANVAS POOL (line 1958)
   * 17. ENGINE RESET (line 2002)
   * 18. RENDER QUEUE (line 2094)
   * 19. PAGE RENDERING (line 2171)
   * 20. ALREADY-DARK DETECTION (line 2335)
   * 21. TEXT LAYER (line 2353)
   *     Single-column: flow layout with paddingTop advancement.
   *     Multi-column: detected via backward Y jump in content stream,
   *     rendered with flex-row wrapper keeping everything in flow.
   * 22. MULTI-COLUMN HELPERS (line 2509)
   *     Column detection, order-preserving grouping, line builder
   * 23. LINK ANNOTATION LAYER (line 2735)
   * 24. DARK MODE LOGIC (line 2841)
   * 25. CURRENT PAGE TRACKING (line 2877)
   * 26. TOGGLE BUTTON STATE (line 2909)
   * 27. NAVIGATION (line 2937)
   * 28. EVENT LISTENERS (line 3040)
   *     Option/Alt OCR, drop zone, toolbar, keyboard, presentation
   * 29. ZOOM (line 3266)
   * 30. RESIZE (line 3394)
   * 31. APP SHELL LOADER AND BOOTSTRAP (line 3461)
*/

const vendorAsset = (path) => new URL(`./vendor/${path}`, import.meta.url).href;
const notoFont = (fileName) => vendorAsset(
  `fonts/noto/76fff9eee60dcef8381bfcae8d0b4311e2186e67/${fileName}`,
);
const multipartFont = (fileName, totalBytes) => ({
  parts: [
    vendorAsset(`fonts/noto-cjk/2.004/${fileName}.part-00`),
    vendorAsset(`fonts/noto-cjk/2.004/${fileName}.part-01`),
  ],
  totalBytes,
});

// Optional export and OCR assets remain lazy-loaded from versioned local paths
const DEPS = {
  PDFJS_WORKER:    vendorAsset('pdfjs/5.4.149/pdf.worker.min.mjs'),
  TESSERACT:       vendorAsset('tesseract.js/5.1.1/tesseract.esm.min.js'),
  TESSERACT_WORKER: vendorAsset('tesseract.js/5.1.1/worker.min.js'),
  TESSERACT_CORE:  vendorAsset('tesseract-core/5.1.1'),
  TESSERACT_LANG:  vendorAsset('tesseract-data/4.0.0_best_int'),
  PDF_LIB:         vendorAsset('pdf-lib/1.17.1/pdf-lib.esm.min.js'),
  FONTKIT:         vendorAsset('fontkit/1.1.1/fontkit.esm.js'),
  NOTO_SANS:       notoFont('NotoSans-Regular.ttf'),

  // Script-specific Noto Sans variants for export text layer.
  // Each is lazy-loaded only when a document contains that script.
  // Keys match SCRIPT_FONT_MAP in export.js
  NOTO_SANS_ARABIC:     notoFont('NotoSansArabic-Regular.ttf'),
  NOTO_SANS_HEBREW:     notoFont('NotoSansHebrew-Regular.ttf'),
  NOTO_SANS_DEVANAGARI: notoFont('NotoSansDevanagari-Regular.ttf'),
  NOTO_SANS_BENGALI:    notoFont('NotoSansBengali-Regular.ttf'),
  NOTO_SANS_GURMUKHI:   notoFont('NotoSansGurmukhi-Regular.ttf'),
  NOTO_SANS_GUJARATI:   notoFont('NotoSansGujarati-Regular.ttf'),
  NOTO_SANS_TAMIL:      notoFont('NotoSansTamil-Regular.ttf'),
  NOTO_SANS_TELUGU:     notoFont('NotoSansTelugu-Regular.ttf'),
  NOTO_SANS_KANNADA:    notoFont('NotoSansKannada-Regular.ttf'),
  NOTO_SANS_MALAYALAM:  notoFont('NotoSansMalayalam-Regular.ttf'),
  NOTO_SANS_SINHALA:    notoFont('NotoSansSinhala-Regular.ttf'),
  NOTO_SANS_THAI:       notoFont('NotoSansThai-Regular.ttf'),
  NOTO_SANS_LAO:        notoFont('NotoSansLao-Regular.ttf'),
  NOTO_SANS_TIBETAN:    notoFont('NotoSerifTibetan-Regular.ttf'),
  NOTO_SANS_MYANMAR:    notoFont('NotoSansMyanmar-Regular.ttf'),
  NOTO_SANS_GEORGIAN:   notoFont('NotoSansGeorgian-Regular.ttf'),
  NOTO_SANS_ARMENIAN:   notoFont('NotoSansArmenian-Regular.ttf'),
  NOTO_SANS_ETHIOPIC:   notoFont('NotoSansEthiopic-Regular.ttf'),
  NOTO_SANS_KHMER:      notoFont('NotoSansKhmer-Regular.ttf'),
  NOTO_SANS_JP:         multipartFont('NotoSansCJKjp-Regular.otf', 16467736),
  NOTO_SANS_KR:         multipartFont('NotoSansCJKkr-Regular.otf', 16433112),
  NOTO_SANS_SC:         multipartFont('NotoSansCJKsc-Regular.otf', 16437364),
};

import * as pdfjsLib from './vendor/pdfjs/5.4.149/pdf.min.mjs';

import {
  initExport,
  exportDarkPdf,
  cancelExport,
  hideExportProgress,
} from './export.js';

import {
  saveSession,
  loadSession,
  clearSession,
  SESSION_MAX_SIZE,
  hasFileSystemAccess,
} from './session.js';

import {
  initOcr,
  resetOcrState,
  enqueueOcrJob,
  cancelOcrJobsForPage,
  ocrCache,
  ocrFingerprints,
  ocrQueue,
  ocrImageRegions,
  ocrImageVertical,
  ensureTesseractWorker,
  preprocessCanvasForOcr,
  buildOcrTextLayerDirect,
  scheduleTextLayer,
} from './ocr.js';

import {
  IDENTITY_MATRIX,
  DARK_LUMINANCE_THRESHOLD,
  SCAN_IMAGE_COVERAGE_THRESHOLD,
  SCAN_TEXT_CHAR_THRESHOLD,
  OCR_CONFIDENCE_THRESHOLD,
  multiplyMatrices,
  transformPoint,
  computeImageBounds,
  extractImageRegions as _extractImageRegions,
  compositeImageRegions,
  detectAlreadyDark as _detectAlreadyDark,
  shouldApplyDark as _shouldApplyDark,
  normalizeLigatures,
  mergePunctuation,
  groupItemsIntoLines,
  shouldInsertSpace,
  calculateScale as _calculateScale,
  isScannedPattern,
  isOcrArtifact,
  isBlankPaper,
  OCR_OVERLAY_COVERAGE_THRESHOLD,
  OCR_OVERLAY_CHAR_THRESHOLD,
} from './core.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = DEPS.PDFJS_WORKER;


// --- CONSTANTS ---

/*
 * Yield to the UI thread without setTimeout.
 *
 * In background tabs, browsers throttle setTimeout to a minimum
 * of 1 second per call. For a 352-page export, that's 352 extra
 * seconds of dead waiting. MessageChannel.postMessage is NOT
 * throttled, it fires at full speed regardless of tab visibility.
 *
 * This is the same technique React Scheduler uses internally for
 * its concurrent mode work loop.
 */
const yieldToUI = (() => {
  const channel = new MessageChannel();
  return () => new Promise(resolve => {
    channel.port1.onmessage = resolve;
    channel.port2.postMessage(null);
  });
})();

const OPS = pdfjsLib.OPS;

// OPS map for core.extractImageRegions (decouples core from pdfjsLib)
const OPS_MAP = {
  save: OPS.save,
  restore: OPS.restore,
  transform: OPS.transform,
  paintFormXObjectBegin: OPS.paintFormXObjectBegin,
  paintFormXObjectEnd: OPS.paintFormXObjectEnd,
  paintImageXObject: OPS.paintImageXObject,
  paintInlineImageXObject: OPS.paintInlineImageXObject,
  paintImageXObjectRepeat: OPS.paintImageXObjectRepeat,
};

// How many pages around the visible area to pre-render.
// Memory-constrained (iOS, budget Android ≤4GB): 1 page.
// Other devices: 2 pages.
const _memConstrainedEarly = (
  window.matchMedia('(pointer: coarse)').matches &&
  (/iPad|iPhone/.test(navigator.userAgent) || (navigator.deviceMemory && navigator.deviceMemory <= 4))
);

// Feature-detect ctx.filter support (Safari iOS ignores it silently)
const supportsCtxFilter = (() => {
  try {
    const src = document.createElement('canvas');
    src.width = 1; src.height = 1;
    const srcCtx = src.getContext('2d');
    srcCtx.fillStyle = '#ff0000';
    srcCtx.fillRect(0, 0, 1, 1);
    const dst = document.createElement('canvas');
    dst.width = 1; dst.height = 1;
    const dstCtx = dst.getContext('2d');
    dstCtx.filter = 'invert(1)';
    dstCtx.drawImage(src, 0, 0);
    const px = dstCtx.getImageData(0, 0, 1, 1).data;
    return px[0] < 128 && px[1] > 128;
  } catch (_) { return false; }
})();

/*
 * Where does the browser place the baseline (the invisible line
 * where letters "sit") inside a text line? Letters like "g" and "p"
 * hang below it (descenders), letters like "h" and "l" rise above
 * it (ascenders). The exact position depends on the OS and font.
 *
 * I measure this at runtime by drawing text on a hidden canvas and
 * reading fontBoundingBoxAscent (how far above the baseline the font
 * reaches) and fontBoundingBoxDescent (how far below). The ratio
 * tells us what fraction of the font size is above the baseline.
 *
 * Without this, the text layer would be vertically misaligned with
 * the canvas on some operating systems. The measurement is done once
 * at 100px for precision (the /200 is because 2 * 100px fontSize)
 */
const BASELINE_RATIO = (() => {
  try {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.font = '100px sans-serif';
    const m = ctx.measureText('Hg');
    if (m.fontBoundingBoxAscent != null && m.fontBoundingBoxDescent != null) {
      return 0.5 + (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 200;
    }
  } catch (e) { /* fall through */ }
  return 0.85; // safe fallback
})();


// --- STATE ---

const pdfState = {
  doc: null,
  scale: 0,
  buffer: null,              // raw bytes for iOS engine reset
  geometry: [],              // [{cssWidth, cssHeight, offsetTop}] per page (1-based)
  generation: 0,             // monotonic counter for stale detection
  isScanned: false,
  fileName: 'document',
  largeDocConstrained: false,
  currentPage: 1,
  darkOverride: new Map(),   // 'auto' | 'dark' | 'light' per page
  alreadyDark: new Map(),    // boolean per page
  slots: new Map(),          // pageNum -> pool container
  renderState: new Map(),    // pageNum -> {rendered, rendering, ...}
  zoomMultiplier: parseFloat(localStorage.getItem('veil-zoom')) || 1.0,
  get renderScale() {
    // On phone landscape, always render at 1x, fit-to-width is optimal.
    // Foldable/tablet landscape keeps user zoom (screens are tall enough).
    const zoom = (typeof isPhoneLandscape === 'function' && isPhoneLandscape())
      ? 1 : this.zoomMultiplier;
    return this.scale * zoom;
  },
};
// Desktop: generous pool for fluid scrolling (RAM is abundant).
// Mobile: tight pool to minimize canvas context memory pressure.
const POOL_SIZE = _memConstrainedEarly ? 5 : window.matchMedia('(pointer: fine)').matches ? 15 : 7;
const VIRTUAL_BUFFER = _memConstrainedEarly ? 1 : window.matchMedia('(pointer: fine)').matches ? 5 : 2;
const PAGE_GAP = 40; // px between pages (matches CSS gap)
const VIEWPORT_PADDING_TOP = 64; // space for floating toolbar


// --- DOM REFERENCES ---

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const readerEl = document.getElementById('reader');

// Screen reader announcements
const srAnnouncer = document.getElementById('sr-announcer');
function announce(message) {
  if (!srAnnouncer) return;
  srAnnouncer.textContent = '';
  requestAnimationFrame(() => { srAnnouncer.textContent = message; });
}
const btnHome = document.getElementById('btn-home');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const btnToggle = document.getElementById('btn-toggle');
const pageInfo = document.getElementById('page-info');
const iconDark = document.getElementById('icon-dark');
const iconLight = document.getElementById('icon-light');
const viewport = document.getElementById('viewport');
const btnExport = document.getElementById('btn-export');
const exportProgressEl = document.getElementById('export-progress');
const exportProgressFill = document.querySelector('.export-progress-fill');
const exportProgressText = document.querySelector('.export-progress-text');
const exportCancelBtn = document.getElementById('export-cancel');
const errorBanner = document.getElementById('error-banner');
const infoBanner = document.getElementById('info-banner');
const infoMessage = document.getElementById('info-message');

// iOS detection, all browsers on iOS use WebKit (Apple policy),
// so they ALL share the same Jetsam memory limits. This detects
// the device, not the browser engine.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// Detect true mobile OS (phones and tablets, not 2-in-1 laptops).
// Surface Pro / Chromebook with touch pass through, they have
// desktop-class RAM and browser capabilities for export.
const isMobileOS = isIOS || /Android|HarmonyOS|Mobile|Opera Mini/i.test(navigator.userAgent);

// Hide export on mobile, browser sandbox memory limits make
// Tesseract OCR + PDF generation crash on documents over ~50 pages.
if (isMobileOS) {
  btnExport.style.display = 'none';
}

const errorMessage = document.getElementById('error-message');
const errorDismiss = document.getElementById('error-dismiss');
const fileNameEl = document.getElementById('file-name');
const toolbar = document.getElementById('toolbar');


// --- FOCUS MODE ---

/*
 * After 1.5 seconds of inactivity (2.5 on mobile), the toolbar
 * fades out and the reader becomes pure content. I deliberately
 * chose not to reset the timer on scroll because reading IS
 * scrolling. Only explicit interactions bring it back: mouse near
 * the top edge (300ms dwell to avoid accidental triggers), tap in
 * the top zone on mobile, or Tab key (with a longer 6-second
 * timeout for keyboard users who may need more time to navigate
 * between buttons)
 */

const uiState = {
  focusTimer: null,
  focusPaused: false,
  hoverTimer: null,
  mouseMoveThrottled: false,
  errorTimeout: null,
  infoTimeout: null,
  zoomHintShown: false,
  hasZoomedIn: false,
  savePageTimer: null,
  ocrPressTimer: null,
  ocrPressStartX: 0,
  ocrPressStartY: 0,
  resizeTimer: null,
};
// On mobile, the user needs more time to decide what to tap.
const FOCUS_DELAY = window.matchMedia('(pointer: coarse)').matches ? 2500 : 1500;
const TOOLBAR_TRIGGER_ZONE = 35; // px from top edge
const TOOLBAR_HOVER_DELAY = 300; // ms mouse must stay in zone

function enterFocusMode() {
  if (!readerEl || readerEl.hidden || uiState.focusPaused) return;
  toolbar.classList.add('toolbar-hidden');
  // Remove toolbar elements from tab order when hidden
  toolbar.querySelectorAll('button, a, [tabindex]').forEach(el => {
    el.setAttribute('tabindex', '-1');
  });
}

function exitFocusMode() {
  // In phone landscape the viewport is very short (~350px). The
  // toolbar trigger zone (top 35px) overlaps with where the user
  // is reading and selecting text. Scrolling up or trying to
  // select text near the top of the page would constantly trigger
  // the toolbar. I keep it hidden entirely in landscape and the
  // user rotates to portrait for toolbar actions
  if (isPhoneLandscape()) return;
  toolbar.classList.remove('toolbar-hidden');
  // Restore toolbar elements to tab order
  toolbar.querySelectorAll('button, a, [tabindex="-1"]').forEach(el => {
    el.removeAttribute('tabindex');
  });
  resetFocusTimer();
}

function resetFocusTimer() {
  if (uiState.focusTimer) clearTimeout(uiState.focusTimer);
  uiState.focusTimer = setTimeout(() => { uiState.focusTimer = null; enterFocusMode(); }, FOCUS_DELAY);
}

/*
 * The toolbar reappears when the mouse stays in the top 35px for
 * at least 300ms. If the mouse just passes through quickly (e.g.
 * moving to the browser tab bar), the toolbar stays hidden.
 * Throttled with requestAnimationFrame so the mousemove handler
 * doesn't fire hundreds of times per second during trackpad scrolling
 */

document.addEventListener('mousemove', (e) => {
  if (uiState.mouseMoveThrottled || !readerEl || readerEl.hidden) return;
  uiState.mouseMoveThrottled = true;
  requestAnimationFrame(() => { uiState.mouseMoveThrottled = false; });

  // Is the mouse over the toolbar or in the trigger zone?
  const toolbarRect = toolbar.getBoundingClientRect();
  const overToolbar = e.clientY <= toolbarRect.bottom + 5 &&
    e.clientX >= toolbarRect.left - 10 && e.clientX <= toolbarRect.right + 10;

  if (e.clientY <= TOOLBAR_TRIGGER_ZONE || overToolbar) {
    if (toolbar.classList.contains('toolbar-hidden') && !uiState.hoverTimer) {
      uiState.hoverTimer = setTimeout(() => {
        uiState.hoverTimer = null;
        exitFocusMode();
      }, TOOLBAR_HOVER_DELAY);
    }
  } else {
    if (uiState.hoverTimer) {
      clearTimeout(uiState.hoverTimer);
      uiState.hoverTimer = null;
    }
  }

  // Toolbar visible: keep it while mouse is over it, hide timer when away
  if (!toolbar.classList.contains('toolbar-hidden')) {
    if (overToolbar) {
      clearTimeout(uiState.focusTimer);
    } else {
      resetFocusTimer();
    }
  }
}, { passive: true });

/*
 * Touch: after tapping a toolbar button, restart the auto-hide timer.
 * On touch devices, the :hover state persists after tap (there's no
 * mouseout event), so the mousemove handler above sees overToolbar=true
 * forever and keeps cancelling the hide timer. This click handler
 * overrides that by explicitly restarting the countdown
 */
toolbar.addEventListener('click', () => {
  if (window.matchMedia('(pointer: coarse)').matches) {
    resetFocusTimer();
  }
});

// Touch: tap in the top zone when toolbar is hidden reveals it.
// In mobile landscape the toolbar is completely hidden (no reveal
// mechanism), the user rotates to portrait for toolbar actions.
document.addEventListener('touchstart', (e) => {
  if (!readerEl || readerEl.hidden) return;
  if (!toolbar.classList.contains('toolbar-hidden')) return;
  if (isPhoneLandscape()) return;

  const touch = e.touches[0];
  if (touch && touch.clientY <= TOOLBAR_TRIGGER_ZONE * 2) {
    e.preventDefault();
    exitFocusMode();
  }
}, { passive: false });

/*
 * Keyboard shortcuts:
 * - Tab reveals the toolbar when hidden (accessibility). The timer
 *   is longer (6 seconds vs 1.5) because keyboard users, especially
 *   those with motor impairments, need more time to navigate between
 *   buttons. Each Tab resets the timer so it never expires while the
 *   user is still navigating
 * - F toggles focus mode manually (show/hide toolbar)
 */
const FOCUS_DELAY_KEYBOARD = 6000;

document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !readerEl.hidden) {
    if (toolbar.classList.contains('toolbar-hidden')) {
      exitFocusMode();
    }
    clearTimeout(uiState.focusTimer);
    uiState.focusTimer = setTimeout(() => { uiState.focusTimer = null; enterFocusMode(); }, FOCUS_DELAY_KEYBOARD);
  }
  if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey
      && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
    if (toolbar.classList.contains('toolbar-hidden')) {
      exitFocusMode();
    } else {
      clearTimeout(uiState.focusTimer);
      enterFocusMode();
    }
  }
});


// --- ERROR DISPLAY ---

function showError(msg, duration = 8000) {
  errorMessage.textContent = msg;
  errorBanner.hidden = false;
  if (uiState.errorTimeout) clearTimeout(uiState.errorTimeout);
  if (duration > 0) {
    uiState.errorTimeout = setTimeout(() => { errorBanner.hidden = true; }, duration);
  }
}

errorDismiss.addEventListener('click', () => {
  errorBanner.hidden = true;
  if (uiState.errorTimeout) clearTimeout(uiState.errorTimeout);
});


function showInfo(msg, duration = 6000) {
  infoMessage.textContent = msg;
  infoBanner.hidden = false;
  if (uiState.infoTimeout) clearTimeout(uiState.infoTimeout);
  if (duration > 0) {
    uiState.infoTimeout = setTimeout(() => { infoBanner.hidden = true; }, duration);
  }
}

// Dismiss info banner on tap (mobile)
infoBanner.addEventListener('click', () => {
  infoBanner.hidden = true;
  if (uiState.infoTimeout) clearTimeout(uiState.infoTimeout);
});

/*
 * Pinch-to-zoom hint: on mobile portrait, pages are rendered at a
 * lower scale than landscape so they look blurry when zoomed in.
 * I show the hint on zoom-OUT (not zoom-in) because during zoom-in
 * the user's viewport is magnified and shifted, so a banner would
 * appear off-screen or in an unexpected position. On zoom-out, the
 * user returns to the normal view and sees the suggestion naturally.
 * It's also the moment they realize the quality wasn't enough.
 * Shown once per session, only in portrait (no point suggesting
 * landscape if already in landscape)
 */
if (window.matchMedia('(pointer: coarse)').matches && window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    if (uiState.zoomHintShown || !pdfState.doc) return;
    // Don't suggest landscape if already in landscape
    if (window.matchMedia('(orientation: landscape)').matches) return;
    const scale = window.visualViewport.scale;
    if (scale > 1.2) {
      uiState.hasZoomedIn = true;
    } else if (uiState.hasZoomedIn && scale < 1.1) {
      uiState.hasZoomedIn = false;
      uiState.zoomHintShown = true;
      showInfo('For best visual quality, try landscape mode.', 8000);
    }
  });
}


// --- SESSION PERSISTENCE ---

/*
 * Hybrid architecture for resuming where the user left off:
 * - Desktop (File System Access API): saves a file handle (~30
 *   bytes) in IndexedDB. On resume, the browser asks permission
 *   and reads the original file from disk. Zero duplication
 * - Mobile: saves the full ArrayBuffer in IndexedDB. Only one PDF
 *   at a time (each save clears the previous, see session.js).
 *   Files above 120MB are not saved to avoid a RAM spike when
 *   deserializing at boot
 * - Both: page number + filename in localStorage so the user
 *   returns to the exact page they were reading
 *
 * For files too large to save in IndexedDB (above 120MB), I still
 * save the filename and page number in localStorage. On next visit,
 * the drop zone shows "You were on page X" with the filename. When
 * the user drops the same file again, the filename matches and veil
 * automatically jumps to the saved page. One gesture to recover the
 * full session, even without the file being stored.
 *
 * I chose not to show a warning ("file too large to save") because
 * it would scare the user without offering an action. The silent
 * fallback gives them the best possible experience without asking
 * them to worry about storage limits
 */

function savePagePosition() {
  if (!pdfState.doc) return;
  localStorage.setItem('veil-page', String(pdfState.currentPage));

  // Persist dark mode overrides (pages manually toggled by the user)
  const overrides = {};
  for (const [pageNum, mode] of pdfState.darkOverride) {
    if (mode !== 'auto') overrides[pageNum] = mode;
  }
  if (Object.keys(overrides).length > 0) {
    localStorage.setItem('veil-dark-overrides', JSON.stringify(overrides));
  } else {
    localStorage.removeItem('veil-dark-overrides');
  }
}

// Page position saving is handled by the unified scroll coordinator below

async function persistFile(file, arrayBuffer) {
  const filename = file.name;

  if (hasFileSystemAccess && file._handle) {
    // Desktop: save the lightweight file handle (~30 bytes)
    localStorage.setItem('veil-filename', filename);
    localStorage.setItem('veil-page', '1');
    await saveSession({ type: 'handle', handle: file._handle, filename });
  } else if (arrayBuffer.byteLength <= SESSION_MAX_SIZE) {
    // Mobile: save the full ArrayBuffer (one at a time, previous is cleared)
    localStorage.setItem('veil-filename', filename);
    localStorage.setItem('veil-page', '1');
    await saveSession({ type: 'buffer', buffer: arrayBuffer, filename });
  } else {
    // Too large for IndexedDB, graceful fallback (see block comment above)
    await clearSession();
    localStorage.setItem('veil-filename', filename);
    localStorage.setItem('veil-page', '1');
  }
}

async function restoreSession(forceButton = false) {
  const loader = document.getElementById('app-loader');
  const savedFilename = localStorage.getItem('veil-filename');
  const savedPage = parseInt(localStorage.getItem('veil-page'), 10) || 1;

  if (!savedFilename) return false;

  const sessionData = await loadSession();
  if (!sessionData) {
    if (forceButton && pdfState.buffer) {
      // User clicked "veil" while reading a large file, the PDF is
      // still in memory even though it wasn't persisted to IndexedDB.
      // Show a clickable resume button that reloads from the buffer.
      showResumeButton(savedFilename, async () => {
        try {
          if (loader) loader.hidden = false;
          pdfState.fileName = savedFilename.replace(/\.pdf$/i, '');
          if (fileNameEl) fileNameEl.textContent = savedFilename;
          document.title = `veil - ${savedFilename}`;
          await loadPDF(new Uint8Array(pdfState.buffer), savedPage);
          if (loader) loader.hidden = true;
        } catch (_) {
          if (loader) loader.hidden = true;
          hideResumeButton();
        }
      });
    } else {
      showResumeReminder(savedFilename, savedPage);
    }
    return false;
  }

  try {
    if (sessionData.type === 'handle') {
      /*
       * Desktop File System Access API: requestPermission() requires
       * a user gesture (Transient User Activation). We cannot call it
       * at page load, Chrome silently denies it. Instead, show a
       * resume button on the drop zone. The user clicks once, the
       * browser approves, and the file loads from disk.
       */
      showResumeButton(savedFilename, async () => {
        try {
          const permission = await sessionData.handle.requestPermission({ mode: 'read' });
          if (permission !== 'granted') { clearSession(); return; }
          const file = await sessionData.handle.getFile();
          const buffer = await file.arrayBuffer();
          if (loader) loader.hidden = false;
          pdfState.fileName = savedFilename.replace(/\.pdf$/i, '');
          if (fileNameEl) fileNameEl.textContent = savedFilename;
          document.title = `veil - ${savedFilename}`;
          await loadPDF(new Uint8Array(buffer), savedPage);
          if (loader) loader.hidden = true;
        } catch (err) {
          if (loader) loader.hidden = true;
          clearSession();
          hideResumeButton();
        }
      });
      return false; // drop zone stays visible (with resume button)
    } else if (sessionData.type === 'buffer') {
      if (forceButton) {
        // User explicitly returned to drop zone, show resume button
        showResumeButton(savedFilename, async () => {
          try {
            if (loader) loader.hidden = false;
            pdfState.fileName = savedFilename.replace(/\.pdf$/i, '');
            if (fileNameEl) fileNameEl.textContent = savedFilename;
            document.title = `veil - ${savedFilename}`;
            await loadPDF(new Uint8Array(sessionData.buffer), savedPage);
            if (loader) loader.hidden = true;
          } catch (err) {
            if (loader) loader.hidden = true;
            clearSession();
            hideResumeButton();
          }
        });
        return false;
      }
      // Natural reopen, auto-restore without click
      if (loader) loader.hidden = false;
      pdfState.fileName = savedFilename.replace(/\.pdf$/i, '');
      if (fileNameEl) fileNameEl.textContent = savedFilename;
      document.title = `veil - ${savedFilename}`;
      await loadPDF(new Uint8Array(sessionData.buffer), savedPage);
      if (loader) loader.hidden = true;
      return true;
    }
  } catch (err) {
    if (loader) loader.hidden = true;
    clearSession();
    return false;
  }

  return false;
}

function showResumeButton(filename, onClick) {
  const existing = document.getElementById('resume-section');
  if (existing) existing.remove();

  const savedPage = parseInt(localStorage.getItem('veil-page'), 10) || 1;

  const section = document.createElement('div');
  section.id = 'resume-section';
  section.className = 'drop-resume-section';
  section.role = 'button';
  section.tabIndex = 0;
  section.setAttribute('aria-label', `Resume reading ${filename}`);
  const label = document.createElement('p');
  label.className = 'drop-resume-label';
  label.textContent = 'Pick up where you left off';
  const fname = document.createElement('p');
  fname.className = 'drop-resume-filename';
  fname.textContent = filename;
  const page = document.createElement('p');
  page.className = 'drop-resume-page';
  page.textContent = `Page ${savedPage}`;
  section.append(label, fname, page);
  // Empty touchstart enables :active on iOS Safari
  section.addEventListener('touchstart', () => {}, { passive: true });
  function activateResume(e) {
    e.stopPropagation();
    section.querySelector('.drop-resume-label').textContent = 'Loading...';
    onClick();
  }
  section.addEventListener('click', activateResume);
  section.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activateResume(e);
    }
  });

  const hero = document.querySelector('.drop-hero');
  if (hero) hero.appendChild(section);

  // Hide "Browse PDF" button and tagline when resume is shown
  const browseBtn = document.querySelector('.drop-browse-btn');
  if (browseBtn) browseBtn.style.display = 'none';
  document.querySelectorAll('.drop-tagline').forEach(el => el.style.display = 'none');

  // Add "or open a different file" below
  const altExisting = document.getElementById('drop-alt-action');
  if (altExisting) altExisting.remove();
  const alt = document.createElement('label');
  alt.id = 'drop-alt-action';
  alt.className = 'drop-alt-action';
  alt.htmlFor = 'file-input';
  alt.textContent = 'or open a different file';
  // Empty touchstart enables :active on iOS Safari
  alt.addEventListener('touchstart', () => {}, { passive: true });
  hero.appendChild(alt);
}

function showResumeReminder(filename, savedPage) {
  // Non-actionable resume: the file wasn't stored (too large for IndexedDB)
  // but we remember the filename and page. Shows where the user was
  // with Browse PDF as the primary action to re-open the file.
  const existing = document.getElementById('resume-section');
  if (existing) existing.remove();

  const section = document.createElement('div');
  section.id = 'resume-section';
  section.className = 'drop-resume-section';
  section.style.cursor = 'default';
  section.style.pointerEvents = 'none';
  section.style.opacity = '0.5';

  const label = document.createElement('p');
  label.className = 'drop-resume-label';
  label.textContent = `You were on page ${savedPage}`;
  const fname = document.createElement('p');
  fname.className = 'drop-resume-filename';
  fname.textContent = filename;
  section.append(label, fname);

  const hero = document.querySelector('.drop-hero');
  if (hero) hero.appendChild(section);

  // Hide tagline, move Browse PDF below the reminder box
  document.querySelectorAll('.drop-tagline').forEach(el => el.style.display = 'none');
  const browseBtn = document.querySelector('.drop-browse-btn');
  if (browseBtn) {
    browseBtn.style.display = '';
    browseBtn.style.marginTop = '24px';
    hero.appendChild(browseBtn); // moves (not clones) after the section
  }
}

function hideResumeButton() {
  const section = document.getElementById('resume-section');
  if (section) section.remove();
  const alt = document.getElementById('drop-alt-action');
  if (alt) alt.remove();
  // Restore Browse PDF button and tagline
  const browseBtn = document.querySelector('.drop-browse-btn');
  if (browseBtn) browseBtn.style.display = '';
  document.querySelectorAll('.drop-tagline').forEach(el => el.style.display = '');
}


// --- FILE HANDLING ---

function handleFile(file) {
  if (!file) return;
  if (file.size === 0) {
    showError('This file is empty.');
    return;
  }
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) return;
  if (file.size > 512 * 1024 * 1024) {
    showError('This file is too large. Maximum size is 512 MB.');
    return;
  }
  hideResumeButton();
  announce('Loading document...');
  pdfState.fileName = file.name.replace(/\.pdf$/i, '');
  if (fileNameEl) fileNameEl.textContent = file.name;
  document.title = `veil - ${file.name}`;

  // Start focus mode timer when a PDF is loaded
  resetFocusTimer();

  // If reopening the same file, resume at the saved page
  const savedName = localStorage.getItem('veil-filename');
  const resumePage = (savedName && file.name === savedName)
    ? parseInt(localStorage.getItem('veil-page'), 10) || 1
    : 1;

  const fr = new FileReader();
  fr.onload = async (e) => {
    const arrayBuffer = e.target.result;
    // Copy the buffer BEFORE loadPDF, PDF.js may transfer (detach)
    // the original ArrayBuffer to its worker thread.
    const bufferCopy = arrayBuffer.slice(0);
    const success = await loadPDF(new Uint8Array(arrayBuffer), resumePage);
    // Only persist on success, a corrupted or password-protected PDF
    // must not be saved to IndexedDB, or the resume logic would
    // re-load a broken file on every app restart.
    if (success) {
      persistFile(file, bufferCopy);
    }
  };
  fr.readAsArrayBuffer(file);
}


// --- PDF LOADING ---

// Returns true if the PDF loaded successfully, false on error
async function loadPDF(data, resumePage = 1) {
  try {
    if (pdfState.doc) await pdfState.doc.destroy();
    cleanup();

    // Keep the original bytes for iOS document recreation.
    // PDF.js may transfer the buffer, so we keep our own copy.
    pdfState.buffer = data.slice(0);
    pdfState.doc = await pdfjsLib.getDocument({ data }).promise;
    pdfState.largeDocConstrained = _isMemoryConstrained && pdfState.doc.numPages > LARGE_DOC_THRESHOLD;
    pdfState.darkOverride.clear();
    pdfState.alreadyDark.clear();
    pdfState.isScanned = false;
    pdfState.generation++;

    // Cancel all pending render and OCR jobs from previous document
    resetOcrState();
    renderPipeline.queue.length = 0;
    scrollState.isFast = false;
    renderPipeline.sinceReset = 0;
    renderPipeline.resetPending = false;

    // Show the reader behind the drop zone, then animate the veil open.
    // The veil layers slide right while the reader renders underneath.
    readerEl.hidden = false;
    dropZone.classList.add('veil-opening');
    // After the longest layer finishes (1s), hide the drop zone entirely
    setTimeout(() => {
      dropZone.hidden = true;
      dropZone.classList.remove('veil-opening');
    }, 1050);

    // Detect scanned document before building pages
    pdfState.isScanned = await detectScannedDocument();

    await buildPageSlots();
    // Wait one frame for the browser to reflow the new spacer/pool DOM.
    // Without this, reconcileContainers() may see stale viewport dimensions
    // (especially after cleanup -> rebuild when returning from reader).
    await new Promise(r => requestAnimationFrame(r));
    // Scroll to the target page (page 1 for new files, saved page for resume)
    // Restore dark mode overrides from previous session
    const savedOverrides = localStorage.getItem('veil-dark-overrides');
    if (savedOverrides) {
      try {
        const overrides = JSON.parse(savedOverrides);
        for (const [pageNum, mode] of Object.entries(overrides)) {
          pdfState.darkOverride.set(parseInt(pageNum, 10), mode);
        }
      } catch (e) { console.warn('[Session] Failed to parse dark overrides:', e); }
    }

    scrollToPage(resumePage, true);
    reconcileContainers();
    updateCurrentPageFromScroll();
    checkPresentationMode();
    updateZoomUI();
    announce(`Document loaded, ${pdfState.doc.numPages} pages`);
    return true;

  } catch (err) {
    console.error('Failed to load PDF:', err);
    // Release any PDF.js resources allocated before the failure
    if (pdfState.doc) {
      try { pdfState.doc.cleanup(); } catch (_) {}
    }
    if (err?.name === 'PasswordException') {
      showError('This PDF is password-protected. Please unlock it first.');
    } else if (err?.name === 'InvalidPDFException') {
      showError('This file does not appear to be a valid PDF.');
    } else {
      showError('Could not load this PDF. The file may be corrupted.');
    }
    return false;
  }
}


// --- SCANNED DOCUMENT DETECTION ---

/*
 * Samples up to 5 pages spread across the document: always the
 * first, plus the last, 25%, 50%, and 75% positions depending
 * on document length. If ALL sampled pages have a single large
 * image covering >85% of the page area and <50 characters of
 * native text, the document is classified as scanned. When
 * scanned, image protection is skipped because the "image" IS
 * the text content: CSS inversion covers the entire page, turning
 * black-on-white scanned text into white-on-dark. OCR then runs
 * automatically to make the text selectable
 */

async function detectScannedDocument() {
  if (!pdfState.doc || pdfState.doc.numPages === 0) return false;

  // Pick sample pages spread across the document
  const numPages = pdfState.doc.numPages;
  const sampleIndices = new Set();
  sampleIndices.add(1); // first page always
  if (numPages >= 2) sampleIndices.add(numPages); // last
  if (numPages >= 4) sampleIndices.add(Math.floor(numPages * 0.25));
  if (numPages >= 6) sampleIndices.add(Math.floor(numPages * 0.5));
  if (numPages >= 8) sampleIndices.add(Math.floor(numPages * 0.75));

  const samplesToCheck = [...sampleIndices];
  const pageSamples = [];

  for (const pageNum of samplesToCheck) {
    const page = await pdfState.doc.getPage(pageNum);
    const vp = page.getViewport({ scale: 1 });
    const pageArea = vp.width * vp.height;

    const [opList, textContent] = await Promise.all([
      page.getOperatorList(),
      page.getTextContent(),
    ]);

    let charCount = 0;
    for (const item of textContent.items) {
      if (item.str) charCount += item.str.length;
    }

    const regions = extractImageRegions(opList, vp.transform);

    let maxCoverage = 0;
    for (const r of regions) {
      const coverage = (r.width * r.height) / pageArea;
      if (coverage > maxCoverage) maxCoverage = coverage;
    }

    pageSamples.push({ charCount, maxImageCoverage: maxCoverage });
  }

  return isScannedPattern(pageSamples);
}


// --- OCR LOADING INDICATOR ---

/*
 * The loading animation is deliberately invisible by default. It
 * only appears when the user tries to interact (select text) with
 * a page whose OCR hasn't finished yet. Most of the time, OCR
 * completes in the background before the user even tries, so they
 * never see the indicator. When they do, a warm amber light sweeps
 * along the page perimeter until the text becomes selectable.
 *
 * For scanned documents: the animation covers the entire page.
 * For native PDFs: it covers individual image regions (the body
 * text is already selectable, only images need OCR)
 */

function cleanupOcrIndicators(slot) {
  const fadeOut = (el) => {
    el.classList.add('ocr-done');
    setTimeout(() => {
      if (el.dataset.ocrLoading) {
        el.remove();
      } else {
        el.classList.remove('ocr-loading', 'ocr-done');
      }
    }, 650);
  };

  if (slot.element.classList.contains('ocr-loading')) {
    fadeOut(slot.element);
  }
  slot.element.querySelectorAll('[data-ocr-loading]').forEach(fadeOut);
}

function ocrFinished(slot) {
  const pageNum = slot.assignedPage;
  const state = pageNum != null ? pdfState.renderState.get(pageNum) : null;
  if (state) {
    state.ocrInProgress = false;
  }

  cleanupOcrIndicators(slot);
  setTimeout(() => cleanupOcrIndicators(slot), 100);
}

/*
 * Checks whether a CSS-space point (x,y relative to the page container)
 * falls inside one of the known image regions on this page
 */
function hitTestImageRegion(stateOrSlot, x, y) {
  for (const r of stateOrSlot.imageRegionsCss) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
      return r;
    }
  }
  return null;
}

/*
 * Shows the OCR loading animation when the user tries to select
 * text that isn't ready yet
 */
function showOcrLoading(slot, region) {
  const pageNum = slot.assignedPage;
  const state = pageNum != null ? pdfState.renderState.get(pageNum) : null;
  if (!state || !state.ocrInProgress) return;

  // Don't show the indicator if OCR started less than 500ms ago.
  // When Tesseract resources are cached by the service worker,
  // OCR finishes in 1-2 seconds. Showing the animation for half
  // a second and then removing it would be an unexplained flash
  if (state._ocrStartTime && (Date.now() - state._ocrStartTime) < 500) return;

  if (pdfState.isScanned) {
    if (!slot.element.classList.contains('ocr-loading')) {
      slot.element.classList.remove('ocr-done');
      slot.element.classList.add('ocr-loading');
    }
  } else if (region) {
    const key = `${Math.round(region.x)}-${Math.round(region.y)}`;
    if (slot.element.querySelector(`[data-ocr-loading="${key}"]`)) return;

    const indicator = document.createElement('div');
    indicator.className = 'ocr-loading';
    indicator.dataset.ocrLoading = key;
    indicator.style.position = 'absolute';
    indicator.style.left = region.x + 'px';
    indicator.style.top = region.y + 'px';
    indicator.style.width = region.w + 'px';
    indicator.style.height = region.h + 'px';
    indicator.style.pointerEvents = 'none';
    indicator.style.zIndex = '11';
    slot.element.appendChild(indicator);
  }
}

/*
 * If the user successfully selects text inside an OCR image region,
 * the OCR is ready, kill the indicator for that region.
 * We check that the selection is specifically inside an .ocr-image-region,
 * not in native text that happens to be adjacent to the image.
 */
document.addEventListener('selectionchange', () => {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return;

  const anchor = sel.anchorNode;
  if (!anchor) return;
  const el = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
  if (!el) return;

  // For scanned docs: any selection on the page means OCR worked
  if (pdfState.isScanned) {
    const container = el.closest('.page-container');
    if (!container) return;
    const pageNum = parseInt(container.dataset.pageNum, 10);
    const slot = pdfState.slots.get(pageNum);
    if (slot) cleanupOcrIndicators(slot);
    return;
  }

  // For native PDFs: only kill indicator if selection is inside an OCR image region
  const ocrRegion = el.closest('.ocr-image-region');
  if (!ocrRegion) return;

  const container = ocrRegion.closest('.page-container');
  if (!container) return;
  const pageNum = parseInt(container.dataset.pageNum, 10);
  const slot = pdfState.slots.get(pageNum);
  if (slot) cleanupOcrIndicators(slot);
});

/*
 * Clean clipboard on copy. Without this, pasting into Word, Pages,
 * Notion, Gmail, etc... would carry the text layer's invisible styles
 * (dark background + transparent text). I intercept the copy event
 * and set both text/plain (for code editors, terminals, LaTeX
 * tools) and text/html (for rich text apps like Word and Google
 * Docs). The pasted text arrives in the target app's default font
 * with no veil artifacts, regardless of where the user pastes it.
 *
 * For RTL lines (Arabic, Hebrew), I rebuild the text from the spans
 * sorted by coordinate instead of using the DOM order. The DOM sorts
 * spans left-to-right (for visual layout via marginLeft) but the
 * reading order is right-to-left. I detect RTL lines by checking
 * dir="rtl" on the parent text-line div, then collect the spans and
 * sort them by their left offset descending. This produces correct
 * reading order without changing the DOM structure
 */
document.addEventListener('copy', (e) => {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed) return;

  // I find the text layer by walking up from the selection anchor.
  // The commonAncestorContainer can be a text node (no .closest),
  // so I start from the parent element instead
  const range = sel.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;
  const el = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement;
  const textLayer = el ? (el.closest('.text-layer') || el.querySelector('.text-layer')) : null;

  const hasRtl = textLayer && textLayer.querySelector('.text-line[dir="rtl"]');

  if (!hasRtl) {
    // Fast path for LTR-only documents (no RTL text-lines found).
    // I still strip styles to avoid carrying invisible text artifacts
    const text = sel.toString();
    if (!text) return;
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    e.clipboardData.setData('text/plain', text);
    e.clipboardData.setData('text/html', escaped.split('\n').join('<br>'));
    e.preventDefault();
    return;
  }

  // RTL path: I rebuild the text from spans sorted by coordinate.
  // For RTL lines, spans are sorted by left offset descending
  // (right-to-left reading order). The HTML output wraps RTL lines
  // in <div dir="rtl"> so the receiving app (Pages, Word) right-aligns
  // the paragraph
  const plainLines = [];
  const htmlLines = [];
  const lineDivs = textLayer.querySelectorAll('.text-line');

  for (const lineDiv of lineDivs) {
    if (!sel.containsNode(lineDiv, true)) continue;

    const spans = [...lineDiv.querySelectorAll('span')]
      .filter(s => sel.containsNode(s, true));
    if (spans.length === 0) continue;

    const isRtlLine = lineDiv.dir === 'rtl';

    if (isRtlLine) {
      spans.sort((a, b) => b.offsetLeft - a.offsetLeft);
    }

    const lineText = spans.map(s => s.textContent.trim()).filter(Boolean).join(' ');
    if (!lineText) continue;

    plainLines.push(lineText);
    const escaped = lineText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    htmlLines.push(isRtlLine ? `<div dir="rtl">${escaped}</div>` : escaped);
  }

  const text = plainLines.length > 0 ? plainLines.join('\n') : sel.toString();
  const html = htmlLines.length > 0 ? htmlLines.join('\n') : text;

  if (!text) return;
  e.clipboardData.setData('text/plain', text);
  e.clipboardData.setData('text/html', html);
  e.preventDefault();
});

/*
 * Listen for selection attempts on pages with pending OCR.
 * On touch: require a long press (350ms hold without movement) to
 * distinguish "trying to select text" from "scrolling past".
 * On mouse/pen (stylus, like Samsung S Pen): trigger immediately
 * (no ambiguity with scroll, these are precision input devices).
 */
const OCR_PRESS_DELAY = 350; // ms, shorter than iOS native long press (500ms)

// A finger is never perfectly still on a touchscreen. Even when
// holding steady, natural hand tremor causes 2-5px of movement.
// 10px tolerates that tremor without confusing it with a scroll
const OCR_PRESS_MOVE_TOLERANCE = 10;

function triggerOcrIndicator(e) {
  const container = e.target.closest('.page-container');
  if (!container) return;

  const pageNum = parseInt(container.dataset.pageNum, 10);
  const slot = pdfState.slots.get(pageNum);
  const state = pdfState.renderState.get(pageNum);
  if (!slot || !state || !state.ocrInProgress) return;

  const rect = container.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  if (pdfState.isScanned) {
    showOcrLoading(slot, null);
  } else {
    const region = hitTestImageRegion(state, x, y);
    if (region) {
      showOcrLoading(slot, region);
    }
  }
}

document.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') {
    // Touch: start long press timer
    uiState.ocrPressStartX = e.clientX;
    uiState.ocrPressStartY = e.clientY;
    if (uiState.ocrPressTimer) clearTimeout(uiState.ocrPressTimer);
    uiState.ocrPressTimer = setTimeout(() => {
      uiState.ocrPressTimer = null;
      triggerOcrIndicator(e);
    }, OCR_PRESS_DELAY);
  } else {
    // Mouse/pen: immediate
    triggerOcrIndicator(e);
  }
});

document.addEventListener('pointermove', (e) => {
  if (!uiState.ocrPressTimer || e.pointerType !== 'touch') return;
  const dx = e.clientX - uiState.ocrPressStartX;
  const dy = e.clientY - uiState.ocrPressStartY;
  if (dx * dx + dy * dy > OCR_PRESS_MOVE_TOLERANCE * OCR_PRESS_MOVE_TOLERANCE) {
    clearTimeout(uiState.ocrPressTimer);
    uiState.ocrPressTimer = null;
  }
}, { passive: true });

document.addEventListener('pointerup', () => {
  if (uiState.ocrPressTimer) {
    clearTimeout(uiState.ocrPressTimer);
    uiState.ocrPressTimer = null;
  }
});

document.addEventListener('pointercancel', () => {
  if (uiState.ocrPressTimer) {
    clearTimeout(uiState.ocrPressTimer);
    uiState.ocrPressTimer = null;
  }
});


// --- CLEANUP ---

function cleanup() {
  viewport.innerHTML = '';
  pdfState.slots.clear();
  pdfState.renderState.clear();
  renderPipeline.pool.length = 0;
  pdfState.geometry = [null];
  renderPipeline.spacer = null;
}


// --- SCALE CALCULATION ---

// Height < 500px distinguishes phones from tablets in landscape.
// Phones get the toolbar hidden entirely (see exitFocusMode).
// Tablets have enough vertical space to keep it visible
function isPhoneLandscape() {
  return window.matchMedia('(pointer: coarse)').matches &&
    window.matchMedia('(orientation: landscape)').matches &&
    window.innerHeight < 500;
}

// Both phone and tablet in landscape use fit-to-width because
// on touch devices vertical scrolling within the page is natural
function isTouchLandscape() {
  return window.matchMedia('(pointer: coarse)').matches &&
    window.matchMedia('(orientation: landscape)').matches;
}

function calculateScale(page) {
  const vp = page.getViewport({ scale: 1 });
  const sidePadding = _isMobileDevice ? 0 : 16;
  return _calculateScale(
    vp.width, vp.height,
    window.innerWidth, window.innerHeight,
    48, sidePadding, _isMobileDevice
  );
}


// --- VIRTUAL SCROLLING ---

/*
 * The document looks like a continuous scroll of all pages, but only
 * 7 containers (mobile) or 15 containers (desktop) actually exist in
 * the DOM. As the user scrolls, containers are recycled: detached from
 * one page, repositioned, and assigned to another. A spacer div with
 * the correct total height gives the browser a native scrollbar that
 * behaves as if all pages were in the DOM.
 *
 * Without this, a 505-page PDF would create 1010 canvas elements
 * (2 per page: main + overlay). Each canvas holds GPU memory even
 * when empty. On the Samsung Tab S6 Lite (4GB RAM), one of the
 * devices I tested on, this alone crashed Chrome. With recycled
 * containers, memory stays constant regardless of document length
 */

const renderPipeline = {
  spacer: null,
  pool: [],
  queue: [],
  active: 0,
  sinceReset: 0,
  resetPending: false,
  resetting: false,
  debounceTimer: null,
  pendingSet: new Set(),
};

function createPoolContainer() {
  const container = document.createElement('div');
  container.className = 'page-container';
  container.style.position = 'absolute';
  container.style.left = '0';
  container.style.right = '0';
  container.style.margin = '0 auto';
  container.style.willChange = 'transform';
  container.style.display = 'none';

  const mainCanvas = document.createElement('canvas');
  mainCanvas.className = 'page-canvas';

  const overlayCanvas = document.createElement('canvas');
  overlayCanvas.className = 'page-overlay';

  const textLayer = document.createElement('div');
  textLayer.className = 'text-layer';

  const verticalOcrLayer = document.createElement('div');
  verticalOcrLayer.className = 'text-layer vertical-ocr-layer';

  const pageLabel = document.createElement('div');
  pageLabel.className = 'page-label';

  container.appendChild(mainCanvas);
  container.appendChild(overlayCanvas);
  container.appendChild(textLayer);
  container.appendChild(verticalOcrLayer);
  container.appendChild(pageLabel);

  return {
    element: container,
    mainCanvas,
    overlayCanvas,
    textLayer,
    verticalOcrLayer,
    pageLabel,
    assignedPage: null,
  };
}

function getOrCreateRenderState(pageNum) {
  let state = pdfState.renderState.get(pageNum);
  if (!state) {
    state = {
      rendered: false,
      rendering: false,
      renderGeneration: 0,
      ocrInProgress: false,
      imageRegionsCss: [],
      imageRegionsRaw: [],
      _renderTask: null,
    };
    pdfState.renderState.set(pageNum, state);
  }
  return state;
}

// Binary search: find first page whose bottom edge > viewTop.
// When the user clicks "veil" to go back and loads a new PDF,
// geometry gets cleared but the scroll listener still fires one
// last time. Without the guards, that last call would read an
// undefined entry and crash.
function binarySearchFirstVisible(viewTop) {
  if (!pdfState.doc) return 1;
  let lo = 1, hi = pdfState.doc.numPages;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const pg = pdfState.geometry[mid];
    if (!pg) return lo;
    if (pg.offsetTop + pg.cssHeight < viewTop) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function getVisiblePageRange() {
  if (!pdfState.doc) return null;
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;
  const viewBottom = scrollTop + viewportHeight;

  let firstVisible = binarySearchFirstVisible(scrollTop);
  let lastVisible = firstVisible;
  while (lastVisible < pdfState.doc.numPages) {
    const nextGeo = pdfState.geometry[lastVisible + 1];
    if (!nextGeo || nextGeo.offsetTop >= viewBottom) break;
    lastVisible++;
  }

  const buf = _isMemoryConstrained ? 1 : VIRTUAL_BUFFER;
  const rangeStart = Math.max(1, firstVisible - buf);
  const rangeEnd = Math.min(pdfState.doc.numPages, lastVisible + buf);

  return { firstVisible, lastVisible, rangeStart, rangeEnd };
}

function assignContainer(poolSlot, pageNum) {
  const geo = pdfState.geometry[pageNum];
  const el = poolSlot.element;

  el.style.top = geo.offsetTop + 'px';
  el.style.width = geo.cssWidth + 'px';
  el.style.height = geo.cssHeight + 'px';
  el.style.scrollSnapAlign = '';
  el.style.display = '';

  /*
   * When the user zooms in on mobile, the page becomes wider than
   * the screen. On desktop this creates a horizontal scrollbar, but
   * on mobile horizontal scroll doesn't exist (overflow-x is hidden
   * because horizontal swiping would conflict with the reading
   * experience). Without correction, the left edge of the page
   * would stay at x=0 and the right side would be clipped, pushing
   * the center of the text off-screen. I shift the page left by
   * half the overflow so the center of the PDF aligns with the
   * center of the screen
   */
  if (_isMobileDevice && geo.cssWidth > window.innerWidth) {
    const offset = (geo.cssWidth - window.innerWidth) / 2;
    el.style.marginLeft = -offset + 'px';
    el.style.marginRight = 'auto';
  } else {
    el.style.marginLeft = '0';
    el.style.marginRight = '0';
    el.style.margin = '0 auto';
  }
  el.dataset.pageNum = pageNum;

  poolSlot.mainCanvas.style.width = geo.cssWidth + 'px';
  poolSlot.mainCanvas.style.height = geo.cssHeight + 'px';
  poolSlot.overlayCanvas.style.width = geo.cssWidth + 'px';
  poolSlot.overlayCanvas.style.height = geo.cssHeight + 'px';
  poolSlot.textLayer.style.width = geo.cssWidth + 'px';
  poolSlot.textLayer.style.height = geo.cssHeight + 'px';
  poolSlot.verticalOcrLayer.style.width = geo.cssWidth + 'px';
  poolSlot.verticalOcrLayer.style.height = geo.cssHeight + 'px';
  poolSlot.pageLabel.textContent = pageNum;

  /*
   * Hide canvases until the new render completes. Without this,
   * a recycled container briefly shows content from its previous
   * page assignment (wrong page flash) or appears without dark mode
   * (the class was removed during eviction). The render will set
   * visibility back to '' after painting + dark mode + overlay.
   */
  poolSlot.mainCanvas.style.visibility = 'hidden';
  poolSlot.overlayCanvas.style.visibility = 'hidden';

  poolSlot.assignedPage = pageNum;
  pdfState.slots.set(pageNum, poolSlot);

  /*
   * Don't render immediately, schedule it. During scroll animation,
   * containers get repositioned at 60fps but PDF.js rendering only
   * starts when the scroll settles. Pre-rendered pages (already in
   * the pool) appear instantly; new ones show the placeholder until
   * the debounced render fires.
   */
  scheduleRender(pageNum);
}

// Debounced render scheduler: accumulates pages that need rendering
// and fires them all at once when scrolling stops.

function scheduleRender(pageNum) {
  const state = getOrCreateRenderState(pageNum);
  if (state.rendered || state.rendering) return;
  renderPipeline.pendingSet.add(pageNum);
  clearTimeout(renderPipeline.debounceTimer);
  renderPipeline.debounceTimer = setTimeout(flushPendingRenders, 150);
}

function flushPendingRenders() {
  for (const pageNum of renderPipeline.pendingSet) {
    if (pdfState.slots.has(pageNum)) {
      enqueueRender(pageNum);
    }
  }
  renderPipeline.pendingSet.clear();
}

function evictContainer(poolSlot) {
  const pageNum = poolSlot.assignedPage;
  if (pageNum == null) return;

  // Cancel pending work
  cancelQueuedRender(pageNum);
  cancelOcrJobsForPage(pageNum);
  const state = pdfState.renderState.get(pageNum);
  if (state && state._renderTask) {
    state._renderTask.cancel();
    state._renderTask = null;
  }

  // Release canvas memory
  poolSlot.mainCanvas.width = 0;
  poolSlot.mainCanvas.height = 0;
  poolSlot.overlayCanvas.width = 0;
  poolSlot.overlayCanvas.height = 0;
  poolSlot.overlayCanvas.classList.remove('overlay-visible');
  poolSlot.mainCanvas.classList.remove('dark-active');
  poolSlot.mainCanvas.style.visibility = '';
  poolSlot.overlayCanvas.style.visibility = '';

  // Clear text layers and annotations
  poolSlot.textLayer.innerHTML = '';
  poolSlot.verticalOcrLayer.innerHTML = '';
  poolSlot.element.querySelectorAll('.link-annot').forEach(el => el.remove());
  poolSlot.element.querySelectorAll('[data-ocr-loading]').forEach(el => el.remove());
  poolSlot.element.classList.remove('ocr-loading', 'ocr-done');

  // Release PDF.js page cache on constrained devices
  if (_isMemoryConstrained && pdfState.doc && !renderPipeline.resetting) {
    pdfState.doc.getPage(pageNum).then(p => p.cleanup()).catch(() => {});
  }

  // Update state
  if (state) {
    state.rendered = false;
    state.rendering = false;
    state.ocrInProgress = false;
    state.imageRegionsCss = [];
    state.imageRegionsRaw = [];
  }

  poolSlot.element.style.display = 'none';
  poolSlot.assignedPage = null;
  pdfState.slots.delete(pageNum);
}

function reconcileContainers() {
  if (!pdfState.doc || pdfState.doc.numPages === 0) return;

  const range = getVisiblePageRange();
  if (!range) return;
  const { rangeStart, rangeEnd } = range;
  const needed = new Set();
  for (let p = rangeStart; p <= rangeEnd; p++) needed.add(p);

  // Release containers no longer in range
  for (const poolSlot of renderPipeline.pool) {
    if (poolSlot.assignedPage != null && !needed.has(poolSlot.assignedPage)) {
      evictContainer(poolSlot);
    }
  }

  // Assign free containers to newly-needed pages (closest to center first)
  const centerPage = Math.round((rangeStart + rangeEnd) / 2);
  const sorted = [...needed].filter(p => !pdfState.slots.has(p))
    .sort((a, b) => Math.abs(a - centerPage) - Math.abs(b - centerPage));

  let assignmentChanged = sorted.length > 0;
  for (const pageNum of sorted) {
    const free = renderPipeline.pool.find(s => s.assignedPage === null);
    if (!free) break; // pool exhausted
    assignContainer(free, pageNum);
  }

  // Keep DOM order sorted by page number so cross-page text selection
  // follows the visual reading order. The browser builds selection by
  // DOM tree order, not by visual position. Without this, selecting
  // across two pages grabs the wrong text because recycled containers
  // can end up in any DOM position.
  // Skip when text is selected: moving DOM nodes destroys the active
  // selection. The reorder will run on the next reconcile after the
  // user clears the selection
  if (assignmentChanged) {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed) reorderContainersInDOM();
  }
}

function reorderContainersInDOM() {
  const spacer = renderPipeline.spacer;

  // Sort all pool containers: assigned first (by page number),
  // unassigned last. appendChild on an existing child moves it
  // to the end, so appending in sorted order produces the correct
  // DOM sequence. Assigned containers come first so that
  // querySelector('.page-container') finds visible pages, not
  // empty pool slots
  const sorted = [...renderPipeline.pool].sort((a, b) => {
    if (a.assignedPage === null && b.assignedPage === null) return 0;
    if (a.assignedPage === null) return 1;
    if (b.assignedPage === null) return -1;
    return a.assignedPage - b.assignedPage;
  });

  for (const slot of sorted) {
    spacer.appendChild(slot.element);
  }
}

async function buildPageSlots() {
  if (!pdfState.doc) return;

  // Clear previous state
  viewport.innerHTML = '';
  pdfState.slots.clear();
  pdfState.renderState.clear();
  renderPipeline.pool.length = 0;
  // Pages are numbered 1, 2, 3... but arrays start at 0. I put null
  // at index 0 so geometry[1] is page 1, geometry[5] is page 5
  pdfState.geometry = [null];

  const firstPage = await pdfState.doc.getPage(1);
  const scale = calculateScale(firstPage);
  pdfState.scale = scale;
  const zoomedScale = pdfState.renderScale;
  const dpr = getDpr();

  /*
   * Calculate the width and height (in CSS pixels) of every page so
   * the virtual scrolling spacer has the correct total height and
   * each container can be sized before rendering starts.
   *
   * Calling getPage() on all 500 pages would be slow, but most PDFs
   * have uniform page sizes (all A4, all Letter). I sample 5 pages
   * spread across the document: if they all match the first page,
   * I assume all pages are the same and skip the rest. Only mixed-
   * size PDFs (paper with landscape appendices) measure every page
   * individually. Slower, but without correct dimensions the virtual
   * scrolling would position pages in the wrong space
   */
  const firstVp = firstPage.getViewport({ scale: zoomedScale * dpr });
  const round = _isMobileDevice ? Math.round : Math.floor;
  const firstCssW = round(firstVp.width / dpr);
  const firstCssH = round(firstVp.height / dpr);

  let uniform = true;
  const numPages = pdfState.doc.numPages;

  if (numPages > 1) {
    const sampleIndices = new Set();
    sampleIndices.add(2);
    if (numPages >= 4) sampleIndices.add(Math.floor(numPages * 0.25));
    if (numPages >= 6) sampleIndices.add(Math.floor(numPages * 0.5));
    if (numPages >= 8) sampleIndices.add(Math.floor(numPages * 0.75));
    if (numPages >= 3) sampleIndices.add(numPages);

    for (const idx of sampleIndices) {
      const samplePage = await pdfState.doc.getPage(idx);
      const sampleVp = samplePage.getViewport({ scale: zoomedScale * dpr });
      const sW = round(sampleVp.width / dpr);
      const sH = round(sampleVp.height / dpr);
      if (sW !== firstCssW || sH !== firstCssH) {
        uniform = false;
        break;
      }
    }
  }

  // Build geometry table
  let offsetTop = VIEWPORT_PADDING_TOP;

  if (uniform) {
    // Fast path: all pages have the same dimensions
    for (let i = 1; i <= numPages; i++) {
      pdfState.geometry[i] = { cssWidth: firstCssW, cssHeight: firstCssH, offsetTop };
      offsetTop += firstCssH + PAGE_GAP;
    }
  } else {
    // Slow path: measure each page individually
    pdfState.geometry[1] = { cssWidth: firstCssW, cssHeight: firstCssH, offsetTop };
    offsetTop += firstCssH + PAGE_GAP;

    for (let i = 2; i <= numPages; i++) {
      const page = await pdfState.doc.getPage(i);
      const vp = page.getViewport({ scale: zoomedScale * dpr });
      const cssW = round(vp.width / dpr);
      const cssH = round(vp.height / dpr);
      pdfState.geometry[i] = { cssWidth: cssW, cssHeight: cssH, offsetTop };
      offsetTop += cssH + PAGE_GAP;
    }
  }

  // Total scroll height
  const totalHeight = pdfState.geometry[pdfState.doc.numPages].offsetTop +
    pdfState.geometry[pdfState.doc.numPages].cssHeight + 16; // bottom padding

  // Create spacer
  renderPipeline.spacer = document.createElement('div');
  renderPipeline.spacer.id = 'scroll-spacer';
  renderPipeline.spacer.style.position = 'relative';
  renderPipeline.spacer.style.width = '100%';
  renderPipeline.spacer.style.height = totalHeight + 'px';

  // Create container pool
  for (let i = 0; i < POOL_SIZE; i++) {
    const slot = createPoolContainer();
    renderPipeline.spacer.appendChild(slot.element);
    renderPipeline.pool.push(slot);
  }

  viewport.appendChild(renderPipeline.spacer);

  // Initial assignment
  reconcileContainers();
}


// --- DEVICE DETECTION AND MEMORY PROFILES ---

const _isMobileDevice = window.matchMedia('(pointer: coarse)').matches;
// navigator.platform is deprecated but there is no alternative for
// detecting iPads. iPadOS reports "MacIntel" in the userAgent (Apple
// disguises iPads as Macs to receive desktop sites). The only way to
// tell it's an iPad and not a real Mac is maxTouchPoints > 1.
// navigator.userAgentData (the modern replacement) is not supported
// by Safari, so we're stuck with the deprecated API
const _isIOS = _isMobileDevice && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
const _deviceMemoryGB = navigator.deviceMemory || 0;
const _isMemoryConstrained = _isIOS || (_isMobileDevice && (_deviceMemoryGB > 0 ? _deviceMemoryGB <= 4 : false));

const LARGE_DOC_THRESHOLD = 150;

// A DPR (Device Pixel Ratio) of 3 (iPhone 15 Pro) means each canvas 
// uses 9x the memory of a standard screen. I cap at 2 on devices 
// with 4GB or less RAM because the quality difference on a 6-inch 
// screen is barely noticeable but the memory savings are significant
function getDpr() {
  const raw = window.devicePixelRatio || 1;
  if (pdfState.largeDocConstrained) return Math.min(raw, 2);
  if (_isMemoryConstrained) return Math.min(raw, 2);
  return raw;
}

/*
 * Measures scroll speed to distinguish reading (slow) from
 * seeking (fast). During fast scroll, page rendering is deferred
 * until the user stops. Without this, scrolling quickly through
 * a 200-page document would try to render every page the user
 * passes, creating dozens of canvas backing stores that overwhelm
 * the browser's GPU memory on mobile
 */

const scrollState = {
  isFast: false,
  lastTop: 0,
  lastTime: 0,
  velocityTimer: null,
  raf: 0,
  presentationMode: false,
  wheelAccum: 0,
  wheelTimer: null,
};
const SCROLL_FAST_THRESHOLD = 3000; // px/sec, above this, defer rendering


// --- UNIFIED SCROLL COORDINATOR ---

/*
 * Everything that needs to happen on scroll is handled here in one
 * place: velocity detection, container recycling, and page position
 * saving. I merged three separate scroll listeners into one because
 * each listener was reading viewport.scrollTop independently, and
 * on budget Android devices each read forces the browser to
 * recalculate the layout before returning the value. Three reads
 * per scroll frame added up to noticeable stuttering.
 *
 * Order matters: velocity must update before reconcile, because
 * reconcileContainers checks scrollState.isFast to decide whether
 * to defer rendering during fast scroll
 */
viewport.addEventListener('scroll', () => {
  const now = performance.now();
  const scrollTop = viewport.scrollTop;

  // 1. Velocity detection (synchronous, reconcile reads isFast)
  const dt = now - scrollState.lastTime;
  if (dt > 0 && scrollState.lastTime > 0) {
    const dy = Math.abs(scrollTop - scrollState.lastTop);
    const velocity = (dy / dt) * 1000; // px/sec
    scrollState.isFast = velocity > SCROLL_FAST_THRESHOLD;
  }
  scrollState.lastTop = scrollTop;
  scrollState.lastTime = now;

  clearTimeout(scrollState.velocityTimer);
  scrollState.velocityTimer = setTimeout(() => {
    scrollState.isFast = false;
    flushRenderQueue();
  }, 150);

  // 2. Reconcile containers + update page indicator (rAF-throttled)
  if (!scrollState.raf) {
    scrollState.raf = requestAnimationFrame(() => {
      scrollState.raf = 0;
      reconcileContainers();
      updateCurrentPageFromScroll();
    });
  }

  // 3. Save page position (debounced 1s)
  if (pdfState.doc) {
    clearTimeout(uiState.savePageTimer);
    uiState.savePageTimer = setTimeout(savePagePosition, 1000);
  }
}, { passive: true });


// --- CANVAS POOL ---

/*
 * Reusable offscreen canvases for PDF.js rendering. Instead of
 * creating and destroying a canvas per page (which thrashes the
 * browser's GPU backing store allocator, especially on iOS where
 * the GC is lazy), I maintain a small pool. A canvas is borrowed
 * for rendering, then returned. Every exit path after borrowing
 * must return the canvas, including error paths and generation
 * mismatches, or the pool leaks permanently
 */

// Memory-constrained (iOS, budget Android): 1 concurrent render.
// Other mobile: 2. Desktop: 3. Playwright: 1 (avoid contention)
let MAX_CONCURRENT_RENDERS = navigator.webdriver ? 1 : _isMemoryConstrained ? 1 : _isMobileDevice ? 2 : 3;

function createOffscreenCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const canvasPool = [];

function borrowCanvas(w, h) {
  const c = canvasPool.pop() || document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function returnCanvas(c) {
  // Clear but keep the backing store for reuse
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
  if (canvasPool.length < MAX_CONCURRENT_RENDERS + 1) {
    canvasPool.push(c);
  } else {
    // Pool full, release this one
    c.width = 0;
  }
}


// --- ENGINE RESET ---

/*
 * PDF.js runs a web worker that accumulates internal state (parsed
 * XRef tables, decoded font programs, stream decoder caches) that
 * neither page.cleanup() nor pdfDoc.cleanup() fully releases. After
 * hundreds of getPage() calls, this accumulation can reach 200-300MB.
 *
 * The solution: periodically destroy the entire PDF.js instance and
 * recreate it from the original ArrayBuffer. The visible canvases
 * stay painted during the reset (the pixels live in the DOM, not in
 * PDF.js) so the user never notices. The cost is ~200-400ms to
 * reinitialize, scheduled during idle time.
 *
 * The threshold depends on the device: 15 renders on large documents
 * on memory-constrained devices (iOS and Android with 4GB or less),
 * 40 on desktop where the browser has gigabytes of headroom.
 * Desktop browsers with real swap/compression rarely hit this limit
 * but the reset protects against heap growth on every platform
 * (the curb cut effect)
 */
function getEngineResetThreshold() {
  if (pdfState.largeDocConstrained) return 15;
  return 40;
}

// Safari's requestIdleCallback support is incomplete, use rAF + setTimeout
// as a reliable fallback that still defers to an idle moment
const scheduleIdle = typeof requestIdleCallback === 'function'
  ? requestIdleCallback
  : (fn) => requestAnimationFrame(() => setTimeout(fn, 0));

async function resetPdfEngine() {
  if (!pdfState.doc || !pdfState.buffer || renderPipeline.resetting) return;

  renderPipeline.resetting = true;
  const gen = ++pdfState.generation;

  // Cancel in-flight work but preserve OCR cache, text data is tiny
  // and re-running Tesseract after every engine reset wastes CPU/battery
  renderPipeline.queue.length = 0;
  resetOcrState(true);

  try {
    // Destroy the old instance (main thread + worker thread).
    // This releases ALL accumulated state
    await pdfState.doc.destroy();

    // Recreate from the original buffer. PDF.js may transfer
    // ArrayBuffers internally, so we always pass a fresh copy
    pdfState.doc = await pdfjsLib.getDocument({
      data: pdfState.buffer.slice(0),
    }).promise;

    renderPipeline.sinceReset = 0;
    renderPipeline.resetPending = false;

    // Stale check: if a new document was loaded during the await,
    // pdfState.generation will have changed, abandon this reset
    if (pdfState.generation !== gen) return;

    // Resume normal operations. Pages the user is currently looking
    // at still have their pixels on screen (the reset only affects
    // PDF.js internals, not the painted canvases). New pages the
    // user scrolls to will use the fresh PDF.js instance
    flushRenderQueue();
  } catch (err) {
    // The old instance is already destroyed. If recreating fails,
    // pdfState.doc points to a dead object. Null it so the rest
    // of the code knows there's no active document, and tell the
    // user what happened
    console.warn('PDF engine reset failed:', err);
    pdfState.doc = null;
    showError('Could not refresh the document. Please reopen the file.');
  } finally {
    renderPipeline.resetting = false;
  }
}

function maybeScheduleEngineReset() {
  if (!_isMemoryConstrained || !renderPipeline.resetPending || !pdfState.doc) return;
  if (renderPipeline.active > 0 || renderPipeline.resetting) return;

  scheduleIdle(() => {
    // Re-check after yielding to the event loop, a render
    // may have started, or a new document may have been loaded.
    if (!pdfState.doc || renderPipeline.active > 0 || renderPipeline.resetting || !renderPipeline.resetPending) return;
    resetPdfEngine();
  });
}


// --- RENDER QUEUE ---

/*
 * Pages don't render directly. They enter a queue sorted by
 * distance from the viewport center (closest first). At most
 * MAX_CONCURRENT_RENDERS can run simultaneously. If a queued
 * page is evicted before rendering starts, it's silently dropped.
 * During fast scroll, the queue accepts entries but doesn't
 * process them until scroll settles (flushRenderQueue)
 */

function enqueueRender(pageNum) {
  if (!pdfState.doc || pageNum < 1 || pageNum > pdfState.doc.numPages) return;
  if (!pdfState.slots.has(pageNum)) return; // page has no active container
  const state = getOrCreateRenderState(pageNum);
  if (state.rendered || state.rendering) return;

  // Don't duplicate
  if (renderPipeline.queue.includes(pageNum)) return;

  renderPipeline.queue.push(pageNum);
  processRenderQueue();
}

function processRenderQueue() {
  if (scrollState.isFast || renderPipeline.resetting) return; // wait for scroll to settle / engine reset

  while (renderPipeline.active < MAX_CONCURRENT_RENDERS && renderPipeline.queue.length > 0) {
    // Closest page to what the user is looking at renders first
    const visPage = pdfState.currentPage || 1;
    renderPipeline.queue.sort((a, b) => Math.abs(a - visPage) - Math.abs(b - visPage));

    const pageNum = renderPipeline.queue.shift();
    const slot = pdfState.slots.get(pageNum);

    // Skip if already rendered, evicted, or stale.
    // State lives in renderState (per-page), not on the slot (per-container).
    const state = pdfState.renderState.get(pageNum);
    if (!slot || (state && (state.rendered || state.rendering))) continue;

    renderPipeline.active++;
    renderPageIfNeeded(pageNum).finally(() => {
      renderPipeline.active--;

      /*
       * Track memory pressure from accumulated renders.
       * On iOS, trigger a full engine reset every N pages to
       * prevent the PDF.js worker from accumulating fatal levels
       * of cached state (fonts, XRef, stream decoders).
       */
      renderPipeline.sinceReset++;
      if (renderPipeline.sinceReset >= getEngineResetThreshold()) {
        renderPipeline.resetPending = true;
      }

      // If queue is empty and a reset is pending, this is the
      // quiet moment, schedule it before picking up more work.
      if (renderPipeline.active === 0 && renderPipeline.resetPending) {
        maybeScheduleEngineReset();
      }

      processRenderQueue(); // pick up next in queue
    });
  }
}

function flushRenderQueue() {
  processRenderQueue();
}

// Cancel queued renders for a specific page (called by eviction observer)
function cancelQueuedRender(pageNum) {
  const idx = renderPipeline.queue.indexOf(pageNum);
  if (idx !== -1) renderPipeline.queue.splice(idx, 1);
}


// --- PAGE RENDERING ---

async function renderPageIfNeeded(pageNum) {
  if (!pdfState.doc || pageNum < 1 || pageNum > pdfState.doc.numPages) return;

  const slot = pdfState.slots.get(pageNum);
  if (!slot) return;
  const state = getOrCreateRenderState(pageNum);
  if (state.rendered || state.rendering) return;

  state.rendering = true;
  const myGen = pdfState.generation;
  state.renderGeneration = myGen;
  let renderCanvas = null; // tracked for exception-safe pool return

  try {
    const page = await pdfState.doc.getPage(pageNum);
    if (pdfState.generation !== myGen) return;
    if (slot.assignedPage !== pageNum) return;

    const dpr = getDpr();
    const scaledViewport = page.getViewport({ scale: pdfState.renderScale * dpr });
    const w = Math.floor(scaledViewport.width);
    const h = Math.floor(scaledViewport.height);

    /*
     * Borrow a canvas from the pool instead of creating a new one.
     * This avoids thrashing iOS WebKit's lazy GC of GPU backing stores.
     * IMPORTANT: every exit path after this MUST return the canvas
     * via returnCanvas(). Without this, the pool shrinks on errors
     * or generation changes, exactly when memory is most critical.
     */
    renderCanvas = borrowCanvas(w, h);

    // Render + get operator list (+ text content for native PDFs).
    // Keep a reference so eviction can cancel a render mid-flight
    const renderTask = page.render({
      canvasContext: renderCanvas.getContext('2d'),
      viewport: scaledViewport,
    });
    state._renderTask = renderTask;

    const parallelTasks = [
      renderTask.promise,
      page.getOperatorList(),
    ];
    // Skip getTextContent for scanned docs, it returns nothing useful
    if (!pdfState.isScanned) {
      parallelTasks.push(page.getTextContent());
    }

    const results = await Promise.all(parallelTasks);
    const opList = results[1];
    const textContent = pdfState.isScanned ? null : results[2];

    if (pdfState.generation !== myGen) { returnCanvas(renderCanvas); return; }
    if (slot.assignedPage !== pageNum) { returnCanvas(renderCanvas); return; }

    const isDark = detectAlreadyDark(renderCanvas);
    pdfState.alreadyDark.set(pageNum, isDark);

    let regions = pdfState.isScanned
      ? []
      : extractImageRegions(opList, scaledViewport.transform);

    // I filter out images that are OCR overlays (Adobe Paper Capture).
    // These are scanned pages with an invisible text layer on top.
    // Without this filter, the image gets protected from inversion
    // and the user sees the original white page in dark mode.
    // Three signals: coverage >40% (image dominates the page),
    // >200 characters on the page (not a book cover with just a
    // title), and the image is predominantly blank paper (not a
    // photograph or illustration)
    if (regions.length > 0 && textContent) {
      // I filter out OCR overlay images (Adobe Paper Capture) using
      // three signals: coverage (image dominates the page), character
      // density (enough text to be a document, not a cover), and blank
      // paper analysis (the image is scanned paper, not a photograph).
      // I originally had a fourth check (text coordinates inside image
      // bounds) but removed it because PDF space and canvas space
      // coordinate conversion is unreliable across rotated/cropped
      // pages. The three remaining checks are sufficient: blank paper
      // eliminates photos, char density eliminates covers
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

    // --- Compose page behind placeholder, then reveal ---
    /*
     * Hide the canvas during composition so the user sees the
     * dark placeholder (#1e1e1e) until everything is ready:
     * content painted + dark mode filter + overlay. This eliminates
     * the light -> dark flash on page transitions. The visibility
     * toggle is a compositing-only operation (GPU flag, no reflow).
     */
    slot.mainCanvas.style.visibility = 'hidden';
    slot.overlayCanvas.style.visibility = 'hidden';

    // Paint main canvas
    slot.mainCanvas.width = w;
    slot.mainCanvas.height = h;
    const mainCtx = slot.mainCanvas.getContext('2d');
    mainCtx.drawImage(renderCanvas, 0, 0);

    // Paint overlay canvas (only allocate backing store when page has image regions)
    if (regions.length > 0) {
      slot.overlayCanvas.width = w;
      slot.overlayCanvas.height = h;
      compositeImageRegions(slot.overlayCanvas.getContext('2d'), renderCanvas, regions, w, h);
    }

    // scheduleTextLayer takes ownership of renderCanvas. After this
    // call we must NOT touch it (it's either returned to the pool
    // or captured by the OCR job closure)
    scheduleTextLayer(slot, state, pageNum, page, renderCanvas, textContent, scaledViewport, regions, w, h, dpr, myGen);
    renderCanvas = null;

    try {
      const annotations = await page.getAnnotations();
      if (pdfState.generation !== myGen || slot.assignedPage !== pageNum) return;
      buildLinkLayer(slot.element, annotations, scaledViewport, dpr, pageNum);
    } catch (_) {
      if (pdfState.generation !== myGen || slot.assignedPage !== pageNum) return;
    }

    state.rendered = true;
    state._renderTask = null;
    applyDarkModeToPage(pageNum);

    slot.mainCanvas.style.visibility = '';
    slot.overlayCanvas.style.visibility = '';

    if (_isMemoryConstrained) page.cleanup();
  } catch (err) {
    // Return canvas to pool on error, otherwise the pool permanently
    // shrinks, exactly when memory-constrained devices need it most
    if (renderCanvas) { returnCanvas(renderCanvas); renderCanvas = null; }
    if (pdfState.generation !== myGen) return;
    if (err?.name !== 'RenderingCancelledException' && err?.message !== 'Rendering cancelled') {
      console.error(`Render page ${pageNum} failed:`, err);
    }
  } finally {
    state.rendering = false;
    state._renderTask = null;
  }
}


// --- ALREADY-DARK DETECTION ---

/*
 * Wrapper around the pure function in core.js. Reads pixel data
 * from the canvas and delegates to detectAlreadyDark(). Pages
 * with dark backgrounds (slides, dark-themed PDFs) skip inversion
 * automatically because inverting an already-dark page makes it light
 */

function detectAlreadyDark(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, w, h);
  return _detectAlreadyDark(imageData.data, w, h);
}


// --- TEXT LAYER ---

/*
 * Builds a continuous-flow text overlay for smooth selection.
 * Each word from PDF.js textContent becomes a transparent span
 * positioned over the rendered text in the canvas.
 *
 * I evaluated multiple approaches before settling on flow layout.
 * Absolutely-positioned spans (like Mozilla's PDF.js viewer) leave
 * gaps in the DOM: when the user drags a selection through a gap,
 * the browser loses track and jumps to random fragments. Flow
 * layout with line divs gives the browser a natural top-to-bottom
 * selection path.
 *
 * Each line is a block-level div positioned at its Y coordinate.
 * Within a line, spans flow left-to-right with precise marginLeft
 * gaps. TextNode spaces between spans preserve word boundaries in
 * the clipboard (see shouldInsertSpace in core.js for the three
 * scenarios where spaces are needed).
 *
 * Each span uses display:inline-block + width + scaleX to match
 * the exact width of the original text, regardless of font
 * differences between the PDF's font and our sans-serif
 */

function buildTextLayer(container, textContent, viewport, dpr) {
  container.innerHTML = '';

  // Shared canvas for measuring text widths without DOM reflows
  const measureCtx = document.createElement('canvas').getContext('2d');

  // --- Step 1: Transform all items to screen coordinates ---
  const items = [];
  for (const item of textContent.items) {
    if (!item.str && !item.hasEOL) continue;

    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
    const fontSize = fontHeight / dpr;

    if (fontSize < 1) continue;

    const left = tx[4] / dpr;
    const top = tx[5] / dpr - fontSize * BASELINE_RATIO;
    const pdfWidth = item.width > 0 ? (item.width * viewport.scale / dpr) : 0;

    items.push({
      str: normalizeLigatures(item.str || ''),
      left,
      top,
      fontSize,
      pdfWidth,
      height: fontSize,
      hasEOL: !!item.hasEOL,
      tx1: tx[1],
      tx2: tx[2],
      dir: item.dir || 'ltr',
    });
  }

  if (items.length === 0) return;

  // --- Step 2: Detect multi-column layout ---
  // Quick O(n) scan: if Y jumps backward significantly between
  // consecutive items, this is a multi-column document. The check
  // runs on raw items before any grouping so it does not affect
  // the single-column path in any way.
  const isMultiColumn = detectMultiColumnItems(items);

  if (!isMultiColumn) {
    // --- SINGLE COLUMN: original path, untouched ---
    const lines = groupItemsIntoLines(items);
    const fragment = document.createDocumentFragment();
    const inheritedFontSize = parseFloat(getComputedStyle(container).fontSize) || 16;
    measureCtx.font = `${inheritedFontSize}px sans-serif`;
    const spaceAdvance = measureCtx.measureText(' ').width;
    buildLinesIntoContainer(fragment, lines, measureCtx, spaceAdvance, dpr);
    container.appendChild(fragment);
  } else {
    // --- MULTI COLUMN: flex-row layout ---
    // Group preserving content stream order so columns don't merge
    const lines = groupItemsPreservingOrder(items);
    const colGroups = detectColumnGroupsFromLines(lines);
    const columnStartY = colGroups[1][0][0].top;

    // Separate header lines (above column start) from column 1
    const headerLines = [];
    const col1Lines = [];
    for (const line of colGroups[0]) {
      if (line[0].top < columnStartY) {
        headerLines.push(line);
      } else {
        col1Lines.push(line);
      }
    }

    const fragment = document.createDocumentFragment();
    const inheritedFontSize = parseFloat(getComputedStyle(container).fontSize) || 16;
    measureCtx.font = `${inheritedFontSize}px sans-serif`;
    const spaceAdvance = measureCtx.measureText(' ').width;

    // Header in normal flow (identical to single-column rendering)
    if (headerLines.length > 0) {
      buildLinesIntoContainer(fragment, headerLines, measureCtx, spaceAdvance, dpr);
    }

    // Calculate gap between header bottom and column start
    let headerBottom = 0;
    if (headerLines.length > 0) {
      const last = headerLines[headerLines.length - 1];
      headerBottom = last[0].top + Math.max(...last.map(it => it.height));
    }

    // Flex-row wrapper: columns side by side, entirely in flow
    const wrapper = document.createElement('div');
    wrapper.className = 'columns-wrapper';
    wrapper.style.marginTop = Math.max(0, columnStartY - headerBottom) + 'px';

    // Build each column
    const allCols = [col1Lines, ...colGroups.slice(1)];
    let prevColRight = 0;

    for (let c = 0; c < allCols.length; c++) {
      const colLines = allCols[c];
      if (colLines.length === 0) continue;

      // Column geometry from items
      let colLeft = Infinity, colRight = 0;
      for (const line of colLines) {
        for (const item of line) {
          if (item.left < colLeft) colLeft = item.left;
          const r = item.left + (item.pdfWidth || item.width || 0);
          if (r > colRight) colRight = r;
        }
      }

      const colDiv = document.createElement('div');
      colDiv.className = 'text-column';
      colDiv.style.width = (colRight - colLeft) + 'px';
      colDiv.style.marginLeft = (c === 0 ? colLeft : colLeft - prevColRight) + 'px';
      prevColRight = colRight;

      // Adjust coordinates: X relative to column left, Y relative to column start
      const adjusted = colLines.map(line =>
        line.map(item => ({ ...item, left: item.left - colLeft, top: item.top - columnStartY }))
      );
      buildLinesIntoContainer(colDiv, adjusted, measureCtx, spaceAdvance, dpr);
      wrapper.appendChild(colDiv);
    }

    fragment.appendChild(wrapper);
    container.appendChild(fragment);
  }
}


// --- MULTI-COLUMN HELPERS (only used when columns are detected) ---

/*
 * Academic papers typically use two-column layouts: a full-width
 * header (title, authors, abstract) followed by two narrow columns
 * of body text. PDF.js getTextContent() returns items in content
 * stream order, which for LaTeX-generated papers is: header items
 * top-to-bottom, then column 1 top-to-bottom, then column 2
 * top-to-bottom.
 *
 * The single-column path (groupItemsIntoLines with global Y-sort)
 * merges both columns because items at the same Y end up on the
 * same line. The multi-column path preserves content stream order
 * so columns stay separate, then renders each column inside a
 * flex-row wrapper. Everything stays in flow layout — no
 * position:absolute — so the browser produces smooth unbroken
 * selection highlighting across header and columns.
 *
 * The multi-column path activates only when detectMultiColumnItems
 * finds a backward Y jump. Single-column documents take the
 * original path with zero changes.
 */

/*
 * Scans raw items for a significant backward Y jump. In a
 * single-column document, Y always increases (top to bottom).
 * When Y drops back by more than 3x the item height, it means
 * the content stream moved from the bottom of one column to the
 * top of the next. The 3x threshold avoids false positives from
 * superscripts or slight baseline variations.
 */
function detectMultiColumnItems(items) {
  let maxTop = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].top > maxTop) maxTop = items[i].top;
    // Y jumped back by more than 3x the item height: column break
    if (i > 0 && items[i].top < maxTop - items[i].height * 3) {
      return true;
    }
  }
  return false;
}

/*
 * Groups items into lines like groupItemsIntoLines in core.js, but
 * without the global Y-sort. Items stay in content stream order so
 * column 1 and column 2 items at the same Y are never merged. The
 * same 50% height threshold and per-line left-to-right sort are
 * applied. This function lives in app.js (not core.js) because it
 * is specific to the multi-column rendering path.
 */
function groupItemsPreservingOrder(items) {
  if (items.length === 0) return [];
  const lines = [];
  let currentLine = [items[0]];
  let lineTop = items[0].top;
  let lineHeight = items[0].height;
  for (let i = 1; i < items.length; i++) {
    const item = items[i];
    const threshold = lineHeight * 0.5;
    if (Math.abs(item.top - lineTop) < threshold) {
      currentLine.push(item);
      if (item.height > lineHeight) lineHeight = item.height;
    } else {
      currentLine.sort((a, b) => a.left - b.left);
      lines.push(currentLine);
      currentLine = [item];
      lineTop = item.top;
      lineHeight = item.height;
    }
  }
  currentLine.sort((a, b) => a.left - b.left);
  lines.push(currentLine);
  return lines;
}

/*
 * Walks grouped lines in order and splits them into column groups
 * wherever the Y coordinate jumps backward significantly. The
 * first group typically contains the header lines followed by
 * column 1. Subsequent groups are columns 2, 3, etc. The
 * threshold (one line height backward) prevents false positives
 * from superscripts or baseline variations within a paragraph.
 */
function detectColumnGroupsFromLines(lines) {
  if (lines.length <= 1) return [lines];
  const groups = [];
  let currentGroup = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const prevTop = lines[i - 1][0].top;
    const currTop = lines[i][0].top;
    const prevHeight = Math.max(...lines[i - 1].map(it => it.height));
    if (currTop < prevTop - prevHeight) {
      groups.push(currentGroup);
      currentGroup = [lines[i]];
    } else {
      currentGroup.push(lines[i]);
    }
  }
  groups.push(currentGroup);
  return groups;
}

/*
 * Builds text-line divs into a container from an array of grouped
 * lines. Extracted from the original inline loop in buildTextLayer
 * so it can serve both paths: single-column (container = fragment,
 * all lines sorted by Y) and multi-column (container = column div,
 * lines with Y adjusted relative to column start). The flow layout
 * with paddingTop advancement is identical in both cases, but each
 * column starts with prevBottom = 0 independently so columns never
 * contaminate each other's vertical positioning.
 */
function buildLinesIntoContainer(container, lines, measureCtx, spaceAdvance, dpr) {
  // I sort and merge each line, compute top, height, and direction.
  // A line is RTL if the majority of its items are RTL (from the
  // dir property that PDF.js provides on each text content item)
  const processed = lines.map(rawLine => {
    rawLine.sort((a, b) => a.left - b.left);
    const line = mergePunctuation(rawLine);
    const lt = line[0].top;
    const lh = Math.max(...line.map(it => it.height));
    const rtlCount = line.filter(it => it.dir === 'rtl').length;
    const isRtl = rtlCount > line.length / 2;
    return { line, lt, lh, isRtl };
  });

  let prevBottom = 0;

  for (let idx = 0; idx < processed.length; idx++) {
    const { line, lt, lh, isRtl } = processed[idx];

    const lineDiv = document.createElement('div');
    lineDiv.className = 'text-line';

    const vGap = Math.max(0, lt - prevBottom);

    // Extend each line's box to reach the next line, eliminating
    // dead space between rows. Without this, moving the cursor
    // even 1px below a line drops into a void and the browser
    // jumps the selection to a distant paragraph. With it, the
    // user must deliberately reach the next line to select it.
    // The result feels intentional: the selection follows the
    // reader's pace instead of racing ahead of it.
    let extendedLh = lh;
    if (idx + 1 < processed.length) {
      const nextTop = processed[idx + 1].lt;
      const gapBelow = nextTop - (lt + lh);
      if (gapBelow > 0) extendedLh = lh + gapBelow;
    }

    lineDiv.style.paddingTop = vGap + 'px';
    lineDiv.style.height = (extendedLh + vGap) + 'px';

    // I set dir="rtl" on lines where the majority of items are RTL
    // (Arabic, Hebrew). The visual layout does not change because
    // spans are positioned with explicit left coordinates, but the
    // browser's clipboard logic respects the reading direction
    if (isRtl) lineDiv.dir = 'rtl';

    prevBottom = lt + extendedLh;

    let cursor = 0;
    let prevStr = '';

    for (let i = 0; i < line.length; i++) {
      const item = line[i];
      if (!item.str) continue;

      const gap = item.left - cursor;
      let adjustedGap = gap;

      if (cursor > 0) {
        const result = shouldInsertSpace(
          prevStr, item.str, gap, item.fontSize, spaceAdvance
        );
        if (result.insertSpace) {
          lineDiv.appendChild(document.createTextNode(' '));
        }
        adjustedGap = result.adjustedGap;
      }

      const span = document.createElement('span');
      span.textContent = item.str;
      span.style.fontSize = item.fontSize + 'px';

      if (adjustedGap > 0.5) {
        span.style.marginLeft = adjustedGap + 'px';
      }

      if (item.pdfWidth > 0) {
        measureCtx.font = `${item.fontSize}px sans-serif`;
        const naturalWidth = measureCtx.measureText(item.str).width;

        if (naturalWidth > 0) {
          const scaleX = item.pdfWidth / naturalWidth;
          span.style.display = 'inline-block';
          span.style.width = item.pdfWidth + 'px';
          span.style.transform = `scaleX(${scaleX})`;
          span.style.transformOrigin = isRtl ? 'right top' : 'left top';
        }
      }

      if (item.tx1 !== 0 || item.tx2 !== 0) {
        const angle = Math.atan2(item.tx1, Math.sqrt(item.tx2 * item.tx2 + (item.fontSize * dpr) * (item.fontSize * dpr)));
        const existingTransform = span.style.transform;
        span.style.transform = existingTransform
          ? `${existingTransform} rotate(${angle}rad)`
          : `rotate(${angle}rad)`;
        span.style.transformOrigin = '0 100%';
      }

      lineDiv.appendChild(span);
      cursor = item.left + (item.pdfWidth || 0);
      prevStr = item.str;
    }

    if (cursor > 0) {
      lineDiv.style.width = cursor + 'px';
    }

    container.appendChild(lineDiv);
  }
}


// --- LINK ANNOTATION LAYER ---

/*
 * Overlays clickable <a> elements for each link annotation in the
 * PDF. External links open in a new tab, internal links scroll to
 * the target page. The elements sit above the text layer with
 * user-select:none so they don't interfere with text selection.
 * URL protocols are whitelisted (http, https, mailto only) to
 * block javascript: URIs from malicious PDFs
 */

function buildLinkLayer(container, annotations, viewport, dpr, pageNum) {
  container.querySelectorAll('.link-annot').forEach(el => el.remove());

  for (const annot of annotations) {
    if (annot.subtype !== 'Link') continue;
    if (!annot.rect || annot.rect.length < 4) continue;

    const url = annot.url || null;
    const dest = annot.dest || null;
    if (!url && !dest) continue;

    // PDF coordinates have origin at bottom-left, CSS at top-left.
    // viewport.transform is a 6-element affine matrix [a,b,c,d,e,f].
    const [x1, y1, x2, y2] = annot.rect;
    const vt = viewport.transform;
    const p1 = transformPoint(vt, x1, y1);
    const p2 = transformPoint(vt, x2, y2);

    const left = Math.min(p1[0], p2[0]) / dpr;
    const top = Math.min(p1[1], p2[1]) / dpr;
    const width = Math.abs(p2[0] - p1[0]) / dpr;
    const height = Math.abs(p2[1] - p1[1]) / dpr;

    if (width < 1 || height < 1) continue;

    const a = document.createElement('a');
    a.className = 'link-annot';

    if (url) {
      // Sanitize URL protocol, malicious PDFs can embed javascript: links
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) continue;
      } catch (_) { continue; }
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      // Accessible label: show host for http/https, full address for mailto
      try {
        const parsed = new URL(url);
        a.setAttribute('aria-label', parsed.protocol === 'mailto:'
          ? `Email ${parsed.pathname}`
          : `${parsed.hostname} (opens in new tab)`);
      } catch (_) {
        a.setAttribute('aria-label', 'External link (opens in new tab)');
      }
    } else if (dest) {
      a.href = '#';
      a.setAttribute('aria-label', `Internal link to page ${typeof dest === 'string' ? dest : ''}`);
      a.addEventListener('click', (e) => {
        e.preventDefault();
        resolveInternalLink(dest);
      });
    }

    a.style.position = 'absolute';
    a.style.left = left + 'px';
    a.style.top = top + 'px';
    a.style.width = width + 'px';
    a.style.height = height + 'px';

    container.appendChild(a);
  }
}

async function resolveInternalLink(dest) {
  if (!pdfState.doc) return;

  try {
    let pageIndex;

    if (typeof dest === 'string') {
      // Named destination, resolve via PDF.js
      const resolved = await pdfState.doc.getDestination(dest);
      if (!resolved) return;
      pageIndex = await pdfState.doc.getPageIndex(resolved[0]);
    } else if (Array.isArray(dest) && dest.length > 0) {
      // Explicit destination, first element is page ref
      pageIndex = await pdfState.doc.getPageIndex(dest[0]);
    } else {
      return;
    }

    const targetPage = pageIndex + 1; // PDF.js uses 0-based index
    scrollToPage(targetPage);
  } catch (err) {
    console.warn('Could not resolve internal link:', err);
  }
}

function extractImageRegions(opList, viewportTransform) {
  return _extractImageRegions(opList, viewportTransform, OPS_MAP);
}


// --- DARK MODE LOGIC ---

/*
 * Each page resolves its dark mode state through three levels:
 * 1. User override (if set): force dark or force light
 * 2. Already-dark detection: if the page background is dark, skip
 *    inversion (inverting a dark page makes it light)
 * 3. Default: apply dark mode (invert + protect images)
 *
 * The override persists in localStorage so if the user forces a
 * page to light, it stays light across sessions and is also
 * respected in the exported PDF
 */

function shouldApplyDark(pageNum) {
  return _shouldApplyDark(pageNum, pdfState.darkOverride, pdfState.alreadyDark);
}

function applyDarkModeToPage(pageNum) {
  const slot = pdfState.slots.get(pageNum);
  if (!slot) return;
  const state = pdfState.renderState.get(pageNum);
  if (!state || !state.rendered) return;

  const dark = shouldApplyDark(pageNum);
  slot.mainCanvas.classList.toggle('dark-active', dark);
  slot.overlayCanvas.classList.toggle('overlay-visible', dark);
}

function applyDarkModeToAllPages() {
  for (const [pageNum] of pdfState.slots) {
    applyDarkModeToPage(pageNum);
  }
}


// --- CURRENT PAGE TRACKING (FROM SCROLL POSITION) ---


function updateCurrentPageFromScroll() {
  if (!pdfState.doc || pdfState.geometry.length <= 1) return;

  // Find the page whose center is closest to the viewport center.
  // Uses the precomputed geometry table, pure math, no DOM queries.
  const viewCenter = viewport.scrollTop + viewport.clientHeight / 2;
  let closestPage = 1;
  let closestDist = Infinity;

  // Binary search for approximate location, then linear scan nearby
  const approx = binarySearchFirstVisible(viewport.scrollTop);
  const lo = Math.max(1, approx - 3);
  const hi = Math.min(pdfState.doc.numPages, approx + 5);
  for (let i = lo; i <= hi; i++) {
    const geo = pdfState.geometry[i];
    const pageCenter = geo.offsetTop + geo.cssHeight / 2;
    const dist = Math.abs(pageCenter - viewCenter);
    if (dist < closestDist) {
      closestDist = dist;
      closestPage = i;
    }
  }

  pdfState.currentPage = closestPage;
  updateNavigationUI();
  updateToggleButton();
}


// --- TOGGLE BUTTON STATE ---

function updateToggleButton() {
  const dark = shouldApplyDark(pdfState.currentPage);
  iconDark.hidden = !dark;
  iconLight.hidden = dark;
  btnToggle.classList.toggle('toggle-active', dark);
  btnToggle.setAttribute('aria-pressed', dark ? 'true' : 'false');
}

function toggleDarkMode() {
  const pageNum = pdfState.currentPage;
  const currentlyDark = shouldApplyDark(pageNum);

  if (currentlyDark) {
    pdfState.darkOverride.set(pageNum, 'light');
  } else {
    pdfState.darkOverride.set(pageNum, 'dark');
  }

  applyDarkModeToPage(pageNum);
  updateToggleButton();
  announce(shouldApplyDark(pageNum) ? 'Dark mode enabled' : 'Dark mode disabled');
  // Persist immediately so the override survives app close
  savePagePosition();
}


// --- NAVIGATION ---

function updateNavigationUI() {
  if (!pdfState.doc) return;
  pageInfo.textContent = `${pdfState.currentPage} / ${pdfState.doc.numPages}`;
  btnPrev.disabled = pdfState.currentPage <= 1;
  btnNext.disabled = pdfState.currentPage >= pdfState.doc.numPages;
}

/*
 * Click on "3 / 18" turns it into an editable input. The user types
 * a page number and presses Enter (desktop) or "Go" (mobile keyboard).
 *
 * Mobile quirk: when the user taps "Go", the phone closes the keyboard
 * first (firing blur) and sends the Enter key second. If I removed the
 * input on blur, the Enter would arrive to nothing and the navigation
 * wouldn't happen. So I commit on blur if the value changed, not just
 * on Enter
 */
pageInfo.addEventListener('click', () => {
  if (!pdfState.doc) return;

  const current = pdfState.currentPage;
  const total = pdfState.doc.numPages;

  // Replace the page counter with an editable input
  const input = document.createElement('input');
  input.id = 'page-input';
  input.type = 'text';
  input.inputMode = 'numeric';
  input.pattern = '[0-9]*';
  input.value = current;
  input.setAttribute('aria-label', `Go to page (1-${total})`);

  // Pause focus mode while editing, toolbar stays visible
  uiState.focusPaused = true;
  clearTimeout(uiState.focusTimer);
  uiState.focusTimer = null;

  let committed = false;

  // Replace the label with the input
  pageInfo.style.display = 'none';
  pageInfo.parentNode.insertBefore(input, pageInfo);
  input.select();

  function commit() {
    if (committed) return;
    committed = true;
    const val = parseInt(input.value, 10);
    if (!isNaN(val) && val >= 1 && val <= total) {
      scrollToPage(val);
    }
    restore();
  }

  function restore() {
    if (!input.parentNode) return; // already removed
    input.remove();
    pageInfo.style.display = '';
    // Resume focus mode
    uiState.focusPaused = false;
    resetFocusTimer();
  }

  input.addEventListener('keydown', (e) => {
    // keyCode is deprecated but some Android keyboards don't send
    // key='Enter', only keyCode 13. Without this fallback those
    // devices can't navigate to a page number
    if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); restore(); }
  });

  // Some Android keyboards submit without firing keydown at all,
  // they only fire a 'change' event on the input
  input.addEventListener('change', () => { commit(); });

  // On mobile, blur fires when the keyboard dismisses.
  // Commit if the value changed, otherwise just restore.
  input.addEventListener('blur', () => {
    if (input.value !== String(current)) {
      commit();
    } else {
      restore();
    }
  });
});

function scrollToPage(pageNum, instant = false) {
  if (!pdfState.doc || pdfState.geometry.length <= 1) return;
  const clamped = Math.max(1, Math.min(pageNum, pdfState.doc.numPages));
  const geo = pdfState.geometry[clamped];
  if (!geo) return;

  // Scroll so the page is centered in the viewport
  const target = geo.offsetTop - (viewport.clientHeight - geo.cssHeight) / 2;
  viewport.scrollTo({
    top: Math.max(0, target),
    behavior: (instant || _isMemoryConstrained) ? 'instant' : 'smooth',
  });
}


// --- EVENT LISTENERS ---

// --- Option/Alt: vertical text OCR + selection in images ---
/*
 *
 * Pressing Option starts vertical OCR on the current page's images
 * immediately, before the user even drags. By the time they position
 * the cursor and start selecting, the text is already there.
 *
 * On mousedown with Alt held, we activate the vertical OCR layer and
 * mute the horizontal one. On mouseup, layers are restored.
 */

// Pre-load vertical OCR as soon as Option is pressed
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Alt') return;

  const slot = pdfState.slots.get(pdfState.currentPage);
  const state = pdfState.renderState.get(pdfState.currentPage);
  if (!slot || !state || state.imageRegionsRaw.length === 0) return;
  if (slot.mainCanvas.width === 0) return;

  const vertLayer = slot.verticalOcrLayer;
  if (vertLayer.children.length > 0) return;

  const dpr = getDpr();
  const myGen = pdfState.generation;
  for (const region of state.imageRegionsRaw) {
    ocrImageVertical(slot.mainCanvas, vertLayer, region, dpr, myGen);
  }
});

document.addEventListener('mousedown', (e) => {
  if (!e.altKey) return;
  const pageContainer = e.target.closest('.page-container');
  if (!pageContainer) return;

  const vertLayer = pageContainer.querySelector('.vertical-ocr-layer');
  if (!vertLayer) return;

  // Activate vertical layer
  vertLayer.style.pointerEvents = 'auto';
  for (const span of vertLayer.querySelectorAll('span')) {
    span.style.pointerEvents = 'auto';
  }
  // Mute horizontal image regions
  for (const hr of pageContainer.querySelectorAll('.text-layer .ocr-image-region')) {
    hr.style.pointerEvents = 'none';
  }
});

document.addEventListener('mouseup', () => {
  for (const vl of document.querySelectorAll('.vertical-ocr-layer')) {
    vl.style.pointerEvents = '';
    for (const span of vl.querySelectorAll('span')) {
      span.style.pointerEvents = '';
    }
  }
  for (const hr of document.querySelectorAll('.text-layer .ocr-image-region')) {
    hr.style.pointerEvents = '';
  }
});

// --- Drop Zone ---

/*
 * On desktop the entire drop zone is clickable to open the file
 * picker. On mobile I skip this because the <label for="file-input">
 * button already opens the native picker without JavaScript, and
 * iOS Safari requires native label-to-input association (programmatic
 * click() on hidden inputs is blocked).
 *
 * When the File System Access API is available (Chrome/Edge), I use
 * showOpenFilePicker instead of the hidden input. This returns a file
 * handle that I can save in IndexedDB (~30 bytes) for session resume
 * without copying the entire file into storage
 */
dropZone.addEventListener('click', async (e) => {
  if (window.matchMedia('(pointer: coarse)').matches) return;
  if (e.target.closest('a') || e.target.closest('label')) return;

  if (hasFileSystemAccess) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
      });
      const file = await handle.getFile();
      file._handle = handle; // attach handle for persistFile()
      handleFile(file);
    } catch (_) { /* user cancelled picker */ }
    return;
  }

  fileInput.click();
});

// Keyboard: Enter/Space opens file picker (accessibility)
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    if (e.target.closest('#resume-section') || e.target.closest('a') || e.target.closest('label')) return;
    e.preventDefault();
    dropZone.click();
  }
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');

  /*
   * Try to get a file handle from the drop (File System Access API).
   * This enables session resume from the original file path on desktop,
   * same as showOpenFilePicker(). Without this, dropped files fall back
   * to ArrayBuffer persistence (120MB limit).
   */
  const item = e.dataTransfer.items && e.dataTransfer.items[0];
  if (item && item.getAsFileSystemHandle) {
    try {
      const handle = await item.getAsFileSystemHandle();
      if (handle && handle.kind === 'file') {
        const file = await handle.getFile();
        file._handle = handle;
        handleFile(file);
        return;
      }
    } catch (_) { /* fallback to regular file */ }
  }

  handleFile(e.dataTransfer.files[0]);
});

fileInput.addEventListener('change', () => {
  handleFile(fileInput.files[0]);
  fileInput.value = '';
});

// --- Toolbar ---
// "veil" logo: return to drop zone without reloading the page.
// Session is preserved, the resume button appears so the user
// can continue reading or open a new file.
btnHome.addEventListener('click', async (e) => {
  e.preventDefault();
  if (!pdfState.doc) return;

  // Save current page position before leaving
  savePagePosition();

  // Stop all rendering and OCR
  pdfState.generation++;
  renderPipeline.queue.length = 0;
  resetOcrState();

  // Destroy PDF.js instance to free memory
  if (pdfState.doc) { await pdfState.doc.destroy(); pdfState.doc = null; }
  pdfState.buffer = null;
  cleanup();

  // Hide reader, show drop zone with resume button
  readerEl.hidden = true;
  dropZone.hidden = false;
  dropZone.classList.remove('veil-opening');
  document.title = 'veil';

  // Show resume button if there's a saved session.
  // Force button mode (no auto-load), the user explicitly chose
  // to leave the reader, so they should choose to resume.
  const savedFilename = localStorage.getItem('veil-filename');
  if (savedFilename) {
    restoreSession(true);
  }
});

btnPrev.addEventListener('click', () => scrollToPage(pdfState.currentPage - 1, true));
btnNext.addEventListener('click', () => scrollToPage(pdfState.currentPage + 1, true));
btnToggle.addEventListener('click', toggleDarkMode);
btnExport.addEventListener('click', exportDarkPdf);
exportCancelBtn.addEventListener('click', cancelExport);

// --- Keyboard ---
document.addEventListener('keydown', (e) => {
  if (!pdfState.doc) return;

  // Cmd/Ctrl + Plus/Minus/Zero: zoom the PDF, not the browser.
  // This is the standard behavior for document viewers.
  // Users who need larger UI use OS accessibility settings, not browser zoom
  if (e.metaKey || e.ctrlKey) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomBy(0.25); return; }
    if (e.key === '-')                  { e.preventDefault(); zoomBy(-0.25); return; }
    if (e.key === '0')                  { e.preventDefault(); zoomReset(); return; }
  }

  if (e.key === 'ArrowLeft') scrollToPage(pdfState.currentPage - 1, true);
  else if (e.key === 'ArrowRight') scrollToPage(pdfState.currentPage + 1, true);
  else if (e.key === 'd') toggleDarkMode();
});

// --- Presentation mode ---

/*
 * When pages fill most of the viewport (landscape slides), continuous
 * trackpad scroll made the fans spin on Mac Intel because every scroll 
 * frame triggered a full page render via reconcileContainers. Arrow key
 * navigation with instant scroll worked perfectly, it was only the
 * trackpad's continuous small increments that caused the problem.
 *
 * For presentation-style PDFs (wider than tall), I intercept the
 * trackpad and accumulate the scroll distance. Only when it reaches
 * 60px do I jump to the next page. This absorbs the trackpad's
 * inertia (Apple trackpads fire hundreds of small events per gesture)
 * without accidentally skipping two pages. Normal documents (papers,
 * books) keep continuous scroll
 */

const WHEEL_PAGE_THRESHOLD = 60;


// --- ZOOM ---

const btnZoomIn = document.getElementById('btn-zoom-in');
const btnZoomOut = document.getElementById('btn-zoom-out');
const zoomLevelEl = document.getElementById('zoom-level');

function updateZoomUI() {
  // Only disable zoom on phone landscape (short screens), not foldable/tablet landscape
  const isLandscapeTouch = isPhoneLandscape();
  const effectiveZoom = isLandscapeTouch ? 1 : pdfState.zoomMultiplier;
  const pct = Math.round(effectiveZoom * 100);
  if (zoomLevelEl) zoomLevelEl.textContent = `${pct}%`;
  if (btnZoomIn) btnZoomIn.disabled = isLandscapeTouch || pdfState.zoomMultiplier >= 3;
  if (btnZoomOut) btnZoomOut.disabled = isLandscapeTouch || pdfState.zoomMultiplier <= 0.5;
  // Toggle horizontal scroll when zoomed beyond viewport.
  // Desktop: scrollbar for horizontal panning.
  // Mobile: keep hidden + negative margin to center the oversized page.
  if (_isMobileDevice) {
    viewport.style.overflowX = 'hidden';
  } else {
    viewport.style.overflowX = pdfState.zoomMultiplier > 1 ? 'auto' : 'hidden';
  }
}

async function rebuildForZoom() {
  if (!pdfState.doc) return;
  const pageToRestore = pdfState.currentPage;
  pdfState.generation++;
  renderPipeline.queue.length = 0;
  resetOcrState();
  scrollState.isFast = false;
  renderPipeline.sinceReset = 0;
  renderPipeline.resetPending = false;
  await buildPageSlots();
  scrollToPage(pageToRestore, true);
  reconcileContainers();
  updateCurrentPageFromScroll();
  checkPresentationMode();
  updateZoomUI();
}

function zoomBy(delta) {
  if (!pdfState.doc) return;
  const newZoom = Math.min(3, Math.max(0.5, pdfState.zoomMultiplier + delta));
  if (newZoom === pdfState.zoomMultiplier) return;
  pdfState.zoomMultiplier = newZoom;
  localStorage.setItem('veil-zoom', pdfState.zoomMultiplier);
  rebuildForZoom();
  announce('Zoom ' + Math.round(newZoom * 100) + '%');
}

function zoomReset() {
  if (!pdfState.doc || pdfState.zoomMultiplier === 1.0) return;
  pdfState.zoomMultiplier = 1.0;
  localStorage.setItem('veil-zoom', pdfState.zoomMultiplier);
  rebuildForZoom();
  announce('Zoom reset to 100%');
}

if (btnZoomIn) btnZoomIn.addEventListener('click', () => zoomBy(0.25));
if (btnZoomOut) btnZoomOut.addEventListener('click', () => zoomBy(-0.25));

function checkPresentationMode() {
  if (!pdfState.doc || pdfState.geometry.length <= 1) {
    scrollState.presentationMode = false;
    return;
  }
  // Disabled when zoomed because zoomed pages need free scroll
  if (pdfState.zoomMultiplier > 1) {
    scrollState.presentationMode = false;
    return;
  }
  const firstGeo = pdfState.geometry[1];
  scrollState.presentationMode = firstGeo.cssWidth > firstGeo.cssHeight;
}

viewport.addEventListener('wheel', (e) => {
  if (!scrollState.presentationMode || !pdfState.doc) return;

  e.preventDefault();

  // Accumulate delta to handle trackpad inertia (many small events)
  scrollState.wheelAccum += e.deltaY;

  clearTimeout(scrollState.wheelTimer);
  scrollState.wheelTimer = setTimeout(() => { scrollState.wheelAccum = 0; }, 200);

  if (Math.abs(scrollState.wheelAccum) >= WHEEL_PAGE_THRESHOLD) {
    const direction = scrollState.wheelAccum > 0 ? 1 : -1;
    scrollState.wheelAccum = 0;
    scrollToPage(pdfState.currentPage + direction, true);
  }
}, { passive: false });

// Scroll handling consolidated in the unified scroll coordinator above

let _lastResizeWidth = window.innerWidth;

// --- iOS Zoom Rotation Fix ---
/*
 * When the user zooms in portrait and rotates to landscape (or vice
 * versa), Safari keeps its internal zoom level from the previous
 * orientation. The layout recalculates for the new width, but Safari
 * magnifies it with the stale zoom factor, breaking the layout
 * completely (pages off-screen, navbar inaccessible).
 *
 * Fix: on orientation change, temporarily inject maximum-scale=1 into
 * the viewport meta tag, forcing Safari to reset its zoom to 1x.
 * After 300ms (during the native rotation animation), restore the
 * original value to allow zooming again. On Android this is a no-op
 * since Chrome resets zoom correctly on rotation.
 */
if (/iPad|iPhone/.test(navigator.userAgent)) {
  const vpMeta = document.querySelector('meta[name="viewport"]');
  if (vpMeta) {
    const originalContent = vpMeta.getAttribute('content');
    window.addEventListener('resize', () => {
      // Only trigger on width changes (rotation), not height (keyboard/chrome UI)
      if (window.innerWidth === _lastResizeWidth) return;
      vpMeta.setAttribute('content', originalContent + ', maximum-scale=1');
      setTimeout(() => {
        vpMeta.setAttribute('content', originalContent);
      }, 350);
    });
  }
}


// --- RESIZE ---

/*
 * I only rebuild when the viewport width changes, not height. On
 * mobile, the height changes constantly: Android Chrome hides and
 * shows its address bar on scroll, iOS does the same, and opening
 * the virtual keyboard shrinks the viewport height. None of these
 * affect the page scale (which is calculated from width). Rebuilding
 * on every height change would cause the page to jump (losing the
 * user's scroll position) and destroy the page number input if the
 * keyboard was open.
 *
 * A real width change (window resize on desktop, device rotation on
 * mobile) triggers a full rebuild: recalculate geometry, recreate
 * containers, and restore the scroll position to the same page the
 * user was reading. The 200ms debounce absorbs rapid resize events
 * during window dragging on desktop
 */
window.addEventListener('resize', () => {
  clearTimeout(uiState.resizeTimer);
  uiState.resizeTimer = setTimeout(async () => {
    if (!pdfState.doc) return;
    if (window.innerWidth === _lastResizeWidth) return;
    _lastResizeWidth = window.innerWidth;
    const pageToRestore = pdfState.currentPage;
    pdfState.generation++;
    renderPipeline.queue.length = 0;
    resetOcrState();
    scrollState.isFast = false;
    renderPipeline.sinceReset = 0;
    renderPipeline.resetPending = false;
    await buildPageSlots();
    scrollToPage(pageToRestore, true);
    reconcileContainers();
    updateCurrentPageFromScroll();
    checkPresentationMode();
    updateZoomUI();

    if (isPhoneLandscape()) {
      clearTimeout(uiState.focusTimer);
      enterFocusMode();
    } else {
      exitFocusMode();
    }
  }, 200);
});

// --- Allow dropping a new file onto the reader too ---
readerEl.addEventListener('dragover', (e) => e.preventDefault());
readerEl.addEventListener('drop', async (e) => {
  e.preventDefault();
  const item = e.dataTransfer.items && e.dataTransfer.items[0];
  if (item && item.getAsFileSystemHandle) {
    try {
      const handle = await item.getAsFileSystemHandle();
      if (handle && handle.kind === 'file') {
        const file = await handle.getFile();
        file._handle = handle;
        handleFile(file);
        return;
      }
    } catch (_) {}
  }
  handleFile(e.dataTransfer.files[0]);
});


// --- APP SHELL LOADER AND BOOTSTRAP ---

// Initialize export module with app context
initExport({
  get pdfDoc() { return pdfState.doc; },
  get isScannedDocument() { return pdfState.isScanned; },
  get currentScale() { return pdfState.scale; },
  get pageDarkOverride() { return pdfState.darkOverride; },
  get originalFileName() { return pdfState.fileName; },
  supportsCtxFilter,
  DEPS,
  btnExport,
  exportProgressEl,
  exportProgressFill,
  exportProgressText,
  detectAlreadyDark,
  extractImageRegions,
  showError,
  announce,
  yieldToUI,
});

// Initialize OCR module with app context (read-only getters + function refs)
initOcr({
  get globalGeneration() { return pdfState.generation; },
  get currentVisiblePage() { return pdfState.currentPage; },
  get currentScale() { return pdfState.scale; },
  get isScannedDocument() { return pdfState.isScanned; },
  get pageSlots() { return pdfState.slots; },
  supportsCtxFilter,
  DEPS,
  createOffscreenCanvas,
  returnCanvas,
  buildTextLayer,
  ocrFinished,
});

/*
 * Bootstrap: try to resume the last session. If a saved PDF exists
 * (file handle on desktop, ArrayBuffer on mobile), load it and scroll
 * to the saved page. If not, the user sees the drop zone.
 *
 * The appReady signal at the end tells Playwright e2e tests that all
 * event listeners are registered and the app is ready to accept files.
 * Without it, tests would try to set the file input before the change
 * listener exists
 */
restoreSession().then((restored) => {
  if (!restored) {
    const loader = document.getElementById('app-loader');
    if (loader) loader.hidden = true;
  }
  const transitionOverlay = document.getElementById('page-transition');
  if (transitionOverlay) {
    requestAnimationFrame(() => {
      transitionOverlay.classList.remove('active');
      setTimeout(() => transitionOverlay.remove(), 600);
    });
  }
  document.documentElement.dataset.appReady = 'true';
});
