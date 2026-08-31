/* DESIGN
   ------
   * This file contains every pure function in veil (math, detection,
   * text processing) with zero browser dependencies.
   *
   * I deliberately separated these from app.js so they can be imported
   * by both the browser runtime and the Node.js test runner (Vitest).
   * This is the foundation of Salvatore Sanfilippo's (antirez) insight
   * that tests give "eyes" to a coding agent: without testable pure
   * functions, the agent is blind and iterates by guesswork. Every
   * function here can be verified in under a second with `npm test`.
   *
   * The rule for what lives here vs app.js: if a function needs a
   * canvas, a DOM element, or any global state, it stays in app.js.
   * If it takes data in and returns data out, it belongs here.
   *
   * The file follows this flow:
   *
   * 1. CONSTANTS (line 108)
   *    Thresholds and identity values used across the codebase.
   *    Each threshold was calibrated on real documents and the comments
   *    explain why each number was chosen.
   *
   * 2. OCR ARTIFACT DETECTION (line 140)
   *    Filters garbage text from Tesseract's interpretation of borders,
   *    stamps, and logos in scanned documents.
   *
   * 3. MATRIX UTILITIES (line 202)
   *    PDF coordinate math. A PDF stores positions using a 6-number
   *    array called the CTM (Current Transformation Matrix) that encodes
   *    translation, scale, rotation and skew in a single compact form.
   *    Think of it as GPS coordinates for every object on the page.
   *    Complication: PDF coordinates start at the bottom-left with Y
   *    pointing up, but canvas/CSS start at the top-left with Y pointing
   *    down. These functions handle that conversion and exported destinations.
   *
   * 4. IMAGE REGION EXTRACTION (line 359)
   *    A PDF page is a sequence of drawing instructions ("operators"):
   *    "draw text here", "place image there", "change the transform".
   *    I walk this sequence tracking position state to find every
   *    raster image. This is how veil knows which areas to protect
   *    from dark mode inversion.
   *
   * 5. OVERLAY COMPOSITION (line 428)
   *    The dark mode trick: CSS `filter: invert()` on the main canvas
   *    inverts everything (text becomes light, but images become
   *    wrong too). The overlay canvas sits on top with NO filter, and
   *    I copy the original image pixels there. Result: dark text with
   *    original-color images.
   *
   * 6. ALREADY-DARK DETECTION (line 451)
   *    Samples luminance at page edges and corners to detect pages
   *    that are already dark (slides, dark-themed PDFs). These pages
   *    skip inversion because inverting an already-dark page makes it light.
   *
   * 7. DARK MODE STATE RESOLUTION (line 501)
   *    Decides whether to apply dark mode on a given page. Three states:
   *    auto (respects detection), force dark, force light. The user can
   *    override any page with the toggle button, and the override is
   *    preserved in the exported PDF.
   *
   * 8. TEXT NORMALIZATION (line 518)
   *    Decomposes typographic ligatures (ﬁ->fi, ﬂ->fl) so copy/paste
   *    produces normal characters instead of special Unicode glyphs.
   *
   * 9. PUNCTUATION MERGING (line 538)
   *    Fuses tiny standalone punctuation items (3-4px wide periods,
   *    commas) into the preceding word so they're selectable.
   *
   * 10. TEXT LAYER UTILITIES (line 598)
   *     Line grouping (which words belong on the same line?) and word
   *     boundary detection (should there be a space between two spans?).
   *     Used by both the native text layer and the OCR text layer.
   *
   * 11. SCALE CALCULATION (line 685)
   *     Determines how large to render each page. Fit-to-page on desktop,
   *     fit-to-width on mobile landscape.
   *
   * 12. NAVIGATOR LANGUAGE MAPPING (line 705)
   *     Maps the user's OS language to a Tesseract language code so the
   *     OCR worker starts with the right model from the beginning.
   *
   * 13. SCANNED DOCUMENT DETECTION (line 754)
   *     Samples multiple pages to determine if the PDF is a scan (one
   *     full-page image per page, almost no native text).
   *
   * 14. OCR LANGUAGE DETECTION (line 783)
   *     Detects the document language from character frequency and
   *     function words. Used as a fallback when navigator.languages
   *     doesn't provide a non-English language.
   *
   * 15. SCRIPT DETECTION (line 932)
   *     Identifies the writing system of a text string by scanning for
   *     Unicode range patterns. Used by the export pipeline to select
   *     the correct Noto Sans font variant for each text item, enabling
   *     proper rendering of Arabic, Hebrew, CJK, Indic and every other
   *     major writing system in exported PDFs.
   *
   * 16. IMAGE CONTENT ANALYSIS (line 987)
   *     Detects OCR overlays (Adobe Paper Capture scans with invisible
   *     text layer) using four independent signals: image coverage,
   *     text containment, character density, and blank paper analysis.
   *     Prevents false positives on book covers, magazine layouts,
   *     and photographic slides.
*/


// --- CONSTANTS ---

/*
 * The identity matrix, meaning "no transformation". When applied, things
 * stay where they are. PDF uses 6 numbers [a b c d e f] to encode
 * position, scale and rotation in a single array
 */
export const IDENTITY_MATRIX = [1, 0, 0, 1, 0, 0];

/*
 * 40% luminance: below this, a page is considered "already dark" and
 * inversion is skipped. Calibrated on real dark-themed slides: too low
 * and beige backgrounds get inverted, too high and grey slides are skipped
 */
export const DARK_LUMINANCE_THRESHOLD = 0.4;

/*
 * Scanned document detection: a page is "scanned" if it has one image
 * covering >85% of the surface and <50 characters of native text.
 * Sampling 3-5 pages avoids false positives on photo books
 */
export const SCAN_IMAGE_COVERAGE_THRESHOLD = 0.85;
export const SCAN_TEXT_CHAR_THRESHOLD = 50;

/*
 * OCR confidence: Tesseract returns 0-100 per word. Real text scores
 * 60-95%, stamps and logos score 5-20%. 45% catches garbage without
 * losing legitimate blurry text (which scores 50-70%)
 */
export const OCR_CONFIDENCE_THRESHOLD = 45;


// --- OCR ARTIFACT DETECTION ---

/*
 * Tesseract interprets non-text elements in scanned documents
 * (borders, lines, stamps, logos) as text characters. These
 * "artifact words" are composed entirely of symbols/punctuation
 * with no letters or digits. Examples: "|", "\", "{|", "————".
 *
 * This filter removes them from the text layer without touching
 * real content. Safe for all document types (code, math, research)
 * because any word with at least one letter or digit passes through.
 *
 * Two rules:
 *   1. Sequences of 2+ line/border characters (dash, pipe, etc.)
 *      are always artifacts: "————", "_—", "||", "=/="
 *   2. Single characters from the "never standalone" set are
 *      artifacts: "|", "\", "€", "©", etc.
 *
 * NOT filtered: "-" (bullet point), "—" (em dash), ".", ":", ";"
 * (legitimate punctuation that may appear as standalone words).
 *
 * References:
 *   - github.com/tesseract-ocr/tesseract/issues/3597
 *     Capital "I" gets misread as pipe "|"
 *   - github.com/tesseract-ocr/tesseract/issues/1465
 *     Tesseract inserts extra characters at low confidence
 *   - tesseract-ocr.github.io/tessdoc/ImproveQuality.html
 *     Dark borders in scanned documents produce ghost characters
 */

// Characters that form border/line artifacts when in sequences of 2+
const OCR_LINE_CHARS_RE = /^[-—–_|\\\/=~]+$/;

// Single characters that are never standalone words in any document.
// Excludes: - (bullet), — (em dash), . : ; , ! ? (punctuation)
const OCR_NEVER_STANDALONE_RE = /^[|\\{}[\]©®™€£¥¢°§¶†‡•~^*_=<>\/]+$/;

/*
 * Returns true if the word is an OCR artifact (non-text noise from
 * borders, lines, stamps, or logos in the scanned document).
 *
 * A word with at least one letter or digit in ANY script (Latin,
 * Cyrillic, CJK, Arabic, etc.) is always considered real content.
 */
export function isOcrArtifact(text) {
  if (!text) return true;
  const t = text.trim();
  if (!t) return true;

  // Any letter or digit in any script -> real content, keep it
  if (/[\p{L}\p{N}]/u.test(t)) return false;

  // Sequences of 2+ line/border characters -> artifact
  if (t.length >= 2 && OCR_LINE_CHARS_RE.test(t)) return true;

  // Single characters from the "never standalone" set -> artifact
  if (OCR_NEVER_STANDALONE_RE.test(t)) return true;

  return false;
}


// --- MATRIX UTILITIES ---

/*
 * A PDF matrix is 6 numbers: [a b c d e f]. The first four (a,b,c,d)
 * handle scale, rotation and skew. The last two (e,f) are the X,Y
 * position. multiplyMatrices combines two transforms into one, like
 * saying "first move here, then scale by this much" in a single step
 */
export function multiplyMatrices(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function transformPoint(matrix, x, y) {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5],
  ];
}

/*
 * PDF.js right-angle viewport matrices can retain sine or cosine residue
 * near zero. I use this tolerance both to identify the intended axis and
 * to remove that residue from destination coordinates written to the PDF.
 */
const PDF_DESTINATION_EPSILON = 1e-10;

function cleanPdfDestinationNumber(value) {
  if (Math.abs(value) < PDF_DESTINATION_EPSILON) return 0;
  return Math.round(value * 1e10) / 1e10;
}

function transformPdfDestinationAxis(firstCoefficient, firstValue, secondCoefficient, secondValue, offset) {
  let result = offset;

  if (Math.abs(firstCoefficient) >= PDF_DESTINATION_EPSILON) {
    if (!Number.isFinite(firstValue)) return null;
    result += firstCoefficient * firstValue;
  }
  if (Math.abs(secondCoefficient) >= PDF_DESTINATION_EPSILON) {
    if (!Number.isFinite(secondValue)) return null;
    result += secondCoefficient * secondValue;
  }

  return cleanPdfDestinationNumber(result);
}

function transformPdfDestinationPoint(viewport, x, y) {
  const [a, b, c, d, e, f] = viewport.transform;
  return [
    cleanPdfDestinationNumber(a * x + c * y + e),
    cleanPdfDestinationNumber(-b * x - d * y + viewport.height - f),
  ];
}

/*
 * The export flattens CropBox offsets and page rotation into each page image.
 * I transform destination coordinates through that same viewport so bookmarks
 * still land on the location the source PDF intended. Rotated axis-fit and
 * content-bounding-box modes have no exact raster equivalent, so I fall back
 * to a full-page fit instead of silently changing their zoom semantics.
 */
export function transformPdfDestination(explicitDest, viewport) {
  const modeValue = explicitDest[1];
  const mode = typeof modeValue === 'object' && modeValue?.name
    ? modeValue.name
    : typeof modeValue === 'string'
      ? modeValue.replace(/^\//, '')
      : null;
  const values = explicitDest.slice(2);
  const [a, b, c, d, e, f] = viewport.transform;
  const outputTopOffset = viewport.height - f;

  if (mode === 'XYZ') {
    const left = Number.isFinite(values[0]) ? values[0] : null;
    const top = Number.isFinite(values[1]) ? values[1] : null;
    const zoom = Number.isFinite(values[2]) ? values[2] : null;
    return [
      mode,
      transformPdfDestinationAxis(a, left, c, top, e),
      transformPdfDestinationAxis(-b, left, -d, top, outputTopOffset),
      zoom,
    ];
  }

  if (mode === 'FitB') return ['Fit'];

  if (mode === 'FitH' || mode === 'FitBH') {
    const top = Number.isFinite(values[0]) ? values[0] : null;

    if (Math.abs(b) < PDF_DESTINATION_EPSILON) {
      return ['FitH', transformPdfDestinationAxis(0, null, -d, top, outputTopOffset)];
    }
    return ['Fit'];
  }

  if (mode === 'FitV' || mode === 'FitBV') {
    const left = Number.isFinite(values[0]) ? values[0] : null;

    if (Math.abs(c) < PDF_DESTINATION_EPSILON) {
      return ['FitV', transformPdfDestinationAxis(a, left, 0, null, e)];
    }
    return ['Fit'];
  }

  if (mode === 'FitR') {
    if (values.length < 4 || !values.slice(0, 4).every(Number.isFinite)) {
      return ['Fit'];
    }

    const [left, bottom, right, top] = values;
    const corners = [
      transformPdfDestinationPoint(viewport, left, bottom),
      transformPdfDestinationPoint(viewport, left, top),
      transformPdfDestinationPoint(viewport, right, bottom),
      transformPdfDestinationPoint(viewport, right, top),
    ];
    const xs = corners.map(point => point[0]);
    const ys = corners.map(point => point[1]);
    return [mode, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  return explicitDest.slice(1);
}

/*
 * Every image in a PDF starts as a 1×1 square, then gets stretched and
 * positioned by the transformation matrix. I transform all four corners
 * of this unit square and take the bounding box. This correctly handles
 * rotated and skewed images that a naive (x,y,w,h) approach would miss
 */
export function computeImageBounds(ctm, viewportTransform) {
  const final = multiplyMatrices(viewportTransform, ctm);

  const c0 = transformPoint(final, 0, 0);
  const c1 = transformPoint(final, 1, 0);
  const c2 = transformPoint(final, 1, 1);
  const c3 = transformPoint(final, 0, 1);

  const xs = [c0[0], c1[0], c2[0], c3[0]];
  const ys = [c0[1], c1[1], c2[1], c3[1]];

  return {
    x: Math.floor(Math.min(...xs)),
    y: Math.floor(Math.min(...ys)),
    width: Math.ceil(Math.max(...xs)) - Math.floor(Math.min(...xs)),
    height: Math.ceil(Math.max(...ys)) - Math.floor(Math.min(...ys)),
  };
}


// --- IMAGE REGION EXTRACTION ---

/*
 * I walk the PDF.js operator list maintaining a CTM stack (save/restore)
 * to find every raster image on the page. This is how veil knows what
 * to protect from inversion. Without it, photos, charts and diagrams
 * would be color-inverted along with the text.
 *
 * I chose this approach (public API getOperatorList) over forking PDF.js
 * because PDF.js has 500k+ lines and upstream updates are frequent.
 * The operator list is stable across versions.
 *
 * Key OPS from PDF.js v5.4.149:
 *   save:10, restore:11, transform:12    (CTM stack)
 *   paintFormXObjectBegin:74, End:75     (sub-contexts)
 *   paintImageXObject:85                 (standard images)
 *   paintInlineImageXObject:86           (inline images)
 *   paintImageXObjectRepeat:88           (tiled/repeated images)
 *
 * `opsMap` is a bridge object that maps these names to numeric codes,
 * so this function stays independent of the pdfjsLib import
 */
export function extractImageRegions(opList, viewportTransform, opsMap) {
  const regions = [];
  const ctmStack = [];
  let ctm = [...IDENTITY_MATRIX];

  const fnArray = opList.fnArray;
  const argsArray = opList.argsArray;

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i];
    const args = argsArray[i];

    if (op === opsMap.save) {
      // A malformed PDF could emit millions of save ops without matching
      // restores, growing the stack without limit. 1000 levels is far
      // beyond any legitimate nesting (real PDFs rarely exceed 10-20)
      if (ctmStack.length > 1000) continue;
      ctmStack.push([...ctm]);
    } else if (op === opsMap.restore) {
      ctm = ctmStack.pop() || [...IDENTITY_MATRIX];
    } else if (op === opsMap.transform) {
      ctm = multiplyMatrices(ctm, args);
    } else if (op === opsMap.paintFormXObjectBegin) {
      ctmStack.push([...ctm]);
      if (args[0]) {
        ctm = multiplyMatrices(ctm, args[0]);
      }
    } else if (op === opsMap.paintFormXObjectEnd) {
      ctm = ctmStack.pop() || [...IDENTITY_MATRIX];
    } else if (op === opsMap.paintImageXObject || op === opsMap.paintInlineImageXObject) {
      regions.push(computeImageBounds(ctm, viewportTransform));
    } else if (op === opsMap.paintImageXObjectRepeat) {
      if (args.length > 3) {
        for (let j = 3; j < args.length; j += 2) {
          const repeatCtm = multiplyMatrices(ctm, [1, 0, 0, 1, args[j], args[j + 1]]);
          regions.push(computeImageBounds(repeatCtm, viewportTransform));
        }
      } else {
        regions.push(computeImageBounds(ctm, viewportTransform));
      }
    }
  }

  return regions;
}


// --- OVERLAY COMPOSITION ---

/*
 * After the main canvas is CSS-inverted, the overlay canvas paints
 * the original (non-inverted) pixels back over the image regions.
 * The overlay sits above the main canvas with no CSS filter, so the
 * images appear in their true colors while text around them is dark
 */
export function compositeImageRegions(ctx, sourceCanvas, regions, canvasW, canvasH) {
  for (const r of regions) {
    const sx = Math.max(0, r.x);
    const sy = Math.max(0, r.y);
    const sx2 = Math.min(canvasW, r.x + r.width);
    const sy2 = Math.min(canvasH, r.y + r.height);
    const sw = sx2 - sx;
    const sh = sy2 - sy;

    if (sw <= 0 || sh <= 0) continue;
    ctx.drawImage(sourceCanvas, sx, sy, sw, sh, sx, sy, sw, sh);
  }
}


// --- ALREADY-DARK DETECTION ---

/*
 * I sample luminance at edges and corners because that's where the
 * page background is most likely exposed (text and images tend to be
 * centered). A single getImageData reads all pixels once, and sampling
 * from the same array avoids multiple GPU readbacks.
 *
 * The luminance formula (0.299R + 0.587G + 0.114B) weights green
 * highest because human eyes are most sensitive to green light.
 * This is the BT.601 standard, the same one WCAG accessibility
 * guidelines use. It gives better results on warm-toned PDFs than
 * the alternative (BT.709) which was designed for HD video
 */
export function detectAlreadyDark(pixelData, width, height) {
  if (width <= 0 || height <= 0 || pixelData.length === 0) return false;
  const samplePoints = [];
  const margin = Math.max(5, Math.floor(Math.min(width, height) * 0.02));
  const step = Math.max(1, Math.floor(Math.min(width, height) * 0.05));

  // Corners
  samplePoints.push(
    [margin, margin], [width - margin, margin],
    [margin, height - margin], [width - margin, height - margin],
  );

  // Edges
  for (let x = margin; x < width - margin; x += step) {
    samplePoints.push([x, margin], [x, height - margin]);
  }
  for (let y = margin; y < height - margin; y += step) {
    samplePoints.push([margin, y], [width - margin, y]);
  }

  let totalLuminance = 0;
  let count = 0;

  for (const [sx, sy] of samplePoints) {
    const idx = (sy * width + sx) * 4;
    if (idx + 2 >= pixelData.length) continue;
    const luminance = (0.299 * pixelData[idx] + 0.587 * pixelData[idx + 1] + 0.114 * pixelData[idx + 2]) / 255;
    totalLuminance += luminance;
    count++;
  }

  const avgLuminance = count > 0 ? totalLuminance / count : 1;
  return avgLuminance < DARK_LUMINANCE_THRESHOLD;
}


// --- DARK MODE STATE RESOLUTION ---

/*
 * Three states per page: auto (default), force dark, force light.
 * Auto respects the already-dark detection: an already-dark slide
 * stays untouched. The user can always override with the toggle button,
 * and the override is preserved in the exported PDF
 */
export function shouldApplyDark(pageNum, pageDarkOverride, pageAlreadyDark) {
  const override = pageDarkOverride.get(pageNum);
  if (override === 'dark') return true;
  if (override === 'light') return false;
  if (pageAlreadyDark.get(pageNum)) return false;
  return true;
}


// --- TEXT NORMALIZATION ---

/*
 * Some fonts store "fi" as a single glyph (a ligature) instead of two
 * separate letters. When the user copies text, they get the ligature
 * character (ﬁ) instead of "f" + "i", which breaks search and looks
 * wrong in plain text editors.
 *
 * NFKD ("Compatibility Decomposition") is a Unicode standard operation
 * that splits these combined characters back into their parts:
 *   ﬁ -> fi,  ﬂ -> fl,  ﬀ -> ff,  ﬃ -> ffi,  ﬄ -> ffl
 *
 * Safe for all text: strings without ligatures pass through unchanged
 */
export function normalizeLigatures(str) {
  if (!str) return str;
  return str.normalize('NFKD');
}


// --- PUNCTUATION MERGING ---

/*
 * Merges trailing punctuation items into the preceding word.
 *
 * In many PDFs, punctuation marks (., !, ?, ;, :, etc.) are
 * emitted as separate text items with tiny bounding boxes (3-4px).
 * This makes them nearly impossible to select with the mouse.
 *
 * This function scans a line (array of items sorted left-to-right)
 * and merges any item that consists solely of trailing punctuation
 * into the previous item, extending its width to cover both.
 *
 * Items at position 0 (line start) are never merged. Punctuation
 * at the start of a line is unusual and may be intentional (e.g.
 * bullet points, opening quotes).
 *
 * Each item must have at least: { str, left, width }
 * Items may also have: { pdfWidth } (used in native text layer)
 *
 * Returns a new array (does not mutate the input).
 */
const TRAILING_PUNCT_RE = /^[.!?,;:)\]}"'»›\u2019\u201D]+$/;

export function mergePunctuation(line) {
  if (line.length <= 1) return line.map(item => ({ ...item }));

  const merged = [];

  for (let i = 0; i < line.length; i++) {
    const item = line[i];

    // Check if this item is purely trailing punctuation and
    // there is a preceding item to merge into
    if (i > 0 && item.str && TRAILING_PUNCT_RE.test(item.str)) {
      const prev = merged[merged.length - 1];
      if (prev) {
        // Extend the previous item to cover this punctuation
        const newWidth = (item.left + item.width) - prev.left;
        const newItem = {
          ...prev,
          str: prev.str + item.str,
          width: newWidth,
        };
        // Also update pdfWidth if present (native text layer)
        if ('pdfWidth' in prev) {
          newItem.pdfWidth = newWidth;
        }
        merged[merged.length - 1] = newItem;
        continue;
      }
    }

    merged.push({ ...item });
  }

  return merged;
}


// --- TEXT LAYER UTILITIES ---

/*
 * Groups an array of items (each with `top` and `height`)
 * into lines based on vertical proximity. Two items are on the
 * same line if the difference in their `top` is less than 50%
 * of the current line height.
 *
 * Why 50%? It needs to be generous enough to keep words with
 * different baselines on the same line (e.g. superscripts,
 * mixed font sizes), but strict enough to separate actual lines.
 * At 50%, two items must overlap vertically by at least half
 * their height to be grouped together.
 *
 * Returns array of arrays (each sub-array is a line).
 * Items are pre-sorted by top then left.
 */
export function groupItemsIntoLines(items) {
  if (items.length === 0) return [];

  const sorted = [...items].sort((a, b) => a.top - b.top || a.left - b.left);

  const lines = [];
  let currentLine = [sorted[0]];
  let lineTop = sorted[0].top;
  let lineHeight = sorted[0].height;

  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];
    const threshold = lineHeight * 0.5;

    if (Math.abs(item.top - lineTop) < threshold) {
      currentLine.push(item);
      if (item.height > lineHeight) lineHeight = item.height;
    } else {
      lines.push(currentLine);
      currentLine = [item];
      lineTop = item.top;
      lineHeight = item.height;
    }
  }
  lines.push(currentLine);

  return lines;
}

/*
 * Determines whether a TextNode space should be inserted
 * between two adjacent text items at a style boundary.
 *
 * The problem: when a PDF switches font mid-line (e.g. "I " in
 * regular followed by "hate" in italic), the space can end up
 * trapped inside an inline-block span. CSS white-space collapsing
 * silently eats trailing spaces inside inline-block elements, so
 * "I hate talking about" becomes "Ihatetalking about" in the clipboard.
 *
 * The fix has two parts:
 *   - CSS `white-space: pre` on all spans (preserves trailing spaces)
 *   - This function decides when to insert an explicit TextNode(' ')
 *
 * Three scenarios:
 *   1. prevStr ends with whitespace: space is already in the DOM,
 *      white-space:pre preserves it. No TextNode needed.
 *   2. itemStr starts with whitespace: same logic.
 *   3. Neither has whitespace but the geometric gap between the two
 *      items is > 15% of the fontSize: insert a TextNode(' ') and
 *      reduce the gap by the width of a space character.
 *
 * The 15% threshold was chosen because smaller gaps are typically
 * kerning (intentional tight spacing), not word boundaries.
 *
 * Returns { insertSpace: boolean, adjustedGap: number }
 */
export function shouldInsertSpace(prevStr, itemStr, gap, fontSize, spaceAdvance) {
  if (!prevStr) return { insertSpace: false, adjustedGap: gap };

  const prevEndsSpace = /\s$/.test(prevStr);
  const currStartsSpace = /^\s/.test(itemStr);

  if (!prevEndsSpace && !currStartsSpace && gap > fontSize * 0.15) {
    return { insertSpace: true, adjustedGap: gap - spaceAdvance };
  }

  return { insertSpace: false, adjustedGap: gap };
}


// --- SCALE CALCULATION ---

/*
 * I chose fit-to-page (min of width and height constraint) as the default
 * because the first page should be fully visible on load. On mobile landscape,
 * fitToWidth ignores the height constraint because the user scrolls vertically,
 * and horizontal content shouldn't be clipped. Cap at 3x prevents absurdly
 * large canvases on ultrawide monitors
 */
export function calculateScale(pageWidth, pageHeight, windowWidth, windowHeight, toolbarHeight = 48, padding = 16, fitToWidth = false) {
  if (pageWidth <= 0 || pageHeight <= 0) return 1;
  const availW = windowWidth - padding;
  const availH = windowHeight - toolbarHeight - padding;
  if (fitToWidth) {
    return Math.min(availW / pageWidth, 3);
  }
  return Math.min(availW / pageWidth, availH / pageHeight, 3);
}


// --- NAVIGATOR LANGUAGE MAPPING ---

/*
 * I use navigator.languages (the OS language preferences) instead of
 * asking the user to pick a language. This is the Apple approach: zero
 * questions, the system already knows. Tesseract uses an LSTM neural
 * network (a type of AI that reads sequences of shapes, letter by letter)
 * to recognize characters regardless of language model. The model
 * only affects confidence scoring and word boundaries. So eng+ita
 * recognizes both English and Italian text without asking
 */

const BCP47_TO_TESSERACT = {
  it: 'ita', fr: 'fra', de: 'deu', es: 'spa', pt: 'por',
  ru: 'rus', ja: 'jpn', zh: 'chi_sim', ko: 'kor', ar: 'ara',
  nl: 'nld', pl: 'pol', sv: 'swe', da: 'dan', no: 'nor',
  fi: 'fin', cs: 'ces', ro: 'ron', hu: 'hun', el: 'ell',
  tr: 'tur', uk: 'ukr', hi: 'hin', th: 'tha', vi: 'vie',
};

/*
 * Returns the Tesseract language code for the user's primary
 * non-English language, or null if the user's system is English-only.
 *
 * Reads navigator.languages (the OS language preferences) and maps
 * the first non-English entry to a Tesseract code. This is privacy-
 * respecting: the user explicitly configured these languages in
 * their OS settings.
 *
 * Examples:
 *   ['it-IT', 'en-US'] -> 'ita'
 *   ['en-US']          -> null
 *   ['de-DE', 'en-GB'] -> 'deu'
 */
export function getNavigatorLanguage() {
  const langs = (typeof navigator !== 'undefined' && navigator.languages)
    ? navigator.languages
    : [];

  for (const lang of langs) {
    const code = lang.split('-')[0].toLowerCase();
    if (code === 'en') continue;
    if (BCP47_TO_TESSERACT[code]) return BCP47_TO_TESSERACT[code];
  }

  return null;
}


// --- SCANNED DOCUMENT DETECTION ---

/*
 * A scanned PDF is one image per page with almost no native text.
 * I sample 3-5 pages spread across the document (not just page 1)
 * because a photo book could have full-page images on some pages
 * but mixed layout on others. ALL sampled pages must match the
 * pattern for the document to be classified as scanned.
 *
 * When detected, two things change:
 * 1. Image protection is skipped (the image IS the content)
 * 2. OCR runs automatically to make text selectable
 */

// Returns true only if ALL sampled pages match the scanned pattern.
// A single page with real text or without a dominant image breaks the match,
// preventing false positives on photo books or mixed documents
export function isScannedPattern(pageSamples) {
  if (pageSamples.length === 0) return false;

  for (const sample of pageSamples) {
    if (sample.charCount >= SCAN_TEXT_CHAR_THRESHOLD) return false;
    if (sample.maxImageCoverage < SCAN_IMAGE_COVERAGE_THRESHOLD) return false;
  }

  return true;
}


// --- OCR LANGUAGE DETECTION ---

/*
 * I detect language from character frequency and function words
 * rather than using an external library. The LSTM engine recognizes
 * accented characters (è, ñ, ü) even with the English model loaded,
 * so they're reliable signals. Function words
 * ("il", "la", "der", "les") confirm the detection.
 *
 * Threshold calibrated at 6 to reject false positives from English
 * loanwords (café, résumé, naïve) while still catching real
 * non-English text with few distinctive markers
 */

const LANG_PROFILES = [
  {
    code: 'ita',
    // Accented characters distinctive to Italian (è, à, ù, ò, ì but NOT é which is shared with French)
    chars: /[èàùòì]/g,
    charWeight: 3,
    // Common Italian function words, includes very short words (e, al, si)
    // that are distinctively Italian as standalone tokens
    words: /\b(il|la|di|che|per|una|del|con|dei|gli|nel|dal|alla|dalla|nella|delle|sono|della|questo|questa|anche|come|dopo|ogni|prima|stato|tutti|essere|al|si|lo|le|un|suo|sua|nei)\b/gi,
    wordWeight: 2,
    // Standalone "e" (= "and" in Italian) is very common and distinctive.
    // Separate pattern because \be\b is too aggressive in the main regex.
    extraWords: /\b[eè]\b/gi,
    extraWeight: 2,
  },
  {
    code: 'fra',
    // Only highly distinctive French chars (not é which appears in loanwords)
    chars: /[êëçœîôûæ]/g,
    charWeight: 3,
    // é gets lower weight because it appears in English loanwords (café, résumé)
    sharedChars: /[é]/g,
    sharedCharWeight: 1,
    words: /\b(le|la|de|les|des|une|est|que|dans|pour|sur|avec|sont|cette|mais|nous|vous|tout|elle|leur|peut|fait|bien|plus|qui|pas)\b/gi,
    wordWeight: 2,
  },
  {
    code: 'deu',
    chars: /[üöäß]/g,
    charWeight: 4,  // ß and umlauts are very distinctive
    words: /\b(der|die|das|und|ist|von|den|dem|ein|eine|mit|auf|des|sich|nicht|als|auch|nach|wie|bei|wird|sind|kann|noch|sein|über)\b/gi,
    wordWeight: 2,
  },
  {
    code: 'spa',
    chars: /[ñ¿¡]/g,
    charWeight: 5,  // ñ, ¿, ¡ are nearly unique to Spanish
    words: /\b(el|los|las|del|una|que|por|con|para|como|pero|este|esta|son|todo|tiene|puede|desde|hasta|entre|cada)\b/gi,
    wordWeight: 2,
  },
  {
    code: 'por',
    chars: /[ãõ]/g,
    charWeight: 5,  // ã, õ are nearly unique to Portuguese
    words: /\b(que|em|para|com|uma|por|dos|das|mais|como|mas|seu|sua|foi|tem|são|pode|este|esta|pelo|pela)\b/gi,
    wordWeight: 2,
  },
];

// Minimum score to switch away from English.
// Calibrated to reject false positives from English loanwords (café, résumé, naïve)
// while still detecting real non-English text with few distinctive markers.
const LANG_DETECT_THRESHOLD = 6;

// Scores each language profile against the input text and returns
// the best match. Falls back to 'eng' when the score is below
// threshold, which is the safe default (English covers most Latin text)
export function detectLanguageFromText(text) {
  if (!text || text.length < 20) return 'eng';

  const lower = text.toLowerCase();

  // Non-Latin script detection (character ranges).
  // These are checked first because they're unambiguous: if 20%+ of
  // characters are Cyrillic/Arabic or 10%+ are CJK, that's definitive.
  const cyrillicCount = (text.match(/[\u0400-\u04FF]/g) || []).length;
  if (cyrillicCount > text.length * 0.2) return 'rus';

  const cjkCount = (text.match(/[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g) || []).length;
  if (cjkCount > text.length * 0.1) {
    if ((text.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length > 0) return 'jpn';
    if ((text.match(/[\uAC00-\uD7AF]/g) || []).length > 0) return 'kor';
    return 'chi_sim';
  }

  const arabicCount = (text.match(/[\u0600-\u06FF]/g) || []).length;
  if (arabicCount > text.length * 0.2) return 'ara';

  // Latin-script language detection.
  // Score each language by distinctive characters + function words.
  let bestCode = 'eng';
  let bestScore = 0;

  for (const profile of LANG_PROFILES) {
    let score = 0;
    let hasDistinctiveEvidence = false;

    // Primary distinctive characters (high weight)
    const charMatches = lower.match(profile.chars);
    if (charMatches) {
      score += charMatches.length * profile.charWeight;
      hasDistinctiveEvidence = true;
    }

    // Shared characters that appear in multiple languages (low weight).
    // These contribute to score but are NOT considered distinctive,
    // so they can't trigger a language switch on their own. This prevents
    // English loanwords (café, résumé, naïve) from false-triggering French.
    if (profile.sharedChars) {
      const shared = lower.match(profile.sharedChars);
      if (shared) score += shared.length * (profile.sharedCharWeight || 1);
    }

    // Function words (distinctive evidence)
    const wordMatches = lower.match(profile.words);
    if (wordMatches) {
      score += wordMatches.length * profile.wordWeight;
      hasDistinctiveEvidence = true;
    }

    // Extra word patterns (e.g. standalone "e"/"è" for Italian)
    if (profile.extraWords) {
      const extra = lower.match(profile.extraWords);
      if (extra) {
        score += extra.length * (profile.extraWeight || 1);
        hasDistinctiveEvidence = true;
      }
    }

    // Without distinctive evidence (only sharedChars matched),
    // cap the score below threshold to prevent false positives.
    if (!hasDistinctiveEvidence) {
      score = Math.min(score, LANG_DETECT_THRESHOLD - 1);
    }

    if (score > bestScore) {
      bestScore = score;
      bestCode = profile.code;
    }
  }

  return bestScore >= LANG_DETECT_THRESHOLD ? bestCode : 'eng';
}


// --- SCRIPT DETECTION ---

/*
 * Identifies the writing system of a text string. The export pipeline
 * uses this to select the correct Noto Sans font variant (Arabic text
 * needs Noto Sans Arabic, Chinese needs Noto Sans SC, and so on).
 *
 * PDF.js getTextContent() returns text in base Unicode codepoints
 * (e.g. U+0628 for Arabic ba, not the presentation form U+FE91).
 * Fontkit applies the font's GSUB shaping tables during embedding,
 * so the base codepoints are all we need to detect the script.
 *
 * The ranges below cover every major living writing system. Each font
 * is lazy-loaded from CDN only when a document actually contains that
 * script, so Latin-only users pay zero cost.
 *
 * CJK detection: Japanese uses Hiragana/Katakana (unique to Japanese),
 * Korean uses Hangul (unique to Korean). CJK ideographs shared between
 * Chinese/Japanese/Korean default to Simplified Chinese (Noto Sans SC)
 * which renders all three correctly for the invisible text layer.
 */
export const SCRIPT_RANGES = [
  { name: 'arabic',     test: /[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/ },
  { name: 'hebrew',     test: /[\u0590-\u05FF\uFB1D-\uFB4F]/ },
  { name: 'devanagari', test: /[\u0900-\u097F\uA8E0-\uA8FF]/ },
  { name: 'bengali',    test: /[\u0980-\u09FF]/ },
  { name: 'gurmukhi',   test: /[\u0A00-\u0A7F]/ },
  { name: 'gujarati',   test: /[\u0A80-\u0AFF]/ },
  { name: 'tamil',      test: /[\u0B80-\u0BFF]/ },
  { name: 'telugu',     test: /[\u0C00-\u0C7F]/ },
  { name: 'kannada',    test: /[\u0C80-\u0CFF]/ },
  { name: 'malayalam',  test: /[\u0D00-\u0D7F]/ },
  { name: 'sinhala',    test: /[\u0D80-\u0DFF]/ },
  { name: 'thai',       test: /[\u0E00-\u0E7F]/ },
  { name: 'lao',        test: /[\u0E80-\u0EFF]/ },
  { name: 'tibetan',    test: /[\u0F00-\u0FFF]/ },
  { name: 'myanmar',    test: /[\u1000-\u109F]/ },
  { name: 'georgian',   test: /[\u10A0-\u10FF\u2D00-\u2D2F]/ },
  { name: 'armenian',   test: /[\u0530-\u058F]/ },
  { name: 'ethiopic',   test: /[\u1200-\u137F\u1380-\u139F]/ },
  { name: 'khmer',      test: /[\u1780-\u17FF]/ },
  { name: 'japanese',   test: /[\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF]/ },
  { name: 'korean',     test: /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/ },
  { name: 'cjk',        test: /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/ },
];

export function detectScript(str) {
  if (!str) return 'latin';
  for (const range of SCRIPT_RANGES) {
    if (range.test.test(str)) return range.name;
  }
  return 'latin';
}


// --- IMAGE CONTENT ANALYSIS ---

/*
 * I analyze the pixel content of an image region to detect scanned
 * paper (Adobe Paper Capture). A scan of a document page has >85%
 * of pixels near-white (luminance >200) because it is photographed
 * paper with printed text. A photograph or illustration has a much
 * wider brightness distribution even if it appears "light."
 *
 * I sample with a stride to avoid reading every pixel. On a 300x400
 * image this reads ~2500 pixels in <1ms instead of all 120.000.
 * The BT.601 luminance formula is the same used in detectAlreadyDark
 */
export const IMAGE_BLANK_PAPER_THRESHOLD = 0.75;
export const OCR_OVERLAY_COVERAGE_THRESHOLD = 0.40;
export const OCR_OVERLAY_CHAR_THRESHOLD = 200;

export function isBlankPaper(pixelData, width, height) {
  if (!pixelData || width <= 0 || height <= 0) return false;

  const stride = Math.max(1, Math.floor(Math.sqrt(width * height / 2500)));
  let bright = 0;
  let total = 0;

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const idx = (y * width + x) * 4;
      if (idx + 2 >= pixelData.length) continue;
      const lum = 0.299 * pixelData[idx] + 0.587 * pixelData[idx + 1] + 0.114 * pixelData[idx + 2];
      if (lum > 200) bright++;
      total++;
    }
  }

  if (total === 0) return false;
  return (bright / total) >= IMAGE_BLANK_PAPER_THRESHOLD;
}
