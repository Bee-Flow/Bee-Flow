import { chipTone, chipWords, showsChip } from './chips';

const t = (_key: string, fallback: string) => fallback;

describe("a line's chip", () => {
    it("speaks the port's words, and a case in its own", () => {
        expect(['then', 'else', 'default', 'pii_found', 'pii_clean', 'on_error', 'unrouted', 'vip'].map((k) => chipWords(k, t))).toEqual([
            'match', 'otherwise', 'otherwise', 'personal data', 'clean', 'On error', 'never runs', 'vip',
        ]);
    });

    it('wears the tone of its branch: a guard finding is a warning, not a failure', () => {
        expect(['then', 'pii_clean', 'else', 'pii_found', 'default', 'on_error', 'unrouted', 'vip'].map(chipTone)).toEqual([
            'then', 'then', 'else', 'else', 'default', 'error', 'unrouted', 'case',
        ]);
    });

    it('shows only where the port is silent', () => {
        expect(showsChip({ kind: 'then', labelledAtPort: true })).toBe(false);
        expect(showsChip({ kind: 'on_error', labelledAtPort: false })).toBe(true);
        expect(showsChip({ kind: null, labelledAtPort: false })).toBe(false);
    });
});
