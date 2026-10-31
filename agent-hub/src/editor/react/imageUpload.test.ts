// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { isSafeImageSrc } from './imageUpload';

// The same addresses BeeEditor.features.test.tsx pushes through a real paste,
// asserted here on the check itself.
describe('isSafeImageSrc', () => {
    it('accepts a same-origin path and an http(s) address', () => {
        expect(isSafeImageSrc('/api/storage/x.png')).toBe(true);
        expect(isSafeImageSrc('https://example.test/a.png')).toBe(true);
        expect(isSafeImageSrc('http://example.test/a.png')).toBe(true);
    });

    it('keeps a picture carried inside the document as a data: URL (png, jpeg, gif, webp)', () => {
        for (const type of ['png', 'jpeg', 'gif', 'webp']) {
            expect(isSafeImageSrc(`data:image/${type};base64,iVBORw0KGgo=`)).toBe(true);
        }
    });

    it('refuses a script address, an SVG data: URL, a malformed one and one that is too large', () => {
        const large = `data:image/png;base64,${'A'.repeat(420 * 1024)}`;
        for (const src of ['javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,<script>', large]) {
            expect(isSafeImageSrc(src)).toBe(false);
        }
    });

    it('refuses anything that is not a non-empty string', () => {
        for (const src of [undefined, null, '', 42, { src: '/x.png' }]) expect(isSafeImageSrc(src)).toBe(false);
    });
});
