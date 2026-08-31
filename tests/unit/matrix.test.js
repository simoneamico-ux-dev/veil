import { describe, it, expect } from 'vitest';
import {
  multiplyMatrices,
  transformPoint,
  transformPdfDestination,
  computeImageBounds,
  IDENTITY_MATRIX,
} from '../../core.js';

const STANDARD_VIEWPORT = {
  transform: [1, 0, 0, -1, 0, 792],
  height: 792,
};
const CROPPED_VIEWPORT = {
  transform: [1, 0, 0, -1, -36, 720],
  height: 648,
};
const ROTATED_VIEWPORT = {
  transform: [0, 1, 1, 0, 0, 0],
  height: 612,
};

// ============================================================
// multiplyMatrices
// ============================================================

describe('multiplyMatrices', () => {
  it('identity * identity = identity', () => {
    const result = multiplyMatrices(IDENTITY_MATRIX, IDENTITY_MATRIX);
    expect(result).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('identity * M = M', () => {
    const m = [2, 3, 4, 5, 10, 20];
    expect(multiplyMatrices(IDENTITY_MATRIX, m)).toEqual(m);
  });

  it('M * identity = M', () => {
    const m = [2, 3, 4, 5, 10, 20];
    expect(multiplyMatrices(m, IDENTITY_MATRIX)).toEqual(m);
  });

  it('translation * translation = composed translation', () => {
    const t1 = [1, 0, 0, 1, 10, 20];
    const t2 = [1, 0, 0, 1, 30, 40];
    const result = multiplyMatrices(t1, t2);
    expect(result).toEqual([1, 0, 0, 1, 40, 60]);
  });

  it('scale * scale = composed scale', () => {
    const s1 = [2, 0, 0, 3, 0, 0];
    const s2 = [4, 0, 0, 5, 0, 0];
    const result = multiplyMatrices(s1, s2);
    expect(result[0]).toBe(8);  // 2*4
    expect(result[3]).toBe(15); // 3*5
  });

  it('scale then translate applies scale to translation', () => {
    // Scale by 2, then translate by (10, 10)
    const scale = [2, 0, 0, 2, 0, 0];
    const translate = [1, 0, 0, 1, 10, 10];
    const result = multiplyMatrices(scale, translate);
    // The translation in the result is scaled: 2*10 = 20
    expect(result[4]).toBe(20);
    expect(result[5]).toBe(20);
  });

  it('90-degree rotation produces correct matrix', () => {
    // Rotate 90 degrees: [cos90, sin90, -sin90, cos90, 0, 0]
    const rot90 = [0, 1, -1, 0, 0, 0];
    const result = multiplyMatrices(rot90, rot90);
    // 180 degree rotation: [-1, 0, 0, -1, 0, 0]
    expect(result[0]).toBeCloseTo(-1);
    expect(result[1]).toBeCloseTo(0);
    expect(result[2]).toBeCloseTo(0);
    expect(result[3]).toBeCloseTo(-1);
  });
});

// ============================================================
// transformPoint
// ============================================================

describe('transformPoint', () => {
  it('identity preserves point', () => {
    expect(transformPoint(IDENTITY_MATRIX, 5, 7)).toEqual([5, 7]);
  });

  it('translation shifts point', () => {
    const t = [1, 0, 0, 1, 100, 200];
    expect(transformPoint(t, 5, 7)).toEqual([105, 207]);
  });

  it('scale doubles point', () => {
    const s = [2, 0, 0, 2, 0, 0];
    expect(transformPoint(s, 5, 7)).toEqual([10, 14]);
  });

  it('scale + translate', () => {
    const m = [2, 0, 0, 3, 10, 20];
    expect(transformPoint(m, 5, 7)).toEqual([20, 41]);
    // x: 2*5 + 0*7 + 10 = 20
    // y: 0*5 + 3*7 + 20 = 41
  });

  it('origin transforms to translation only', () => {
    const m = [2, 3, 4, 5, 10, 20];
    expect(transformPoint(m, 0, 0)).toEqual([10, 20]);
  });

  it('90-degree rotation', () => {
    const rot90 = [0, 1, -1, 0, 0, 0];
    const [x, y] = transformPoint(rot90, 1, 0);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(1);
  });
});

// ============================================================
// transformPdfDestination
// ============================================================

describe('transformPdfDestination', () => {
  it('remaps XYZ coordinates through a CropBox offset', () => {
    const dest = [null, { name: 'XYZ' }, 72, 700, null];
    expect(transformPdfDestination(dest, CROPPED_VIEWPORT)).toEqual([
      'XYZ', 36, 628, null,
    ]);
  });

  it('remaps both XYZ axes on a rotated page', () => {
    const dest = [null, { name: 'XYZ' }, 72, 700, 1.5];
    expect(transformPdfDestination(dest, ROTATED_VIEWPORT)).toEqual([
      'XYZ', 700, 540, 1.5,
    ]);
  });

  it('keeps an unresolvable rotated XYZ axis null', () => {
    const dest = [null, { name: 'XYZ' }, null, 700, null];
    expect(transformPdfDestination(dest, ROTATED_VIEWPORT)).toEqual([
      'XYZ', 700, null, null,
    ]);
  });

  it('remaps FitH on an unrotated cropped page', () => {
    const dest = [null, { name: 'FitH' }, 700];
    expect(transformPdfDestination(dest, CROPPED_VIEWPORT)).toEqual(['FitH', 628]);
  });

  it('remaps FitV on an unrotated cropped page', () => {
    const dest = [null, { name: 'FitV' }, 72];
    expect(transformPdfDestination(dest, CROPPED_VIEWPORT)).toEqual(['FitV', 36]);
  });

  it('falls back to Fit when rotation makes FitH non-equivalent', () => {
    const dest = [null, { name: 'FitH' }, 700];
    expect(transformPdfDestination(dest, ROTATED_VIEWPORT)).toEqual(['Fit']);
  });

  it('falls back to Fit when rotation makes FitV non-equivalent', () => {
    const dest = [null, { name: 'FitV' }, 72];
    expect(transformPdfDestination(dest, ROTATED_VIEWPORT)).toEqual(['Fit']);
  });

  it('normalizes FitB to the raster page bounds', () => {
    const dest = [null, { name: 'FitB' }];
    expect(transformPdfDestination(dest, STANDARD_VIEWPORT)).toEqual(['Fit']);
  });

  it('normalizes FitBH to FitH while preserving its coordinate', () => {
    const dest = [null, { name: 'FitBH' }, 700];
    expect(transformPdfDestination(dest, CROPPED_VIEWPORT)).toEqual(['FitH', 628]);
  });

  it('normalizes FitBV to FitV while preserving its coordinate', () => {
    const dest = [null, { name: 'FitBV' }, 72];
    expect(transformPdfDestination(dest, CROPPED_VIEWPORT)).toEqual(['FitV', 36]);
  });

  it('remaps every FitR corner through a CropBox offset', () => {
    const dest = [null, { name: 'FitR' }, 72, 100, 200, 300];
    expect(transformPdfDestination(dest, CROPPED_VIEWPORT)).toEqual([
      'FitR', 36, 28, 164, 228,
    ]);
  });

  it('rebuilds the FitR bounds after rotation', () => {
    const dest = [null, { name: 'FitR' }, 72, 100, 200, 300];
    expect(transformPdfDestination(dest, ROTATED_VIEWPORT)).toEqual([
      'FitR', 100, 412, 300, 540,
    ]);
  });

  it('falls back to Fit for malformed FitR coordinates', () => {
    const dest = [null, { name: 'FitR' }, 72, null, 200, 300];
    expect(transformPdfDestination(dest, STANDARD_VIEWPORT)).toEqual(['Fit']);
  });

  it('leaves unknown destination modes untouched', () => {
    const customMode = { name: 'Custom' };
    const dest = [null, customMode, 12, null];
    expect(transformPdfDestination(dest, STANDARD_VIEWPORT)).toEqual([
      customMode, 12, null,
    ]);
  });

  it('removes right-angle floating-point residue', () => {
    const viewport = {
      transform: [1, 6.123e-17, 6.123e-17, -1, 0, 792],
      height: 792,
    };
    const dest = [null, { name: 'XYZ' }, 0, 792, null];
    expect(transformPdfDestination(dest, viewport)).toEqual(['XYZ', 0, 792, null]);
  });
});

// ============================================================
// computeImageBounds
// ============================================================

describe('computeImageBounds', () => {
  it('unit square at origin with identity transforms', () => {
    const bounds = computeImageBounds(IDENTITY_MATRIX, IDENTITY_MATRIX);
    expect(bounds.x).toBe(0);
    expect(bounds.y).toBe(0);
    expect(bounds.width).toBe(1);
    expect(bounds.height).toBe(1);
  });

  it('translated image', () => {
    const ctm = [1, 0, 0, 1, 100, 200];
    const bounds = computeImageBounds(ctm, IDENTITY_MATRIX);
    expect(bounds.x).toBe(100);
    expect(bounds.y).toBe(200);
    expect(bounds.width).toBe(1);
    expect(bounds.height).toBe(1);
  });

  it('scaled image', () => {
    const ctm = [200, 0, 0, 300, 50, 60];
    const bounds = computeImageBounds(ctm, IDENTITY_MATRIX);
    expect(bounds.x).toBe(50);
    expect(bounds.y).toBe(60);
    expect(bounds.width).toBe(200);
    expect(bounds.height).toBe(300);
  });

  it('viewport transform applies correctly', () => {
    // CTM places image at (100, 200) with size 50x50
    const ctm = [50, 0, 0, 50, 100, 200];
    // Viewport doubles everything
    const vp = [2, 0, 0, 2, 0, 0];
    const bounds = computeImageBounds(ctm, vp);
    expect(bounds.x).toBe(200);
    expect(bounds.y).toBe(400);
    expect(bounds.width).toBe(100);
    expect(bounds.height).toBe(100);
  });

  it('handles negative scale (flipped image)', () => {
    // Flipped horizontally: scale = [-200, 0, 0, 300, 250, 60]
    // Unit square corners map to:
    //   (0,0)->250,60  (1,0)->50,60  (1,1)->50,360  (0,1)->250,360
    const ctm = [-200, 0, 0, 300, 250, 60];
    const bounds = computeImageBounds(ctm, IDENTITY_MATRIX);
    expect(bounds.x).toBe(50);
    expect(bounds.y).toBe(60);
    expect(bounds.width).toBe(200);
    expect(bounds.height).toBe(300);
  });
});
