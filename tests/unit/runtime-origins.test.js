import { describe, expect, it } from 'vitest';
import { inspectRuntimeSource } from '../../scripts/check-runtime-origins.mjs';

describe('runtime origin verification', () => {
  it('rejects external resources through direct and indirect forms', () => {
    const sources = [
      "import dependency from 'https://example.com/dependency.js';",
      "const endpoint = 'https://example.com/model.bin'; fetch(endpoint);",
      "const worker = new Worker(new URL('https://example.com/worker.js'));",
      "import dependency from '//example.com/dependency.js';",
    ];

    for (const source of sources) {
      expect(inspectRuntimeSource(source, 'app.js')).not.toEqual([]);
    }
  });

  it('allows local assets and approved metadata links', () => {
    expect(inspectRuntimeSource(
      "const asset = new URL('./vendor/library.js', import.meta.url);",
      'app.js',
    )).toEqual([]);
    expect(inspectRuntimeSource(
      '<link rel="canonical" href="https://veil.simoneamico.com/">',
      'index.html',
    )).toEqual([]);
  });
});
