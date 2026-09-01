import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import {
  loadPDF,
  READER_URL,
  waitForOcrTextLayer,
} from './helpers.js';

async function exportAndGetBytes(page) {
  const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
  await page.locator('#btn-export').click({ force: true });
  const download = await downloadPromise;
  return readFileSync(await download.path());
}

async function loadPdfBytes(page, bytes, name) {
  await page.waitForFunction(
    () => document.documentElement.dataset.appReady === 'true',
    { timeout: 30000 },
  );
  await page.locator('#file-input').setInputFiles({
    name,
    mimeType: 'application/pdf',
    buffer: bytes,
  });
  await page.locator('#reader').waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.page-container .page-canvas');
    return canvas && canvas.width > 0 && canvas.height > 0;
  }, { timeout: 30000 });
}

async function createJapanesePdf(page) {
  const base64 = await page.evaluate(async () => {
    const [{ PDFDocument, rgb }, { default: fontkit }] = await Promise.all([
      import('/vendor/pdf-lib/1.17.1/pdf-lib.esm.min.js'),
      import('/vendor/fontkit/1.1.1/fontkit.esm.js'),
    ]);
    const partPaths = [
      '/vendor/fonts/noto-cjk/2.004/NotoSansCJKjp-Regular.otf.part-00',
      '/vendor/fonts/noto-cjk/2.004/NotoSansCJKjp-Regular.otf.part-01',
    ];
    const chunks = await Promise.all(partPaths.map(async path => {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`Font fetch ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }));
    const fontBytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      fontBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const digest = await crypto.subtle.digest('SHA-256', fontBytes);
    const hash = [...new Uint8Array(digest)]
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
    if (hash !== '68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5') {
      throw new Error(`Unexpected Japanese font hash ${hash}`);
    }

    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const font = await pdf.embedFont(fontBytes, { subset: true });
    const pdfPage = pdf.addPage([595, 842]);
    pdfPage.drawText('東京 こんにちは', {
      x: 72,
      y: 700,
      size: 32,
      font,
      color: rgb(0, 0, 0),
    });

    const bytes = await pdf.save();
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });

  return Buffer.from(base64, 'base64');
}

test.describe('Self-hosted runtime assets', () => {
  test('reading, OCR, and export stay on the app origin', async ({ page }) => {
    const externalRequests = [];
    const failedRequests = [];
    const policyErrors = [];

    page.on('request', request => {
      const url = new URL(request.url());
      if (url.protocol.startsWith('http') && url.origin !== 'http://localhost:8000') {
        externalRequests.push(request.url());
      }
    });
    page.on('requestfailed', request => failedRequests.push(request.url()));
    page.on('console', message => {
      if (/content security policy|refused to/i.test(message.text())) {
        policyErrors.push(message.text());
      }
    });

    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    expect(await page.locator('body').evaluate(element => getComputedStyle(element).fontFamily))
      .toContain('IBM Plex Sans');

    await page.goto(READER_URL);
    await loadPDF(page, 'test-scanned-real.pdf');
    await waitForOcrTextLayer(page, 1);
    expect((await exportAndGetBytes(page)).byteLength).toBeGreaterThan(1000);

    expect(externalRequests).toEqual([]);
    expect(failedRequests).toEqual([]);
    expect(policyErrors).toEqual([]);
  });

  test('reassembles a CJK font and preserves Japanese text through export', async ({ page }) => {
    await page.goto(READER_URL);
    const fixture = await createJapanesePdf(page);
    await loadPdfBytes(page, fixture, 'japanese.pdf');

    const exported = await exportAndGetBytes(page);
    const text = await page.evaluate(async b64 => {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
      }

      const pdf = await window.pdfjsLib.getDocument({ data: bytes }).promise;
      const pdfPage = await pdf.getPage(1);
      const content = await pdfPage.getTextContent();
      const value = content.items.map(item => item.str).join(' ');
      await pdf.destroy();
      return value;
    }, exported.toString('base64'));

    expect(text).toContain('東京');
    expect(text).toContain('こんにちは');
  });

  test('reading, OCR, and export remain available offline after first use', async ({ page, context }) => {
    test.setTimeout(180000);

    await page.goto(READER_URL);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

    await loadPDF(page, 'test-scanned-real.pdf');
    await waitForOcrTextLayer(page, 1);
    expect((await exportAndGetBytes(page)).byteLength).toBeGreaterThan(1000);

    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const shellNames = names.filter(name => name.startsWith('veil-shell-'));
      const runtimeNames = names.filter(name => name.startsWith('veil-runtime-'));
      if (shellNames.length !== 1 || runtimeNames.length !== 1) {
        return {
          shellCaches: shellNames.length,
          runtimeCaches: runtimeNames.length,
        };
      }
      const shell = await caches.open(shellNames[0]);
      const runtime = await caches.open(runtimeNames[0]);
      return {
        shellCaches: shellNames.length,
        runtimeCaches: runtimeNames.length,
        reader: Boolean(await shell.match('/reader.html')),
        pdfjs: Boolean(await runtime.match('/vendor/pdfjs/5.4.149/pdf.min.mjs')),
        tesseract: Boolean(await runtime.match('/vendor/tesseract.js/5.1.1/tesseract.esm.min.js')),
        english: Boolean(await runtime.match('/vendor/tesseract-data/4.0.0_best_int/eng.traineddata.gz')),
        pdfLib: Boolean(await runtime.match('/vendor/pdf-lib/1.17.1/pdf-lib.esm.min.js')),
      };
    });
    expect(cached).toEqual({
      shellCaches: 1,
      runtimeCaches: 1,
      reader: true,
      pdfjs: true,
      tesseract: true,
      english: true,
      pdfLib: true,
    });

    try {
      await context.setOffline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await loadPDF(page, 'test-scanned-real.pdf');
      await waitForOcrTextLayer(page, 1);
      expect((await exportAndGetBytes(page)).byteLength).toBeGreaterThan(1000);
    } finally {
      await context.setOffline(false);
    }
  });
});
