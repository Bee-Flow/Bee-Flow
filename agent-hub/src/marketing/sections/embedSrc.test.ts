import { describe, expect, it } from 'vitest';
import { safeEmbedSrc } from './embedSrc';

describe('safeEmbedSrc', () => {
    it('keeps an https address as the editor typed it', () => {
        expect(safeEmbedSrc('https://calendly.com/team/intro?month=2026-11')).toBe('https://calendly.com/team/intro?month=2026-11');
        expect(safeEmbedSrc('  https://www.google.com/maps/embed?pb=1 ')).toBe('https://www.google.com/maps/embed?pb=1');
    });

    it('refuses every address that is not an absolute https URL', () => {
        expect(safeEmbedSrc('http://widget.example.com/')).toBeNull();
        expect(safeEmbedSrc('javascript:alert(1)')).toBeNull();
        expect(safeEmbedSrc('data:text/html,<script>alert(1)</script>')).toBeNull();
        expect(safeEmbedSrc('//widget.example.com/')).toBeNull();
        expect(safeEmbedSrc('/local/page')).toBeNull();
        expect(safeEmbedSrc('')).toBeNull();
        expect(safeEmbedSrc(undefined)).toBeNull();
    });
});
