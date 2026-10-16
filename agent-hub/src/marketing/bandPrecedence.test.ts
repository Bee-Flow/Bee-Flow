import { describe, expect, it } from 'vitest';
import { withBandPrecedence } from './bandPrecedence';

describe('withBandPrecedence', () => {
    it('drops a dark variant under a dark band, so the text is not dark on dark', () => {
        expect(withBandPrecedence({ heading: 'H', backgroundVariant: 'dark' }, { band: 'dark' }))
            .toEqual({ heading: 'H', backgroundVariant: 'default' });
    });

    it('drops any filled variant under a primary band', () => {
        expect(withBandPrecedence({ backgroundVariant: 'dark' }, { band: 'primary' })).toEqual({ backgroundVariant: 'default' });
    });

    it('leaves content alone without a saturated band or without a variant', () => {
        const content = { backgroundVariant: 'dark' };
        expect(withBandPrecedence(content, { band: 'tint' })).toBe(content);
        expect(withBandPrecedence(content, undefined)).toBe(content);
        const legacy = { heading: 'H' };
        expect(withBandPrecedence(legacy, { band: 'dark' })).toBe(legacy);
    });
});
