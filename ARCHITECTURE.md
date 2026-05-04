# Architecture

veil is a client-side PDF reader that applies dark mode while preserving the original colors of images, charts, and diagrams. The whole app runs in the browser, so no data leaves the device. This document explains the architecture and where the details live.

If you want to read the code instead, every JS file opens with a `/* DESIGN */` block that narrates the file's purpose and key choices. This document is the bird's-eye view that connects them.

## Stack

- **Runtime**: vanilla JavaScript ES modules with no build step, loaded as written by the browser.
- **PDF rendering**: [PDF.js](https://mozilla.github.io/pdf.js/) (Mozilla) for parsing and rendering, loaded as ES module from CDN.
- **OCR**: [Tesseract.js](https://tesseract.projectnaptha.com/) for text recognition, runs in a Web Worker as WebAssembly.
- **PDF export**: [pdf-lib](https://pdf-lib.js.org/) plus [fontkit](https://github.com/foliojs/fontkit) for embedding subsetted fonts.
- **Testing**: Vitest for unit tests (pure functions), Playwright for end-to-end (browser integration), happy-dom for fast DOM environment in unit tests.

I chose vanilla JS deliberately. A build pipeline pays off only when you have concrete needs like JSX or code splitting, and none of those apply here. ES modules load directly, and the source on disk is identical to the source the browser executes.

## JavaScript modules

| File | Role |
|---|---|
| [`app.js`](./app.js) | Main orchestrator. Wires the rendering pipeline, the UI, and the browser APIs. |
| [`core.js`](./core.js) | Pure functions (math, detection, text processing). Zero browser dependencies. |
| [`ocr.js`](./ocr.js) | OCR pipeline. Tesseract worker, priority queue, image-region recognition. |
| [`export.js`](./export.js) | Export to dark-mode PDF. Sandwich technique with invisible text layer. |
| [`landing.js`](./landing.js) | Landing page interactions and animations for `index.html` (before/after slider, exploded layers, page transition to reader). |
| [`sw.js`](./sw.js) | Service worker. Three-tier caching for offline support. |
| [`session.js`](./session.js) | Session persistence helpers. |

[`app.js`](./app.js) is intentionally a single large file. State is shared across rendering, scroll, focus mode, and eviction; the functions are intrinsically coupled. Splitting `app.js` into `app-render.js`, `app-ui.js`, etc. would distribute the complexity across files without reducing it. The modules I did extract ([`core.js`](./core.js), [`ocr.js`](./ocr.js), [`export.js`](./export.js), [`session.js`](./session.js)) are genuinely independent and could be lifted into another project, which is exactly the criterion I apply for extraction: a file becomes a separate module only when it can travel as-is into another codebase, never for filesystem aesthetics or to make the main file shorter.

[`core.js`](./core.js) exists as a separate file because it must be importable from both the browser runtime and the Node.js test runner. The rule is: if a function takes data in and returns data out, it lives in `core.js`. If it touches a canvas, a DOM element, or any global state, it stays in `app.js`.

## Presentation layer

| File | Role |
|---|---|
| [`index.html`](./index.html) | Landing page markup with hero (rotating text), before/after slider, exploded layers section, content sections, and ARIA labels. |
| [`reader.html`](./reader.html) | Reader page markup with drop zone (three veil layers for the load animation), toolbar pill, viewport, app shell loader, banners, and screen reader announcer. |
| [`style.css`](./style.css) | Reader styles. CSS filter for dark mode, drop zone (drag-over and load-time animations), focus mode transitions, focus-visible indicators, adaptive layout. |
| [`landing.css`](./landing.css) | Landing page styles. Hero typography, before/after slider, exploded layers animation, content sections. |

The dark mode filter (`filter: invert(0.86) hue-rotate(180deg)`) lives in `style.css`, with the 0.86 value at a single line so it can be tuned in one place. The focus mode auto-hide is driven by CSS transitions that the JS toggles via class names (`toolbar.classList.add('toolbar-hidden')`), not by JS animation loops. Adaptive layout for different screen sizes is handled entirely in CSS via media queries, not by JS detecting device class.

Both HTML files and both CSS files open with a DESIGN block, exactly like the JS files. The HTML blocks document the page states (drop zone, reader, app loader for `reader.html`; landing layout for `index.html`), the accessibility decisions (ARIA labels, screen reader announcer, focus management), and the security choices (Content Security Policy with allow-listed CDNs, no inline scripts).

## How dark mode works

Two layers, controlled by CSS and a canvas overlay.

The bottom layer is a CSS filter on the main viewport: `filter: invert(0.86) hue-rotate(180deg)`. The 0.86 (not 1.0) produces a softer dark-light pair (#242424 background, #DBDBDB text) instead of the harsh black-white of a full inversion, easier on the eyes during long reading.

The top layer is a second canvas that re-paints the original image pixels over the inverted regions. Without this, photos and charts would also be inverted, becoming clinically wrong (an inverted X-ray loses its meaning) or just unreadable.

To know where the images are, I walk the **PDF operator list**. A PDF page is internally a sequence of drawing instructions ("draw text here", "place image there", "change the transform"). I iterate this sequence tracking position via the **CTM** (Current Transformation Matrix, a 6-number array that encodes translation, scale, rotation, and skew). For each `paintImageXObject` operator, I extract the bounding box and add it to the overlay region list. See [`core.js`](./core.js) section "Image region extraction" and section "Overlay composition".

Pages that are already dark by design (slides with dark themes, PDFs with carbon backgrounds) are detected by sampling luminance at page edges and corners ([`core.js`](./core.js) section "Already-dark detection"). These pages skip inversion: inverting an already-dark page would turn it light, defeating the purpose.

The user can override any page with the toolbar toggle. The override is preserved in the exported PDF ([`core.js`](./core.js), section "Dark mode state resolution").

## How OCR works

Two distinct OCR paths.

**Full-page OCR** runs on scanned documents (PDFs that are pure images with no native text). Detection is automatic: I sample the first few pages and check whether they contain extractable text. If not, OCR runs in the background, building a transparent text layer on top of each page so the recognized text becomes selectable.

**Per-image OCR** runs on images embedded inside native PDFs: chart labels, axis text, photographed whiteboards, figure captions. This is uncommon among PDF readers: the text inside a bar chart or a screenshot becomes selectable and searchable.

Inside the pipeline, four optimizations matter:

- **Priority queue**: when the user scrolls quickly past 30 pages, each page enqueues an OCR job. A simple FIFO queue would make page 30 (where the user stopped) wait behind pages 2-29. The queue sorts by distance from the current visible page before each job, so what the user sees gets recognized first.
- **Fingerprint deduplication**: many PDFs repeat the same image (logo, header, watermark) on every page. I hash an 8x8 grid of pixel samples to create a lightweight fingerprint. If the same image appears on another page, OCR is skipped entirely.
- **Text heuristic**: before sending an image to Tesseract (expensive), I check if it likely contains text by measuring edge density. Photos and gradients have low edge density and get skipped.
- **Canvas preprocessing**: converting to grayscale and boosting contrast before OCR improves recognition accuracy. Tested empirically on real medical documents.

Vertical text (chart Y-axis labels, rotated annotations) is recognized in a separate pass with the canvas rotated 90 degrees, triggered by Option/Alt during selection: the pass typically finishes within the drag motion, so there is no perceptible wait.

Tesseract.js itself runs as a Web Worker compiled to WebAssembly, so recognition does not block the UI thread.

See [`ocr.js`](./ocr.js) for the full pipeline.

## Memory model and virtual scrolling

The naive approach (one DOM container per page) exhausts GPU memory on documents with 500+ pages. The browser allocates a canvas context per page; once the budget runs out, every new render either fails or evicts an existing canvas, producing visible gaps and slow re-renders.

Instead, I maintain a pool of **7-15 recycled containers** that get repositioned as the user scrolls. The document appears continuous in the scroll bar (a spacer element provides the full document height), but only a handful of pages exist in the DOM at any given time. A single scroll listener reads `scrollTop` once per frame, and from that one read computes scroll velocity, picks which page containers stay in the DOM, and saves the current page for resume.

Three additional memory techniques:

- **Canvas pool**: reusable offscreen canvases for PDF.js rendering. Borrowing and returning canvases instead of creating new ones avoids GPU context allocation churn on every page render.
- **Engine reset**: PDF.js accumulates internal state (font programs, decoded images, XRef tables) in its worker thread. After 15 page renders on memory-constrained devices (iOS, Android with 4GB or less RAM) or 40 on desktop, I destroy and recreate the entire PDF.js instance to release that state. The visible canvases stay painted during the reset, so the user never notices.
- **Adaptive device profiles**: three classes (constrained, normal mobile, desktop) detected via `navigator.deviceMemory`, user-agent, and hardware concurrency. Each class has its own concurrency limits, render margins, and eviction thresholds.

These optimizations were originally developed for iOS, where the system memory manager (called **Jetsam**) kills browser tabs that exceed ~300MB. They benefit every platform: a curb cut effect, like sidewalk ramps designed for wheelchairs that end up helping everyone with strollers, bikes, and luggage. Therefore, optimizations born from iOS constraints improve the experience on every device.

See the "Virtual Scrolling" to "Page Rendering" sections of the [`app.js`](./app.js) file for the rendering and memory management pipeline.

## Persistence

veil remembers the file you were reading and the page you stopped at, with automatic resume on next visit. Resume metadata (page, filename, and any per-page dark mode overrides) lives in localStorage, while the file itself is stored differently depending on browser capability and size:

- **Desktop (Chrome, Edge)**: when the user picks a file via the file picker, I store a lightweight **file handle** (~30 bytes) in IndexedDB using the File System Access API. On next visit, the browser asks permission to re-read the original file from disk.
- **Mobile and Safari (up to 120MB)**: the File System Access API is not available, so I store the full ArrayBuffer in IndexedDB. The file lives on device storage, not RAM, but at boot the buffer must be deserialized into RAM to give it to PDF.js. 120MB is the empirical limit where a memory-constrained device can still complete this without running out of memory before the UI appears.
- **Files above 120MB**: the file itself is not stored. On next visit the drop zone shows "You were on page X" with the filename, and when the user drops the same file again the filename matches and veil restores the saved page and dark mode overrides.

See [`session.js`](./session.js) and the "Session persistence" section of [`app.js`](./app.js).

## PWA layer

veil is an installable Progressive Web App. The first visit downloads the **app shell** (HTML, CSS, JS, ~470 kB total), and subsequent visits work offline.

The service worker (`sw.js`) uses three caching strategies, one per resource type:

- **App shell** (HTML, CSS, JS): network-first. The user gets the latest version when online, the cached version when offline.
- **CDN libraries** (PDF.js, Tesseract, pdf-lib, fontkit, Noto Sans): cache-first. URLs are versioned and never change once published. Downloaded once, served from cache forever.
- **Google Fonts CSS**: network-first. Google serves different CSS depending on the browser (different font formats for Chrome vs Safari). Caching one browser's CSS would break fonts for another.

Heavy libraries are deliberately **not precached**. Tesseract WASM is ~3MB and language packs are ~2MB each. Precaching them would block the install event for 30+ seconds on slow connections. Instead, they are cached on first use: the first OCR takes a moment to download, then it is instant forever after.

The service worker does not call `skipWaiting()`. Veil is a document app where the user may have a PDF open for hours, and `skipWaiting()` would force the new service worker to take over while the page is still running, potentially crashing the session mid-read if any JS module changed. Instead, the new service worker waits in "installed" state and activates naturally when all tabs close and reopen. The user never sees an update notification.

## Export to dark-mode PDF

The user reads in dark mode and downloads a new PDF with dark mode baked in. The exported file works in any PDF reader on any device, with selectable text and working links.

The technique is a **sandwich PDF**: each page is rasterized as a JPEG image (the visible dark mode rendering), with an invisible text layer on top (`opacity: 0`), the same approach used by professional document scanners.

Key choices:

- **JPEG quality 0.85**: lossy compression to keep file size reasonable. Lossless (PNG) would produce files 4-5x larger. At 0.85, artifacts are invisible to the naked eye during normal reading. Trade-off: vector text becomes raster, so extreme zoom shows pixels.
- **Multi-script fonts**: the invisible text layer needs fonts that cover the document's writing system. Noto Sans Regular handles Latin, Greek, Cyrillic, and math symbols. For Arabic, Hebrew, CJK, Indic, and other scripts, I lazy-load the matching Noto Sans variant from CDN with fontkit for subsetting. Latin-only documents never trigger any extra download. Each font is downloaded once and cached across exports.
- **Width matching**: the invisible text in Noto Sans has different character widths than the original font in the PDF. Without correction, selecting text in the exported PDF would overshoot or undershoot. I measure the natural width and adjust `fontSize` so the selection aligns with the visible text in the image.
- **Link preservation**: PDF link annotations (URLs, internal navigation) are extracted from the original and re-embedded in the exported file with a `http`/`https`/`mailto` whitelist.
- **Memory management**: each page's JPEG bytes are nulled after embedding, the output PDF reference is nulled after save, and every 5 pages I pause for 100ms to let the browser's garbage collector clean up. Same iOS Jetsam constraint that drives the rendering pipeline applies here too.

See [`export.js`](./export.js) for the full export orchestrator.

## Test infrastructure

I follow Salvatore Sanfilippo's (antirez) insight that tests give "eyes" to a coding agent, without testable pure functions, an agent iterates blind. Every architectural decision in veil is supported by tests that anyone can run in seconds to verify a change has not broken existing behavior.

Two layers:

- **Unit tests** ([`tests/unit/`](./tests/unit/)): pure functions in [`core.js`](./core.js), run with Vitest in a happy-dom environment. 387 tests covering image region extraction, OCR artifact filtering, text normalization, multi-column detection, dark mode state resolution.
- **End-to-end tests** ([`tests/e2e/`](./tests/e2e/)): full browser integration with Playwright. 80 tests covering page rendering, text selection, OCR layer integration, export round-trip, accessibility (axe-core), visual regression (golden screenshots).

Total: 467 tests. Fixtures in [`tests/fixtures/`](./tests/fixtures/) are synthetic and public (PDF samples generated for testing). Real-world PDFs with personal or copyrighted content live outside the repository, gitignored.

GitHub Actions runs both suites on Ubuntu (`ubuntu-latest`).

## Further reading

- [`app.js`](./app.js) opens with a complete narrative of what happens when the user drops a PDF, with line numbers for every section.
- [`core.js`](./core.js) documents every magic constant with calibration data.
- [`ocr.js`](./ocr.js) and [`export.js`](./export.js) document the pipelines as numbered flows.
- [`sw.js`](./sw.js) documents the three-tier caching strategy and the rationale for not using `skipWaiting()`.
- The test suite acts as executable documentation: reading [`tests/unit/`](./tests/unit/) is one way to learn the contracts of [`core.js`](./core.js).
