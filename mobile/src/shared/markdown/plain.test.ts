import { plainMarkdown } from './plain';

describe('plainMarkdown', () => {
    it('drops the marks and keeps the words', () => {
        expect(plainMarkdown('**Trigger:** When gmail emits `mail.new`')).toBe('Trigger: When gmail emits mail.new');
        expect(plainMarkdown('# Digest\n\n- one\n- *two*')).toBe('Digest one two');
        expect(plainMarkdown('See [the run](https://x.test) &amp; more')).toBe('See the run & more');
    });

    it('leaves a line without markdown exactly as it is', () => {
        expect(plainMarkdown('Reformat as yyyy-MM-dd')).toBe('Reformat as yyyy-MM-dd');
        expect(plainMarkdown('repository · workflow · branch')).toBe('repository · workflow · branch');
    });

    it('reads only the start of a long text', () => {
        expect(plainMarkdown(`**a** ${'b'.repeat(1000)}`, 20).length).toBeLessThanOrEqual(20);
    });
});
