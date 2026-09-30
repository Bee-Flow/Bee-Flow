import * as LocalAuthentication from 'expo-local-authentication';

import { clockDriftWarning, describeBiometrics } from './device';

const { AuthenticationType } = LocalAuthentication;

describe('describeBiometrics', () => {
    it('names the strongest thing the phone offers', () => {
        expect(describeBiometrics([AuthenticationType.FINGERPRINT, AuthenticationType.FACIAL_RECOGNITION])).toBe(
            'your face or fingerprint',
        );
        expect(describeBiometrics([AuthenticationType.FINGERPRINT])).toBe('your fingerprint');
        expect(describeBiometrics([])).toBe('your device unlock');
    });
});

describe('clockDriftWarning', () => {
    const now = 1_000_000_000;

    it('warns past a minute either way', () => {
        expect(clockDriftWarning(now - 61_000, now)).toBe(true);
        expect(clockDriftWarning(now + 61_000, now)).toBe(true);
    });

    it('stays quiet inside a minute, or when the server did not say', () => {
        expect(clockDriftWarning(now - 59_000, now)).toBe(false);
        expect(clockDriftWarning(null, now)).toBe(false);
    });
});
