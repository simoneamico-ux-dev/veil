/* Image OCR in Export - SHELVED (2026-03-17)
   * This code made text inside images (charts, figures, screenshots)
   * selectable in the exported dark PDF. It worked correctly and was
   * fully tested, but was removed from the export path because:
   *
   *   1. It added 5-7 minutes to the export of a 218-page PDF
   *      (from <1 min to 6:39). A 6-minute blocking wait with no
   *      interactivity makes the export feel broken.
   *
   *   2. The same feature works beautifully in the web view where
   *      it runs lazily page-by-page as the user scrolls. In the
   *      export it becomes a blocking 6-minute wait.
   *
   *   3. The export without image OCR already covers dark mode
   *      baked in, native text selectable, scanned document OCR,
   *      and links preserved. Image OCR in the web view fills
   *      the gap without the export cost.
   *
   * To restore: paste this block back into exportDarkPdf() after
   * the native text layer loop (after the "Skip characters not
   * encodable" try/catch block), and restore the exportWorker
   * creation with `const needsOcr = isScannedDocument || true;`.
   *
   * The web view image OCR (ocrImageRegions, ocrImageVertical)
   * remains fully active and is the recommended way to access
   * text inside images.
*/

// --- Worker creation (was inside exportDarkPdf, before the page loop) ---
//
// Create a shared eng-only OCR worker for image OCR in export.
// Created once, terminated after the loop - no per-page overhead.
//
// let exportWorker = null;
// const needsOcr = isScannedDocument || true; // always create - native PDFs may have images
// if (needsOcr) {
//   try {
//     exportWorker = await createTesseractWorker('eng');
//   } catch (err) {
//     console.warn('[Export] Failed to create OCR worker:', err);
//   }
// }

// --- Image OCR block (was inside the page loop, after native text layer) ---

/*
        if (exportWorker) {
          const regions = extractImageRegions(opList, renderVp.transform);
          const imgCandidates = regions.filter(
            r => r.width >= OCR_IMAGE_MIN_SIZE && r.height >= OCR_IMAGE_MIN_SIZE
          );

          if (imgCandidates.length > 0) {
            await yieldToUI();
          }

          for (const region of imgCandidates) {
            if (exportCancelled) break;
            const sx2 = Math.max(0, region.x);
            const sy2 = Math.max(0, region.y);
            const sw2 = Math.min(region.width, w - sx2);
            const sh2 = Math.min(region.height, h - sy2);
            if (sw2 <= 0 || sh2 <= 0) continue;

            // Scale factors: render canvas pixels → PDF points
            const imgSx = origVp.width / w;
            const imgSy = origVp.height / h;

            // Extract region from the original (non-inverted) render
            const regionCanvas = document.createElement('canvas');
            regionCanvas.width = sw2;
            regionCanvas.height = sh2;
            regionCanvas.getContext('2d').drawImage(
              renderCanvas, sx2, sy2, sw2, sh2, 0, 0, sw2, sh2
            );

            // --- Pass 1: Horizontal text ---
            const proc0 = preprocessCanvasForOcr(regionCanvas);
            try {
              const blob0 = await new Promise(r => proc0.toBlob(r, 'image/png'));
              proc0.width = 0;
              const { data: data0 } = await exportWorker.recognize(blob0);

              if (data0.words) {
                for (const word of data0.words) {
                  if (!word.text || !word.text.trim()) continue;
                  if (word.confidence < OCR_CONFIDENCE_THRESHOLD) continue;
                  if (isOcrArtifact(word.text)) continue;
                  const wordText = normalizeLigatures(word.text);
                  const fontSize = (word.bbox.y1 - word.bbox.y0) * imgSy * 0.85;
                  if (fontSize < 1) continue;

                  try {
                    const targetW = (word.bbox.x1 - word.bbox.x0) * imgSx;
                    let drawSize = fontSize;
                    if (targetW > 0) {
                      const natW = font.widthOfTextAtSize(wordText, fontSize);
                      if (natW > 0) drawSize = fontSize * (targetW / natW);
                    }
                    outPage.drawText(wordText, {
                      x: (sx2 + word.bbox.x0) * imgSx,
                      y: origVp.height - (sy2 + word.bbox.y1) * imgSy,
                      size: drawSize,
                      font,
                      opacity: 0,
                    });
                  } catch (_) {}
                }
              }
            } catch (_) { proc0.width = 0; }

            // --- Pass 2: Vertical text (90° CW rotation) ---
            const rotated = rotateCanvas90CW(regionCanvas);
            regionCanvas.width = 0;
            const proc90 = preprocessCanvasForOcr(rotated);
            rotated.width = 0;

            try {
              const blob90 = await new Promise(r => proc90.toBlob(r, 'image/png'));
              proc90.width = 0;
              const { data: data90 } = await exportWorker.recognize(blob90);

              if (data90.words) {
                for (const word of data90.words) {
                  if (!word.text || !word.text.trim()) continue;
                  if (word.confidence < OCR_CONFIDENCE_THRESHOLD) continue;
                  if (isOcrArtifact(word.text)) continue;
                  const wordText = normalizeLigatures(word.text);
                  const wordH = word.bbox.y1 - word.bbox.y0;
                  const wordW = word.bbox.x1 - word.bbox.x0;
                  const fontSize = wordH * imgSx * 0.85;
                  if (fontSize < 1) continue;

                  const origX = word.bbox.y0;
                  const origY = sh2 - word.bbox.x1;

                  try {
                    const targetW = wordW * imgSy;
                    let drawSize = fontSize;
                    if (targetW > 0) {
                      const natW = font.widthOfTextAtSize(wordText, fontSize);
                      if (natW > 0) drawSize = fontSize * (targetW / natW);
                    }
                    outPage.drawText(wordText, {
                      x: (sx2 + origX) * imgSx,
                      y: origVp.height - (sy2 + origY + wordH) * imgSy,
                      size: drawSize,
                      font,
                      opacity: 0,
                    });
                  } catch (_) {}
                }
              }
            } catch (_) { proc90.width = 0; }
          }
        }
*/
