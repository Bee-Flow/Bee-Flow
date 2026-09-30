import { expiringSoon } from './licence';

describe('expiringSoon', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');

    it('flags a licence that ends within thirty days', () => {
        expect(expiringSoon('2026-01-20T00:00:00Z', now)).toBe(true);
        expect(expiringSoon('2026-03-01T00:00:00Z', now)).toBe(false);
    });

    it('does not flag a date it cannot read', () => {
        expect(expiringSoon('not a date', now)).toBe(false);
    });
});
