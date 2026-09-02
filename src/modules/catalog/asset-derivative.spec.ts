import { describe, expect, it } from 'vitest';
import { derivativeKey } from './asset-derivative.service';

/**
 * The key derivation is small but load-bearing: a derivative has to be
 * findable from its original, which is what makes an orphan sweep possible if a
 * row is ever lost.
 */
describe('derivativeKey', () => {
  it('replaces the extension with the suffix and .webp', () => {
    expect(derivativeKey('artwork/catalog/POS-A2/123-photo.png', 'thumb')).toBe(
      'artwork/catalog/POS-A2/123-photo.thumb.webp',
    );
  });

  it('keeps the full path so the derivative sits beside its source', () => {
    // Prefix and tenant segment intact — a lifecycle rule written against
    // `artwork/` must catch the derivatives too, not just the originals.
    expect(derivativeKey('artwork/catalog/SKU/a.jpg', 'preview')).toMatch(
      /^artwork\/catalog\/SKU\//,
    );
  });

  it('appends when the filename has no extension', () => {
    expect(derivativeKey('artwork/catalog/SKU/photo', 'thumb')).toBe(
      'artwork/catalog/SKU/photo.thumb.webp',
    );
  });

  it('only strips an extension from the filename, never from a directory', () => {
    // A dot in a directory name would otherwise be read as the extension and
    // the derivative would land in the wrong place — or overwrite something.
    expect(derivativeKey('artwork/v1.2/SKU/photo', 'thumb')).toBe(
      'artwork/v1.2/SKU/photo.thumb.webp',
    );
  });

  it('strips only the last extension from a double-barrelled name', () => {
    expect(derivativeKey('artwork/catalog/SKU/poster.final.png', 'thumb')).toBe(
      'artwork/catalog/SKU/poster.final.thumb.webp',
    );
  });

  it('gives the two sizes different keys', () => {
    const source = 'artwork/catalog/SKU/photo.png';
    expect(derivativeKey(source, 'thumb')).not.toBe(derivativeKey(source, 'preview'));
  });

  it('is deterministic', () => {
    // Same input, same key — the sweep depends on being able to recompute it.
    const source = 'artwork/catalog/SKU/photo.png';
    expect(derivativeKey(source, 'thumb')).toBe(derivativeKey(source, 'thumb'));
  });
});
