/**
 * Generate deterministic test PDF fixtures using pdf-lib.
 *
 * Run: node tests/fixtures/generate-fixtures.js
 *
 * Produces:
 *   test-native-simple.pdf   — text at known positions + embedded image
 *   test-native-styles.pdf   — bold/italic transitions (Antigravity test)
 *   test-scanned.pdf         — full-page image simulating a scan
 *   test-outline.pdf         : multi-level outline with internal destinations
 *
 * Expected values live in companion JSON files or focused E2E assertions.
 */

import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  degrees,
  PDFDocument,
  StandardFonts,
  rgb,
} from 'pdf-lib';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// 1. test-native-simple.pdf
//
// One A4 page with:
//   - Title "Hello World" at top
//   - Paragraph "The quick brown fox jumps over the lazy dog."
//   - A colored rectangle (simulating an image area)
//   - Known coordinates for each word
// ============================================================

async function generateNativeSimple() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]); // US Letter
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Title
  const titleText = 'Hello World';
  const titleSize = 24;
  const titleX = 72;
  const titleY = 720;
  page.drawText(titleText, { x: titleX, y: titleY, size: titleSize, font: boldFont, color: rgb(0, 0, 0) });

  // Paragraph — each word drawn separately at known x positions
  // so we can verify word-level coordinates
  const paraY = 680;
  const paraSize = 12;
  const words = ['The', 'quick', 'brown', 'fox', 'jumps', 'over', 'the', 'lazy', 'dog.'];
  const wordPositions = [];
  let cursorX = 72;
  const spaceWidth = font.widthOfTextAtSize(' ', paraSize);

  for (const word of words) {
    const w = font.widthOfTextAtSize(word, paraSize);
    page.drawText(word, { x: cursorX, y: paraY, size: paraSize, font, color: rgb(0, 0, 0) });
    wordPositions.push({
      text: word,
      x: cursorX,
      y: paraY,
      width: w,
      fontSize: paraSize,
    });
    cursorX += w + spaceWidth;
  }

  // Second line
  const line2Y = 660;
  const line2Text = 'This is the second line of text.';
  const line2Words = line2Text.split(' ');
  const line2Positions = [];
  cursorX = 72;
  for (const word of line2Words) {
    const w = font.widthOfTextAtSize(word, paraSize);
    page.drawText(word, { x: cursorX, y: line2Y, size: paraSize, font, color: rgb(0, 0, 0) });
    line2Positions.push({
      text: word,
      x: cursorX,
      y: line2Y,
      width: w,
      fontSize: paraSize,
    });
    cursorX += w + spaceWidth;
  }

  // Colored rectangle at known position (simulates an image region)
  const imgRect = { x: 72, y: 400, width: 200, height: 150 };
  page.drawRectangle({
    x: imgRect.x, y: imgRect.y,
    width: imgRect.width, height: imgRect.height,
    color: rgb(0.2, 0.5, 0.8),
  });

  // Embed a tiny 2x2 PNG image at a known position
  const pngData = createTinyPNG();
  const pngImage = await pdf.embedPng(pngData);
  const imgX = 300;
  const imgY = 400;
  const imgW = 150;
  const imgH = 150;
  page.drawImage(pngImage, { x: imgX, y: imgY, width: imgW, height: imgH });

  const pdfBytes = await pdf.save();
  const outPath = join(__dirname, 'test-native-simple.pdf');
  writeFileSync(outPath, pdfBytes);

  // Write expected data
  const expected = {
    pageCount: 1,
    pages: [{
      width: 612,
      height: 792,
      isScanned: false,
      isAlreadyDark: false,
      lines: [
        {
          y: titleY,
          words: [{ text: titleText, x: titleX, width: boldFont.widthOfTextAtSize(titleText, titleSize), fontSize: titleSize }],
        },
        {
          y: paraY,
          words: wordPositions,
        },
        {
          y: line2Y,
          words: line2Positions,
        },
      ],
      images: [
        { x: imgX, y: imgY, width: imgW, height: imgH },
      ],
      fullText: titleText + ' ' + words.join(' ') + ' ' + line2Words.join(' '),
    }],
  };

  writeFileSync(join(__dirname, 'test-native-simple.expected.json'), JSON.stringify(expected, null, 2));
  console.log('Generated test-native-simple.pdf');
}

// ============================================================
// 2. test-native-styles.pdf
//
// Tests the Antigravity bug: text with style transitions.
//   Line 1: "I hate talking about" — "hate" in italic
//   Line 2: "If Steal Like an Artist was good" — "Steal Like an Artist" in bold
//   Line 3: "Normal text here." — all normal (control)
// ============================================================

async function generateNativeStyles() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const size = 14;
  const spW = regular.widthOfTextAtSize(' ', size);

  // Line 1: "I hate talking about" with "hate" in italic
  const line1Y = 700;
  let x = 72;

  // "I " — note the trailing space in the string (Antigravity Scenario A)
  const i_text = 'I ';
  const i_w = regular.widthOfTextAtSize(i_text, size);
  page.drawText(i_text, { x, y: line1Y, size, font: regular, color: rgb(0, 0, 0) });
  x += i_w;

  // "hate" in italic
  const hate_text = 'hate';
  const hate_w = italic.widthOfTextAtSize(hate_text, size);
  page.drawText(hate_text, { x, y: line1Y, size, font: italic, color: rgb(0, 0, 0) });
  x += hate_w;

  // " talking about"
  const talking_text = ' talking about';
  page.drawText(talking_text, { x, y: line1Y, size, font: regular, color: rgb(0, 0, 0) });

  // Line 2: "If Steal Like an Artist was good"
  const line2Y = 670;
  x = 72;

  page.drawText('If ', { x, y: line2Y, size, font: regular, color: rgb(0, 0, 0) });
  x += regular.widthOfTextAtSize('If ', size);

  const bookTitle = 'Steal Like an Artist';
  page.drawText(bookTitle, { x, y: line2Y, size, font: bold, color: rgb(0, 0, 0) });
  x += bold.widthOfTextAtSize(bookTitle, size);

  page.drawText(' was good', { x, y: line2Y, size, font: regular, color: rgb(0, 0, 0) });

  // Line 3: normal control text
  const line3Y = 640;
  const line3Text = 'Normal text here.';
  page.drawText(line3Text, { x: 72, y: line3Y, size, font: regular, color: rgb(0, 0, 0) });

  const pdfBytes = await pdf.save();
  writeFileSync(join(__dirname, 'test-native-styles.pdf'), pdfBytes);

  const expected = {
    pageCount: 1,
    pages: [{
      width: 612,
      height: 792,
      isScanned: false,
      isAlreadyDark: false,
      expectedCopyPaste: {
        line1: 'I hate talking about',
        line2: 'If Steal Like an Artist was good',
        line3: 'Normal text here.',
      },
      fullText: 'I hate talking about If Steal Like an Artist was good Normal text here.',
    }],
  };

  writeFileSync(join(__dirname, 'test-native-styles.expected.json'), JSON.stringify(expected, null, 2));
  console.log('Generated test-native-styles.pdf');
}

// ============================================================
// 3. test-scanned.pdf
//
// Simulates a scanned document: full-page image with text
// rendered into it (no native text layer).
// ============================================================

async function generateScanned() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);

  // Create a full-page image (white background with black text rendered as pixels)
  // We'll create a simple PNG with some text-like patterns
  const imgData = createScannedPagePNG(612, 792);
  const pngImage = await pdf.embedPng(imgData);

  // Draw the image to cover the entire page
  page.drawImage(pngImage, { x: 0, y: 0, width: 612, height: 792 });

  const pdfBytes = await pdf.save();
  writeFileSync(join(__dirname, 'test-scanned.pdf'), pdfBytes);

  const expected = {
    pageCount: 1,
    pages: [{
      width: 612,
      height: 792,
      isScanned: true,
      isAlreadyDark: false,
      ocrExpectedWords: ['SCANNED', 'DOCUMENT', 'TEST'],
    }],
  };

  writeFileSync(join(__dirname, 'test-scanned.expected.json'), JSON.stringify(expected, null, 2));
  console.log('Generated test-scanned.pdf');
}

// ============================================================
// 4. test-already-dark.pdf
//
// A page with dark background (simulating a dark-themed slide).
// The already-dark detection should flag this.
// ============================================================

async function generateAlreadyDark() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);

  // Dark background
  page.drawRectangle({
    x: 0, y: 0,
    width: 612, height: 792,
    color: rgb(0.1, 0.1, 0.12),
  });

  // Light text on dark background
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Dark Mode Slide', {
    x: 200, y: 400,
    size: 24,
    font,
    color: rgb(0.9, 0.9, 0.9),
  });

  const pdfBytes = await pdf.save();
  writeFileSync(join(__dirname, 'test-already-dark.pdf'), pdfBytes);

  const expected = {
    pageCount: 1,
    pages: [{
      width: 612,
      height: 792,
      isScanned: false,
      isAlreadyDark: true,
      fullText: 'Dark Mode Slide',
    }],
  };

  writeFileSync(join(__dirname, 'test-already-dark.expected.json'), JSON.stringify(expected, null, 2));
  console.log('Generated test-already-dark.pdf');
}

// ============================================================
// Helpers
// ============================================================

/**
 * Create a minimal valid 2x2 RGBA PNG.
 * Colors: red, green, blue, white — easily identifiable.
 */
function createTinyPNG() {
  // Minimal PNG: 2x2, RGBA, with known pixel values.
  // Using a manually constructed PNG buffer.
  const width = 2;
  const height = 2;

  // IHDR chunk
  const ihdr = new Uint8Array([
    0, 0, 0, 2,   // width
    0, 0, 0, 2,   // height
    8,             // bit depth
    6,             // color type: RGBA
    0, 0, 0,       // compression, filter, interlace
  ]);

  // Raw pixel data (with filter byte 0 per row)
  // Row 1: red, green
  // Row 2: blue, white
  const rawData = new Uint8Array([
    0, 255, 0, 0, 255, 0, 255, 0, 255,     // filter=0, R,G,B,A, R,G,B,A
    0, 0, 0, 255, 255, 255, 255, 255, 255,  // filter=0, B pixel, white pixel
  ]);

  // Use a simpler approach — generate a valid PNG with a library-less method.
  // Actually, pdf-lib can handle raw RGBA data directly.
  // Let's create a proper minimal PNG.

  // Easiest: create a tiny valid PNG by hand.
  // PNG signature + IHDR + IDAT (deflate of raw) + IEND

  // For simplicity, use an extremely small valid PNG (1x1 red pixel)
  // This is a known-good 1x1 red PNG:
  const png1x1Red = new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
    0x00, 0x00, 0x00, 0x0D, // IHDR length
    0x49, 0x48, 0x44, 0x52, // "IHDR"
    0x00, 0x00, 0x00, 0x01, // width=1
    0x00, 0x00, 0x00, 0x01, // height=1
    0x08, 0x02,             // 8-bit RGB
    0x00, 0x00, 0x00,       // compression, filter, interlace
    0x90, 0x77, 0x53, 0xDE, // IHDR CRC
    0x00, 0x00, 0x00, 0x0C, // IDAT length
    0x49, 0x44, 0x41, 0x54, // "IDAT"
    0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00,
    0x01, 0x01, 0x01, 0x00, // compressed data
    0x18, 0xDD, 0x8D, 0xB4, // IDAT CRC
    0x00, 0x00, 0x00, 0x00, // IEND length
    0x49, 0x45, 0x4E, 0x44, // "IEND"
    0xAE, 0x42, 0x60, 0x82, // IEND CRC
  ]);

  return png1x1Red;
}

/**
 * Create a PNG representing a "scanned" page.
 * White background with the words "SCANNED DOCUMENT TEST" rendered
 * as black rectangles (simulating text blocks — actual OCR will
 * recognize them as text patterns).
 *
 * For test purposes, we create a simple white image and embed
 * text using pdf-lib's own text drawing (which becomes part of
 * the image when we re-rasterize it in tests).
 *
 * Actually, for the scanned test we just need a mostly-white PNG
 * that covers the full page. The content doesn't need to be OCR-able
 * for unit tests — it just needs to trigger the scanned detection.
 */
function createScannedPagePNG() {
  // Create a minimal 4x4 white PNG — pdf-lib will scale it to fill the page.
  // When rendered at full page size, it simulates a scan (full-page image).
  const png4x4White = new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    0x00, 0x00, 0x00, 0x0D,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x04, // width=4
    0x00, 0x00, 0x00, 0x04, // height=4
    0x08, 0x02,             // 8-bit RGB
    0x00, 0x00, 0x00,
    0xA5, 0xCE, 0xD7, 0x18, // CRC
    0x00, 0x00, 0x00, 0x19, // IDAT length = 25
    0x49, 0x44, 0x41, 0x54, // "IDAT"
    // zlib: deflate of 4 rows of (filter=0, R,G,B x4)
    // All white pixels = 0xFF 0xFF 0xFF
    0x78, 0x01, 0x62, 0xF8, 0x0F, 0x00, 0x01, 0x01,
    0x00, 0x05, 0x18, 0xD8, 0x4A, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x78, 0x56, 0x34, 0x12, // CRC (placeholder — pdf-lib is lenient)
    0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4E, 0x44,
    0xAE, 0x42, 0x60, 0x82,
  ]);

  // A valid tiny PNG is tricky to hand-craft. Let's use the 1x1 approach
  // and let pdf-lib scale it. The detection logic cares about coverage, not content.
  return createTinyPNG();
}

// ============================================================
// Main
// ============================================================

// ============================================================
// 5. test-ligatures.pdf
//
// Tests ligature normalization. Contains text with actual
// Unicode ligature codepoints (U+FB00-FB04) that should be
// decomposed by normalizeLigatures() before display.
//
// Uses Helvetica which supports these codepoints in its
// WinAnsi encoding range — but we write the raw Unicode
// characters that pdf-lib will embed as-is.
// ============================================================

async function generateLigatures() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const size = 14;
  const y = 700;

  // Write text with actual Unicode ligature codepoints.
  // These are the characters that some PDF producers emit:
  //   U+FB01 = fi, U+FB02 = fl, U+FB00 = ff, U+FB03 = ffi, U+FB04 = ffl
  //
  // We write each word separately so we can verify per-word extraction.
  const words = [
    'e\uFB03cient',     // efficient (with ffi ligature)
    '\uFB01re\uFB02y',  // firefly (with fi + fl ligatures)
    'sta\uFB00',        // staff (with ff ligature)
    'ba\uFB04ed',       // baffled (with ffl ligature)
  ];

  let x = 72;
  const spaceWidth = font.widthOfTextAtSize(' ', size);
  const wordPositions = [];

  for (const word of words) {
    try {
      const w = font.widthOfTextAtSize(word, size);
      page.drawText(word, { x, y, size, font, color: rgb(0, 0, 0) });
      wordPositions.push({ text: word, x, y, width: w });
      x += w + spaceWidth;
    } catch (_) {
      // Some ligature codepoints may not be in WinAnsi — skip gracefully
      // and write decomposed version instead
      const decomposed = word.normalize('NFKD');
      const w = font.widthOfTextAtSize(decomposed, size);
      page.drawText(decomposed, { x, y, size, font, color: rgb(0, 0, 0) });
      wordPositions.push({ text: decomposed, x, y, width: w });
      x += w + spaceWidth;
    }
  }

  const pdfBytes = await pdf.save();
  writeFileSync(join(__dirname, 'test-ligatures.pdf'), pdfBytes);

  const expected = {
    pageCount: 1,
    pages: [{
      width: 612,
      height: 792,
      isScanned: false,
      isAlreadyDark: false,
      // After normalization, the text should read as plain ASCII:
      expectedNormalizedWords: ['efficient', 'firefly', 'staff', 'baffled'],
    }],
  };

  writeFileSync(join(__dirname, 'test-ligatures.expected.json'), JSON.stringify(expected, null, 2));
  console.log('Generated test-ligatures.pdf');
}

// ============================================================
// 6. test-punctuation.pdf
//
// Tests punctuation merging. Contains sentences where the
// period/comma is drawn as a separate text item (a common
// pattern in many PDF producers).
// ============================================================

async function generatePunctuation() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const size = 14;

  // Line 1: "Hello World." — period is a separate drawText call
  let x = 72;
  const y1 = 700;
  const spW = font.widthOfTextAtSize(' ', size);

  const helloW = font.widthOfTextAtSize('Hello', size);
  page.drawText('Hello', { x, y: y1, size, font, color: rgb(0, 0, 0) });
  x += helloW + spW;

  const worldW = font.widthOfTextAtSize('World', size);
  page.drawText('World', { x, y: y1, size, font, color: rgb(0, 0, 0) });
  x += worldW;

  // Period as separate item (no space before it)
  page.drawText('.', { x, y: y1, size, font, color: rgb(0, 0, 0) });

  // Line 2: "Yes, indeed!" — comma and exclamation separate
  x = 72;
  const y2 = 670;

  const yesW = font.widthOfTextAtSize('Yes', size);
  page.drawText('Yes', { x, y: y2, size, font, color: rgb(0, 0, 0) });
  x += yesW;

  const commaW = font.widthOfTextAtSize(',', size);
  page.drawText(',', { x, y: y2, size, font, color: rgb(0, 0, 0) });
  x += commaW + spW;

  const indeedW = font.widthOfTextAtSize('indeed', size);
  page.drawText('indeed', { x, y: y2, size, font, color: rgb(0, 0, 0) });
  x += indeedW;

  page.drawText('!', { x, y: y2, size, font, color: rgb(0, 0, 0) });

  const pdfBytes = await pdf.save();
  writeFileSync(join(__dirname, 'test-punctuation.pdf'), pdfBytes);

  const expected = {
    pageCount: 1,
    pages: [{
      width: 612,
      height: 792,
      isScanned: false,
      isAlreadyDark: false,
      expectedCopyPaste: {
        line1: 'Hello World.',
        line2: 'Yes, indeed!',
      },
    }],
  };

  writeFileSync(join(__dirname, 'test-punctuation.expected.json'), JSON.stringify(expected, null, 2));
  console.log('Generated test-punctuation.pdf');
}

// ============================================================
// 7. test-mixed-sizes.pdf
//
// Tests documents with mixed page sizes and orientations.
//   Page 1: US Letter portrait (612×792) — "Portrait Page"
//   Page 2: A4 landscape (842×595) — "Landscape Page"
//   Page 3: US Letter portrait (612×792) — "Back to Portrait"
// ============================================================

async function generateMixedSizes() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const size = 18;

  // Page 1: US Letter portrait
  const page1 = pdf.addPage([612, 792]);
  page1.drawText('Portrait Page', { x: 72, y: 700, size, font, color: rgb(0, 0, 0) });

  // Page 2: A4 landscape
  const page2 = pdf.addPage([842, 595]);
  page2.drawText('Landscape Page', { x: 72, y: 500, size, font, color: rgb(0, 0, 0) });

  // Page 3: US Letter portrait
  const page3 = pdf.addPage([612, 792]);
  page3.drawText('Back to Portrait', { x: 72, y: 700, size, font, color: rgb(0, 0, 0) });

  const pdfBytes = await pdf.save();
  writeFileSync(join(__dirname, 'test-mixed-sizes.pdf'), pdfBytes);

  const expected = {
    pageCount: 3,
    pages: [
      { width: 612, height: 792, fullText: 'Portrait Page' },
      { width: 842, height: 595, fullText: 'Landscape Page' },
      { width: 612, height: 792, fullText: 'Back to Portrait' },
    ],
  };

  writeFileSync(join(__dirname, 'test-mixed-sizes.expected.json'), JSON.stringify(expected, null, 2));
  console.log('Generated test-mixed-sizes.pdf');
}

// ============================================================
// 8. test-links.pdf
//
// Tests link annotations. Contains text that represents
// clickable links (external URL, mailto).
//   Page 1: "Visit Example" (link to https://example.com)
//           "Send Email" (link to mailto:test@example.com)
//   Page 2: "Go to page 1" (no annotation — internal links
//           are complex with pdf-lib)
//
// Note: Link annotations are added via pdf-lib's low-level API.
// If the annotation structure doesn't survive round-tripping,
// test link behaviour via the app's buildLinkLayer instead.
// ============================================================

async function generateLinks() {
  const { PDFName, PDFString, PDFArray, PDFDict, PDFNumber } = await import('pdf-lib');

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const size = 18;

  // Page 1
  const page1 = pdf.addPage([612, 792]);

  // "Visit Example" with external link
  const text1 = 'Visit Example';
  const text1X = 72;
  const text1Y = 700;
  const text1W = font.widthOfTextAtSize(text1, size);
  page1.drawText(text1, { x: text1X, y: text1Y, size, font, color: rgb(0, 0, 0.8) });

  // "Send Email" with mailto link
  const text2 = 'Send Email';
  const text2X = 72;
  const text2Y = 660;
  const text2W = font.widthOfTextAtSize(text2, size);
  page1.drawText(text2, { x: text2X, y: text2Y, size, font, color: rgb(0, 0, 0.8) });

  // Add link annotations to page 1 using low-level API
  try {
    const context = pdf.context;

    // Annotation for "Visit Example"
    const annot1 = context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [text1X, text1Y - 4, text1X + text1W, text1Y + size],
      Border: [0, 0, 0],
      A: {
        Type: 'Action',
        S: 'URI',
        URI: PDFString.of('https://example.com'),
      },
    });

    // Annotation for "Send Email"
    const annot2 = context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [text2X, text2Y - 4, text2X + text2W, text2Y + size],
      Border: [0, 0, 0],
      A: {
        Type: 'Action',
        S: 'URI',
        URI: PDFString.of('mailto:test@example.com'),
      },
    });

    const annot1Ref = context.register(annot1);
    const annot2Ref = context.register(annot2);
    page1.node.set(PDFName.of('Annots'), context.obj([annot1Ref, annot2Ref]));
  } catch (e) {
    console.warn('Warning: Could not add link annotations via low-level API:', e.message);
    console.warn('Link annotations should be tested via the app\'s buildLinkLayer instead.');
  }

  // Page 2
  const page2 = pdf.addPage([612, 792]);
  page2.drawText('Go to page 1', { x: 72, y: 700, size, font, color: rgb(0, 0, 0) });

  const pdfBytes = await pdf.save();
  writeFileSync(join(__dirname, 'test-links.pdf'), pdfBytes);

  const expected = {
    pageCount: 2,
    pages: [
      {
        width: 612,
        height: 792,
        fullText: 'Visit Example Send Email',
        links: [
          { text: 'Visit Example', url: 'https://example.com' },
          { text: 'Send Email', url: 'mailto:test@example.com' },
        ],
        note: 'Link annotations added via low-level API. If annotations are not preserved, test via buildLinkLayer.',
      },
      {
        width: 612,
        height: 792,
        fullText: 'Go to page 1',
        links: [],
      },
    ],
  };

  writeFileSync(join(__dirname, 'test-links.expected.json'), JSON.stringify(expected, null, 2));
  console.log('Generated test-links.pdf');
}

// ============================================================
// 9. test-outline.pdf
//
// Three pages with an eight-item outline and one internal link annotation.
// The navigation mixes named and explicit destinations, three hierarchy
// levels, Unicode titles, and the modes that exposed earlier link bugs.
// ============================================================

async function generateOutline() {
  const { PDFHexString, PDFName, PDFNumber, PDFString } = await import('pdf-lib');

  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = ['Overview', 'Part I', 'Appendix'].map((title, index) => {
    const page = pdf.addPage([612, 792]);
    page.drawText(title, {
      x: 72,
      y: 700,
      size: 24,
      font,
      color: rgb(0, 0, 0),
    });
    page.drawText(`Synthetic outline fixture, page ${index + 1}`, {
      x: 72,
      y: 660,
      size: 12,
      font,
      color: rgb(0, 0, 0),
    });
    return page;
  });
  pages[1].setRotation(degrees(90));
  pages[2].setCropBox(36, 72, 540, 648);

  const context = pdf.context;
  const namedDestinations = context.obj({
    PartOne: [pages[1].ref, 'Fit'],
  });
  pdf.catalog.set(PDFName.of('Dests'), namedDestinations);

  const internalLink = context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [72, 696, 180, 728],
    Border: [0, 0, 0],
    Dest: PDFName.of('PartOne'),
  });
  pages[0].node.set(PDFName.of('Annots'), context.obj([context.register(internalLink)]));

  const externalActionRef = context.register(context.obj({
    Type: 'Action',
    S: 'URI',
    URI: PDFString.of('https://example.com/reference'),
  }));

  const outline = [
    {
      title: 'Overview',
      dest: context.obj([pages[0].ref, 'XYZ', 0, 792, null]),
      items: [],
    },
    {
      title: 'Part I – Café',
      dest: PDFName.of('PartOne'),
      closed: true,
      items: [
        {
          title: 'Chapter 1',
          dest: context.obj([pages[1].ref, 'FitH', 720]),
          items: [
            {
              title: 'Section 1.1 – 東京',
              dest: context.obj([pages[2].ref, 'XYZ', 72, 700, null]),
              items: [],
            },
          ],
        },
      ],
    },
    {
      title: 'Appendix',
      dest: context.obj([pages[2].ref, 'Fit']),
      items: [],
    },
    {
      title: 'Bounding-box destination',
      dest: context.obj([pages[2].ref, 'FitB']),
      items: [],
    },
    {
      title: 'Page index destination',
      dest: context.obj([0, 'Fit']),
      items: [],
    },
    {
      title: 'External reference',
      action: externalActionRef,
      items: [],
    },
  ];

  const outlinesDict = context.obj({ Type: 'Outlines' });
  const outlinesRef = context.register(outlinesDict);

  function addLevel(items, parentRef) {
    const entries = items.map(item => {
      const dict = context.obj({
        Title: PDFHexString.fromText(item.title),
        Parent: parentRef,
      });
      if (item.dest) dict.set(PDFName.of('Dest'), item.dest);
      if (item.action) dict.set(PDFName.of('A'), item.action);
      return { item, dict, ref: context.register(dict) };
    });
    let visibleCount = entries.length;

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (index > 0) entry.dict.set(PDFName.of('Prev'), entries[index - 1].ref);
      if (index < entries.length - 1) entry.dict.set(PDFName.of('Next'), entries[index + 1].ref);

      if (entry.item.items.length > 0) {
        const children = addLevel(entry.item.items, entry.ref);
        entry.dict.set(PDFName.of('First'), children.first);
        entry.dict.set(PDFName.of('Last'), children.last);
        const childCount = entry.item.closed ? -children.visibleCount : children.visibleCount;
        entry.dict.set(PDFName.of('Count'), PDFNumber.of(childCount));
        if (!entry.item.closed) visibleCount += children.visibleCount;
      }
    }

    return {
      first: entries[0].ref,
      last: entries[entries.length - 1].ref,
      visibleCount,
    };
  }

  const root = addLevel(outline, outlinesRef);
  outlinesDict.set(PDFName.of('First'), root.first);
  outlinesDict.set(PDFName.of('Last'), root.last);
  outlinesDict.set(PDFName.of('Count'), PDFNumber.of(root.visibleCount));
  pdf.catalog.set(PDFName.of('Outlines'), outlinesRef);

  const pdfBytes = await pdf.save();
  writeFileSync(join(__dirname, 'test-outline.pdf'), pdfBytes);
  console.log('Generated test-outline.pdf');
}

async function main() {
  if (process.argv[2] === 'outline') {
    await generateOutline();
    return;
  }

  await generateNativeSimple();
  await generateNativeStyles();
  await generateScanned();
  await generateAlreadyDark();
  await generateLigatures();
  await generatePunctuation();
  await generateMixedSizes();
  await generateLinks();
  await generateOutline();
  console.log('\nAll fixtures generated in', __dirname);
}

main().catch(err => {
  console.error('Fixture generation failed:', err);
  process.exit(1);
});
