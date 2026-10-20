import { checksCount } from './ChecksBand';

describe('checksCount', () => {
    it('counts checks, allowed-value lists and a value fallback', () => {
        expect(checksCount({})).toBe(0);
        expect(checksCount({ checks: [{ kind: 'items' }, { kind: 'script' }], enumFrom: [{ field: 'a' }], fallback: { kind: 'value', fields: {} } })).toBe(4);
    });

    it('does not count the stop-with-an-error fallback, nor junk entries', () => {
        expect(checksCount({ checks: [null, 'x'], enumFrom: 'nope', fallback: { kind: 'fail' } })).toBe(0);
    });
});
