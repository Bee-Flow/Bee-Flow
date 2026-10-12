import { describe, expect, it } from 'vitest';
import { stripInlineMarkdown, stripListMarker } from './markdownText';

describe('stripListMarker', () => {
    it('removes a number or a bullet only when a space follows', () => {
        expect(stripListMarker('1. Add a webhook')).toBe('Add a webhook');
        expect(stripListMarker('2) Call http_request')).toBe('Call http_request');
        expect(stripListMarker('- Use the finance inbox')).toBe('Use the finance inbox');
        expect(stripListMarker('* Use it')).toBe('Use it');
        expect(stripListMarker('• Use it')).toBe('Use it');
        expect(stripListMarker('3 retries on failure')).toBe('3 retries on failure');
        expect(stripListMarker('1.5 seconds between calls')).toBe('1.5 seconds between calls');
        expect(stripListMarker('**Bold** first')).toBe('**Bold** first');
        expect(stripListMarker('-1 is the sentinel')).toBe('-1 is the sentinel');
    });
});

describe('stripInlineMarkdown', () => {
    it('keeps the words of bold, code and links', () => {
        expect(stripInlineMarkdown('Which **trigger** starts `daily-report`? See [the docs](https://x.test).')).toBe('Which trigger starts daily-report? See the docs.');
        expect(stripInlineMarkdown('an *emphasised* word')).toBe('an emphasised word');
    });
});
