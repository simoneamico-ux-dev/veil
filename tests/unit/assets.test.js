import { describe, it, expect, vi } from 'vitest';
import { loadBinaryAsset } from '../../assets.js';

function response(bytes, ok = true, status = 200) {
  return {
    ok,
    status,
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  };
}

describe('loadBinaryAsset', () => {
  it('loads a single file', async () => {
    const fetchAsset = vi.fn().mockResolvedValue(response([1, 2, 3]));

    const bytes = await loadBinaryAsset('/font.ttf', fetchAsset);

    expect([...bytes]).toEqual([1, 2, 3]);
    expect(fetchAsset).toHaveBeenCalledWith('/font.ttf');
  });

  it('assembles multipart files in declaration order', async () => {
    const fetchAsset = vi.fn()
      .mockResolvedValueOnce(response([1, 2]))
      .mockResolvedValueOnce(response([3, 4, 5]));

    const bytes = await loadBinaryAsset({
      parts: ['/font.part-00', '/font.part-01'],
      totalBytes: 5,
    }, fetchAsset);

    expect([...bytes]).toEqual([1, 2, 3, 4, 5]);
    expect(fetchAsset.mock.calls).toEqual([
      ['/font.part-00'],
      ['/font.part-01'],
    ]);
  });

  it('rejects a response error', async () => {
    const fetchAsset = vi.fn().mockResolvedValue(response([], false, 404));

    await expect(loadBinaryAsset('/missing.ttf', fetchAsset))
      .rejects.toThrow('Asset fetch 404');
  });

  it('rejects multipart data larger than its declaration', async () => {
    const fetchAsset = vi.fn().mockResolvedValue(response([1, 2, 3]));

    await expect(loadBinaryAsset({ parts: ['/part'], totalBytes: 2 }, fetchAsset))
      .rejects.toThrow('Multipart asset exceeds declared size');
  });

  it('rejects incomplete multipart data', async () => {
    const fetchAsset = vi.fn().mockResolvedValue(response([1, 2]));

    await expect(loadBinaryAsset({ parts: ['/part'], totalBytes: 3 }, fetchAsset))
      .rejects.toThrow('Multipart asset size 2, expected 3');
  });

  it('rejects invalid multipart declarations before fetching', async () => {
    const fetchAsset = vi.fn();

    await expect(loadBinaryAsset({ parts: [], totalBytes: 0 }, fetchAsset))
      .rejects.toThrow('Invalid multipart asset');
    expect(fetchAsset).not.toHaveBeenCalled();
  });
});
