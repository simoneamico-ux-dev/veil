/* DESIGN
   ------
   * Most binary assets load from one file. Noto CJK fonts exceed the
   * hosting margin, so fixed parts are loaded sequentially and joined
   * into the exact byte sequence recorded in the vendor manifest.
*/

/**
 * @typedef {{ parts: string[], totalBytes: number }} MultipartAsset
 */

/**
 * Load a binary asset from one file or a fixed sequence of parts.
 *
 * @param {string | MultipartAsset} asset
 * @param {typeof fetch} [fetchAsset]
 * @returns {Promise<Uint8Array>}
 */
export async function loadBinaryAsset(asset, fetchAsset = fetch) {
  if (typeof asset === 'string') {
    const response = await fetchAsset(asset);
    if (!response.ok) throw new Error(`Asset fetch ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  if (
    !asset
    || !Array.isArray(asset.parts)
    || !asset.parts.length
    || !asset.parts.every(part => typeof part === 'string' && part)
    || !Number.isSafeInteger(asset.totalBytes)
    || asset.totalBytes <= 0
  ) {
    throw new TypeError('Invalid multipart asset');
  }

  const bytes = new Uint8Array(asset.totalBytes);
  let offset = 0;

  for (const part of asset.parts) {
    const response = await fetchAsset(part);
    if (!response.ok) throw new Error(`Asset fetch ${response.status}`);

    const chunk = new Uint8Array(await response.arrayBuffer());
    if (offset + chunk.byteLength > bytes.byteLength) {
      throw new Error('Multipart asset exceeds declared size');
    }

    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (offset !== bytes.byteLength) {
    throw new Error(`Multipart asset size ${offset}, expected ${bytes.byteLength}`);
  }

  return bytes;
}
