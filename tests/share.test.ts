import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parsePlan } from '../src/parser/parse.js';
import {
  MAX_FRAGMENT_CHARS,
  ShareTooLargeError,
  decodeFromUrl,
  encodeForUrl,
  isShareSupported,
} from '../src/share.js';

const FIXTURE_DIR = join(import.meta.dirname, '..', 'src', 'fixtures');

describe('url sharing', () => {
  it('is supported in the test runtime', () => {
    expect(isShareSupported()).toBe(true);
  });

  it('round-trips every fixture', async () => {
    const fixtures = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'));

    for (const name of fixtures) {
      const source = readFileSync(join(FIXTURE_DIR, name), 'utf8');
      const encoded = await encodeForUrl(source);
      const decoded = await decodeFromUrl(`#${encoded}`);

      expect(decoded).not.toBeNull();
      // Whitespace is stripped, so compare parsed structure rather than text.
      expect(JSON.parse(decoded as string)).toEqual(JSON.parse(source));
    }
  });

  it('produces something the parser accepts', async () => {
    const source = readFileSync(join(FIXTURE_DIR, 'seq-scan-disk-sort.json'), 'utf8');
    const decoded = await decodeFromUrl(await encodeForUrl(source));
    const plan = parsePlan(decoded as string);
    expect(plan.nodes.length).toBe(5);
  });

  it('compresses substantially', async () => {
    const source = readFileSync(join(FIXTURE_DIR, 'seq-scan-disk-sort.json'), 'utf8');
    const encoded = await encodeForUrl(source);
    expect(encoded.length).toBeLessThan(source.length / 2);
  });

  it('is safe in a URL without escaping', async () => {
    const source = readFileSync(join(FIXTURE_DIR, 'hash-batches.json'), 'utf8');
    const encoded = await encodeForUrl(source);
    expect(encoded).toMatch(/^p=[A-Za-z0-9_-]+$/);
  });

  it('accepts the fragment with or without the hash', async () => {
    const source = '[{"Plan":{"Node Type":"Result"}}]';
    const encoded = await encodeForUrl(source);
    expect(await decodeFromUrl(encoded)).toBe(source);
    expect(await decodeFromUrl(`#${encoded}`)).toBe(source);
  });

  it('returns null for an empty or unrelated fragment', async () => {
    expect(await decodeFromUrl('')).toBeNull();
    expect(await decodeFromUrl('#')).toBeNull();
    expect(await decodeFromUrl('#section-2')).toBeNull();
  });

  it('returns null rather than throwing on garbage', async () => {
    expect(await decodeFromUrl('#p=not-real-deflate-data!!')).toBeNull();
  });

  it('refuses plans that would make a fragile link', async () => {
    // Random bytes do not compress, so this reliably overshoots.
    const junk = Array.from({ length: MAX_FRAGMENT_CHARS * 2 }, () =>
      Math.random().toString(36).slice(2),
    ).join('');
    await expect(encodeForUrl(junk)).rejects.toBeInstanceOf(ShareTooLargeError);
  });
});
