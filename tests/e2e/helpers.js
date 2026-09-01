/**
 * Shared helpers for Playwright e2e tests.
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

// The reader app lives at /reader.html (landing page is at /)
export const READER_URL = '/reader.html';

/**
 * Load a PDF fixture into the app by setting the file input.
 * Waits for the reader to become visible and the first page to render.
 */
export async function loadPDF(page, filename) {
  const filePath = join(FIXTURES_DIR, filename);

  // Wait for app module to fully initialize (the local PDF.js import must complete
  // before the change event listener is registered at the bottom of app.js)
  await page.waitForFunction(
    () => document.documentElement.dataset.appReady === 'true',
    { timeout: 30000 }
  );

  // The file input is hidden; Playwright can still set files on it
  const fileInput = page.locator('#file-input');
  await fileInput.setInputFiles(filePath);

  // Wait for the reader to become visible
  await page.locator('#reader').waitFor({ state: 'visible', timeout: 30000 });

  // Wait for the drop zone veil animation to finish and become hidden
  await page.waitForFunction(() => {
    const dz = document.getElementById('drop-zone');
    return dz && dz.hidden;
  }, { timeout: 30000 });

  // Ensure toolbar is visible (not hidden by focus mode timer).
  // Move mouse to the top to trigger toolbar reveal, then wait
  // for the toolbar to actually become visible (not a fixed timeout).
  await page.mouse.move(640, 20);
  await page.waitForFunction(() => {
    const toolbar = document.getElementById('toolbar');
    if (!toolbar) return false;
    return !toolbar.classList.contains('toolbar-hidden');
  }, { timeout: 5000 });
  // Keep mouse over toolbar so it stays visible
  await page.mouse.move(640, 30);

  // Wait for the first page container to have a rendered canvas
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.page-container .page-canvas');
    return canvas && canvas.width > 0 && canvas.height > 0;
  }, { timeout: 30000 });
}

/**
 * Wait for text layer to be populated on a given page.
 */
export async function waitForTextLayer(page, pageNum = 1) {
  await page.waitForFunction((pNum) => {
    const container = document.querySelector(`.page-container[data-page-num="${pNum}"] .text-layer`);
    return container && container.querySelectorAll('span').length > 0;
  }, pageNum, { timeout: 15000 });
}

/**
 * Wait for OCR text layer to be populated (takes longer than native).
 */
export async function waitForOcrTextLayer(page, pageNum = 1) {
  await page.waitForFunction((pNum) => {
    const container = document.querySelector(`.page-container[data-page-num="${pNum}"] .text-layer`);
    return container && container.querySelectorAll('span').length > 0;
  }, pageNum, { timeout: 120000 }); // OCR + render queue can be slow on real PDFs
}
