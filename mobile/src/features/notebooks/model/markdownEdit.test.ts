/** The toolbar's text edits. */

import { applyFormat } from './markdownEdit';

describe('applyFormat', () => {
    it('wraps the selection in bold, and unwraps it again', () => {
        const once = applyFormat('say hello now', { start: 4, end: 9 }, 'bold');
        expect(once).toEqual({ text: 'say **hello** now', selection: { start: 6, end: 11 } });
        expect(applyFormat(once.text, once.selection, 'bold')).toEqual({
            text: 'say hello now',
            selection: { start: 4, end: 9 },
        });
    });

    it('puts the cursor between the marks when nothing is selected', () => {
        expect(applyFormat('ab', { start: 1, end: 1 }, 'italic')).toEqual({ text: 'a**b', selection: { start: 2, end: 2 } });
    });

    it('turns the current line into a heading, and back', () => {
        const once = applyFormat('one\ntwo', { start: 5, end: 5 }, 'heading');
        expect(once.text).toBe('one\n## two');
        expect(once.selection).toEqual({ start: 8, end: 8 });
        expect(applyFormat(once.text, once.selection, 'heading').text).toBe('one\ntwo');
    });

    it('lists every selected line, replacing another list marker', () => {
        const out = applyFormat('- a\nb\nc', { start: 0, end: 5 }, 'task');
        expect(out.text).toBe('- [ ] a\n- [ ] b\nc');
        expect(out.selection).toEqual({ start: 0, end: 15 });
    });

    it('handles an empty document and a reversed selection', () => {
        expect(applyFormat('', { start: 0, end: 0 }, 'bullet')).toEqual({ text: '- ', selection: { start: 2, end: 2 } });
        expect(applyFormat('abc', { start: 3, end: 0 }, 'quote').text).toBe('> abc');
    });
});
