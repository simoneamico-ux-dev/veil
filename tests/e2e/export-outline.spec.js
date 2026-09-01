/*
 * E2E: Export document outline tests.
 *
 * Verifies that the exported PDF keeps bookmark titles, hierarchy,
 * open or closed state, and internal destinations while PDFs without
 * an outline stay valid.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadPDF, READER_URL, FIXTURES_DIR } from './helpers.js';

const PDF_LIB_URL = '/vendor/pdf-lib/1.17.1/pdf-lib.esm.min.js';

async function exportAndGetBytes(page) {
  const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
  await page.locator('#btn-export').click({ force: true });
  const download = await downloadPromise;
  return readFileSync(await download.path());
}

async function extractOutline(page, pdfBytes) {
  const base64 = pdfBytes.toString('base64');

  return page.evaluate(async (b64) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }

    const doc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
    const outline = await doc.getOutline();

    async function normalizeItems(items) {
      const normalized = [];

      for (const item of items || []) {
        let explicitDest = item.dest;
        if (typeof explicitDest === 'string') {
          explicitDest = await doc.getDestination(explicitDest);
        }

        let destination = null;
        if (Array.isArray(explicitDest) && explicitDest.length > 0) {
          const target = explicitDest[0];
          const pageIndex = Number.isInteger(target)
            ? target
            : await doc.getPageIndex(target);
          const parameters = explicitDest.slice(1).map(value => {
            if (value && typeof value === 'object' && value.name) {
              return value.name;
            }
            return value;
          });
          destination = [pageIndex, ...parameters];
        }

        normalized.push({
          title: item.title,
          count: Number.isInteger(item.count) ? item.count : null,
          url: item.url || null,
          destination,
          items: await normalizeItems(item.items),
        });
      }

      return normalized;
    }

    const normalized = await normalizeItems(outline);
    await doc.destroy();
    return normalized;
  }, base64);
}

async function extractInternalLinks(page, pdfBytes) {
  const base64 = pdfBytes.toString('base64');

  return page.evaluate(async (b64) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }

    const doc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
    const links = [];

    for (let sourcePage = 0; sourcePage < doc.numPages; sourcePage++) {
      const pdfPage = await doc.getPage(sourcePage + 1);
      const annotations = await pdfPage.getAnnotations();

      for (const annotation of annotations) {
        if (annotation.subtype !== 'Link' || !annotation.dest) continue;

        let explicitDest = annotation.dest;
        if (typeof explicitDest === 'string') {
          explicitDest = await doc.getDestination(explicitDest);
        }
        if (!Array.isArray(explicitDest) || explicitDest.length === 0) continue;

        const target = explicitDest[0];
        const targetPage = Number.isInteger(target)
          ? target
          : await doc.getPageIndex(target);
        const parameters = explicitDest.slice(1).map(value => {
          if (value && typeof value === 'object' && value.name) return value.name;
          return value;
        });
        links.push({ sourcePage, destination: [targetPage, ...parameters] });
      }
    }

    await doc.destroy();
    return links;
  }, base64);
}

test.describe('Export document outline', () => {
  test('preserves titles, hierarchy, state, and internal destinations', async ({ page }) => {
    const originalBytes = readFileSync(join(FIXTURES_DIR, 'test-outline.pdf'));

    await page.goto(READER_URL);
    await loadPDF(page, 'test-outline.pdf');

    const originalOutline = await extractOutline(page, originalBytes);
    expect(originalOutline).toEqual([
      {
        title: 'Overview',
        count: null,
        url: null,
        destination: [0, 'XYZ', 0, 792, null],
        items: [],
      },
      {
        title: 'Part I – Café',
        count: -2,
        url: null,
        destination: [1, 'Fit'],
        items: [
          {
            title: 'Chapter 1',
            count: 1,
            url: null,
            destination: [1, 'FitH', 720],
            items: [
              {
                title: 'Section 1.1 – 東京',
                count: null,
                url: null,
                destination: [2, 'XYZ', 72, 700, null],
                items: [],
              },
            ],
          },
        ],
      },
      {
        title: 'Appendix',
        count: null,
        url: null,
        destination: [2, 'Fit'],
        items: [],
      },
      {
        title: 'Bounding-box destination',
        count: null,
        url: null,
        destination: [2, 'FitB'],
        items: [],
      },
      {
        title: 'Page index destination',
        count: null,
        url: null,
        destination: [0, 'Fit'],
        items: [],
      },
      {
        title: 'External reference',
        count: null,
        url: 'https://example.com/reference',
        destination: null,
        items: [],
      },
    ]);
    const originalLinks = await extractInternalLinks(page, originalBytes);
    expect(originalLinks).toEqual([
      { sourcePage: 0, destination: [1, 'Fit'] },
    ]);

    const exportedBytes = await exportAndGetBytes(page);
    const exportedOutline = await extractOutline(page, exportedBytes);
    const expectedExportedOutline = structuredClone(originalOutline);
    expectedExportedOutline[1].items[0].destination = [1, 'Fit'];
    expectedExportedOutline[1].items[0].items[0].destination = [2, 'XYZ', 36, 628, null];
    expectedExportedOutline[3].destination = [2, 'Fit'];
    expectedExportedOutline[5].url = null;
    expect(exportedOutline).toEqual(expectedExportedOutline);
    expect(await extractInternalLinks(page, exportedBytes)).toEqual(originalLinks);
  });

  test('a canceled final save cannot clobber its replacement export', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'arabic.pdf');

    await page.evaluate(async (pdfLibUrl) => {
      const { PDFDocument } = await import(pdfLibUrl);
      const { exportDarkPdf } = await import('/export.js');
      const originalSave = PDFDocument.prototype.save;

      window.__outlineSaveControl = {
        finished: [],
        originalSave,
        PDFDocument,
        releases: [],
        starts: 0,
      };
      window.__trackedExports = [];
      window.__startTrackedExport = () => {
        window.__trackedExports.push(exportDarkPdf());
      };
      PDFDocument.prototype.save = async function(...args) {
        const callIndex = window.__outlineSaveControl.starts++;
        await new Promise(resolve => {
          window.__outlineSaveControl.releases[callIndex] = resolve;
        });
        const bytes = await originalSave.apply(this, args);
        window.__outlineSaveControl.finished[callIndex] = true;
        return bytes;
      };
      window.__startTrackedExport();
    }, PDF_LIB_URL);

    let downloadCount = 0;
    page.on('download', () => downloadCount++);

    await page.waitForFunction(() => window.__outlineSaveControl?.starts === 1, null, { timeout: 120000 });
    await page.locator('#export-cancel').click({ force: true });

    await page.evaluate(() => window.__startTrackedExport());
    await page.waitForFunction(() => window.__outlineSaveControl?.starts === 2, null, { timeout: 120000 });
    await page.evaluate(() => window.__outlineSaveControl.releases[0]());
    await page.evaluate(() => window.__trackedExports[0]);

    expect(downloadCount).toBe(0);
    await expect(page.locator('#btn-export')).toBeDisabled();

    const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
    await page.evaluate(() => window.__outlineSaveControl.releases[1]());
    const download = await downloadPromise;
    await page.evaluate(() => window.__trackedExports[1]);
    expect(download.suggestedFilename()).toMatch(/-dark\.pdf$/);
    expect(downloadCount).toBe(1);

    const exportedBytes = readFileSync(await download.path());
    const exportedText = await page.evaluate(async (base64) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
      }

      const doc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
      const pdfPage = await doc.getPage(1);
      const textContent = await pdfPage.getTextContent();
      const text = textContent.items.map(item => item.str).join(' ');
      await doc.destroy();
      return text;
    }, exportedBytes.toString('base64'));
    expect(exportedText).toMatch(/[\u0600-\u06ff]/);
    expect(exportedText).not.toContain('\ufffd');

    await page.evaluate(() => {
      const control = window.__outlineSaveControl;
      control.PDFDocument.prototype.save = control.originalSave;
    });
  });

  test('keeps PDFs without an outline free of outline entries', async ({ page }) => {
    const originalBytes = readFileSync(join(FIXTURES_DIR, 'test-native-simple.pdf'));

    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');

    expect(await extractOutline(page, originalBytes)).toEqual([]);

    const exportedBytes = await exportAndGetBytes(page);
    expect(await extractOutline(page, exportedBytes)).toEqual([]);
  });
});
