import { hostOf, twoFactorLabel } from './labels';

describe('hostOf', () => {
    it('keeps the host, and the input when it is not a URL', () => {
        expect(hostOf('https://beeflow.nl')).toBe('beeflow.nl');
        expect(hostOf('http://10.0.0.2:3101/path')).toBe('10.0.0.2:3101');
        expect(hostOf(null)).toBeNull();
    });
});

describe('twoFactorLabel', () => {
    it('says on or off, and nothing while unknown', () => {
        expect(twoFactorLabel({ enabled: true })).toBe('Two-factor on');
        expect(twoFactorLabel({ enabled: false })).toBe('Two-factor off');
        expect(twoFactorLabel(null)).toBeUndefined();
    });
});
