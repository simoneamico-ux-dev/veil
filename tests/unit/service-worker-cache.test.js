import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('service worker cache upgrades', () => {
  it('removes stale veil caches and retains the active runtime generation', async () => {
    const source = readFileSync('sw.js', 'utf8');
    const shellRevision = source.match(/const SHELL_CACHE_REVISION = '([0-9a-f]{12})';/)[1];
    const runtimeRevision = source.match(/const RUNTIME_CACHE_REVISION = '([0-9a-f]{12})';/)[1];
    const activeShell = `veil-shell-${shellRevision}`;
    const activeRuntime = `veil-runtime-${runtimeRevision}`;
    const handlers = {};
    const deleteCache = vi.fn().mockResolvedValue(true);

    vi.stubGlobal('self', {
      location: {
        href: 'http://localhost/sw.js',
        origin: 'http://localhost',
      },
      addEventListener: (type, handler) => {
        handlers[type] = handler;
      },
    });
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue([
        activeShell,
        activeRuntime,
        'veil-shell-stale',
        'veil-runtime-stale',
        'unrelated-cache',
      ]),
      delete: deleteCache,
    });

    await import('../../sw.js?cache-upgrade-test');

    let activation;
    handlers.activate({
      waitUntil: promise => {
        activation = promise;
      },
    });
    await activation;

    expect(deleteCache.mock.calls.map(([name]) => name)).toEqual([
      'veil-shell-stale',
      'veil-runtime-stale',
    ]);
  });
});
