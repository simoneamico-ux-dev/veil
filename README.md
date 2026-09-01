<p align="center">
  <a href="https://veil.simoneamico.com">
    <img src="icon/readme-header.webp" alt="veil, dark mode PDFs without destroying your images" width="840">
  </a>
</p>

<br />

<h3 align="center">Open source PDF reader with smart dark mode.<br>Text inverted, images preserved, scanned documents made selectable.</h3>

<br />

<p align="center">
  <img src="icon/demo.gif" alt="Demo: a medical research PDF toggled from light to dark mode. Text becomes light on dark background while biomedical images retain their original colors." width="840"><br /><br />
  <a href="https://veil.simoneamico.com"><strong>Start reading</strong></a>
</p>

<br />

## Features

- Smart dark mode. Text inverted, images and charts preserved in original colors.
- Per-page override. Force dark or light on any page, respected in export.
- Selectable text layer with clean copy/paste across font styles and weights.
- OCR on images inside native PDFs. Chart labels, axis text, figure captions become selectable. Option/Alt + drag for vertical text (Y-axis labels, rotated annotations).
- Scanned documents detected automatically, full-page OCR runs in the background.
- Already-dark pages (slides, dark themes) detected and left untouched.
- Export to PDF with dark mode baked in, selectable text, working links, and document bookmarks. Text export supports 22 writing systems, covering every major script in use today.
- Link annotations preserved. External URLs and internal navigation both work.
- Document outlines preserved. Nested bookmarks keep their hierarchy, open or closed state, and internal destinations.
- Zoom with native re-rendering via PDF.js. Sharp text at any level, not bitmap stretching.
- Installable PWA with offline support. Runs client-side, no server.

## How it works

veil uses PDF.js to render each page, then applies CSS inversion for the dark background. A second canvas restores the original image pixels over the inverted regions, so photos, charts, and diagrams keep their true colors. Image detection walks the PDF operator list via the public API, no fork required.

Scanned documents are detected by sampling a few pages. Tesseract.js runs OCR in the background, and the recognized text becomes a selectable layer. Language is picked up from your system preferences.

All runtime libraries, fonts, and OCR models are versioned in the repository and served from veil's own origin, so the browser makes no third-party runtime requests. Exact sources, licenses, and attribution are recorded in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

For a deeper look at veil's design decisions, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Development

```
npm install
npm test            # integrity checks + 412 unit tests
npm run test:e2e    # 86 browser tests (Playwright)
npm run serve       # http://localhost:8000
```

498 tests (412 unit + 86 e2e) including visual regression screenshots, export round-trip verification, offline runtime verification, and performance benchmarks.

---

<p align="center">
  <a href="https://veil.simoneamico.com">veil.simoneamico.com</a>
</p>
