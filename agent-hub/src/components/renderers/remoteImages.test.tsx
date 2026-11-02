/**
 * Which image sources may be fetched without the reader asking: this origin
 * (`/api/...` included), `data:image` and `blob:`. Everything else — another
 * host, a protocol-relative `//host`, a non-image data URI — waits for a
 * click (see MarkdownRenderer.test.tsx for the rendered side).
 *
 * Run: cd agent-hub && npx vitest run src/components/renderers/remoteImages.test.tsx
 */
import { describe, it, expect } from 'vitest';
import { isTrustedImageSource } from './remoteImages';

describe('isTrustedImageSource', () => {
    it('lets this origin, data:image and blob: through and nothing else', () => {
        expect(isTrustedImageSource('/api/files/1')).toBe(true);
        expect(isTrustedImageSource('uploads/a.png')).toBe(true);
        expect(isTrustedImageSource(`${window.location.origin}/uploads/a.png`)).toBe(true);
        expect(isTrustedImageSource('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
        expect(isTrustedImageSource('blob:http://localhost/123')).toBe(true);
        expect(isTrustedImageSource('https://example.com/a.png')).toBe(false);
        expect(isTrustedImageSource('//example.com/a.png')).toBe(false);
        expect(isTrustedImageSource('data:text/html,<b>x</b>')).toBe(false);
        expect(isTrustedImageSource('')).toBe(false);
        expect(isTrustedImageSource(undefined)).toBe(false);
    });
});
