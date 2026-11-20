import { describe, expect, it } from 'vitest';
import { templatePickMessage, withoutTemplatePick } from './templatePick';

describe('templatePick', () => {
    it('carries the template id on its own line and hides that line again', () => {
        const sent = templatePickMessage('Fill in the template “Offer” with me.', 'abc-123');
        expect(sent).toBe('Fill in the template “Offer” with me.\n\n[template:abc-123]');
        expect(withoutTemplatePick(sent)).toBe('Fill in the template “Offer” with me.');
    });

    it('leaves any other message alone', () => {
        expect(withoutTemplatePick('See [template:x] in the middle')).toBe('See [template:x] in the middle');
        expect(withoutTemplatePick('Just text')).toBe('Just text');
    });
});
