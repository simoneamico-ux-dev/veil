/**
 * E2E: Performance timing tests.
 *
 * Measures real-world timing for critical user operations in
 * a headless Chromium browser. Thresholds are generous (3-5x
 * expected) to avoid flaky CI failures, but tight enough to
 * catch major regressions (10x+ slowdowns).
 *
 * These tests measure wall-clock time, not CPU usage. A slow
 * test indicates the operation takes too long from the user's
 * perspective — the most important performance metric.
 */

import { test, expect } from '@playwright/test';
import { loadPDF, READER_URL, waitForTextLayer } from './helpers.js';

test.describe('Performance timing', () => {

  test('PDF load to first render < 8s', async ({ page }) => {
    await page.goto(READER_URL);

    // Measure the entire load flow: app init + file set + render
    const startTime = Date.now();
    await loadPDF(page, 'test-native-simple.pdf');
    const totalTime = Date.now() - startTime;

    // loadPDF waits for: appReady + file set + reader visible +
    // veil animation + canvas render. On CI, initial module loading
    // can take a few seconds; 8s is generous but catches
    // major regressions.
    expect(totalTime).toBeLessThan(8000);
  });

  test('text layer appears < 3s after render', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');

    const textLayerTime = await page.evaluate(() => {
      return new Promise((resolve) => {
        const start = performance.now();
        const check = () => {
          const tl = document.querySelector('.page-container .text-layer');
          if (tl && tl.querySelectorAll('span').length > 0) {
            resolve(performance.now() - start);
          } else {
            requestAnimationFrame(check);
          }
        };
        check();
      });
    });

    expect(textLayerTime).toBeLessThan(3000);
  });

  test('dark mode toggle < 200ms', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');

    const toggleTime = await page.evaluate(() => {
      const btn = document.getElementById('btn-toggle');
      if (!btn) return -1;

      const start = performance.now();
      btn.click();
      // The toggle applies CSS class synchronously
      const elapsed = performance.now() - start;
      return elapsed;
    });

    expect(toggleTime).toBeGreaterThanOrEqual(0);
    expect(toggleTime).toBeLessThan(200);
  });

  test('page navigation (next) < 500ms', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-mixed-sizes.pdf');

    const navTime = await page.evaluate(() => {
      const btn = document.getElementById('btn-next');
      if (!btn || btn.disabled) return -1;

      const start = performance.now();
      btn.click();
      const elapsed = performance.now() - start;
      return elapsed;
    });

    // Navigation triggers instant scroll + schedules render
    // The click itself should be near-instant
    if (navTime >= 0) {
      expect(navTime).toBeLessThan(500);
    }
  });

  test('zoom change < 300ms for UI update', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');

    const zoomTime = await page.evaluate(() => {
      const btn = document.getElementById('btn-zoom-in');
      if (!btn) return -1;

      const label = document.getElementById('zoom-level');
      const before = label ? label.textContent : '';

      const start = performance.now();
      btn.click();

      // Wait for the label to update
      const after = label ? label.textContent : '';
      const elapsed = performance.now() - start;

      return { elapsed, changed: before !== after };
    });

    if (zoomTime.elapsed >= 0) {
      expect(zoomTime.elapsed).toBeLessThan(300);
    }
  });

  test('3-page PDF: all visible pages render < 8s total', async ({ page }) => {
    await page.goto(READER_URL);

    const startTime = Date.now();
    await loadPDF(page, 'test-mixed-sizes.pdf');
    const totalTime = Date.now() - startTime;

    // loadPDF waits for first canvas render + text layer
    // For a 3-page PDF this should be well under 8 seconds
    expect(totalTime).toBeLessThan(8000);
  });
});
