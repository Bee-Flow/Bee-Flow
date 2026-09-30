import { translate } from '@/core/i18n';

import { headerKicker, headerTitle, stepTypeLabel } from './headerText';

const at = (index: number, total: number) => ({ index, total, prevId: null, nextId: null });

describe('the node editor header', () => {
    it('names the step the way the author would recognise it', () => {
        expect(headerTitle({ id: 's1', type: 'wait', label: 'Cool down' })).toBe('Cool down');
        expect(headerTitle({ id: 'trg', type: 'trigger', kind: 'schedule' })).not.toBe('trg');
        expect(headerTitle({ id: 'a1', type: 'integration_action', tool: 'gmail_search' })).not.toBe('gmail_search');
        expect(headerTitle({ id: 'n1', type: 'notification' })).toBe(stepTypeLabel({ id: 'n1', type: 'notification' }));
        expect(headerTitle(null)).toBe('');
    });

    it('says what kind of step it is, and where it runs', () => {
        const kind = stepTypeLabel({ id: 'g', type: 'tokenize' }, translate);
        expect(kind).not.toBe('tokenize');
        expect(headerKicker({ id: 'g', type: 'tokenize' }, at(3, 7), translate)).toBe(`${kind} · Step 3 of 7`);
        expect(headerKicker({ id: 'g', type: 'tokenize' }, at(1, 1), translate)).toBe(kind);
        expect(stepTypeLabel({ id: 'x', type: 'brand_new_type' })).toBe('brand new type');
    });
});
