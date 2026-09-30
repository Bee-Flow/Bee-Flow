import { readMfaSetup, readMfaStatus, readRecoveryCodes } from './readers';

describe('the two-factor readers', () => {
    it('reads the status, and a missing hasPassword as no password', () => {
        expect(readMfaStatus({ enabled: true, recoveryCodesRemaining: '3', hasPassword: true })).toEqual({
            enabled: true,
            recoveryCodesRemaining: 3,
            hasPassword: true,
        });
        expect(readMfaStatus({})).toEqual({ enabled: false, recoveryCodesRemaining: 0, hasPassword: false });
        expect(readMfaStatus(null)).toBeNull();
    });

    it('reads the enrolment, and a missing server clock as null (no drift warning)', () => {
        expect(readMfaSetup({ otpauthUrl: 'otpauth://x', qr: 'data:', secret: 'S', serverTime: 5 })).toEqual({
            otpauthUrl: 'otpauth://x',
            qr: 'data:',
            secret: 'S',
            serverTime: 5,
        });
        expect(readMfaSetup({ secret: 'S' })?.serverTime).toBeNull();
    });

    it('reads recovery codes, keeping absent fields absent', () => {
        expect(readRecoveryCodes({ success: true, recoveryCodes: ['a', 'b'] })).toEqual({
            success: true,
            recoveryCodes: ['a', 'b'],
            error: undefined,
        });
        expect(readRecoveryCodes({})?.recoveryCodes).toBeUndefined();
    });
});
