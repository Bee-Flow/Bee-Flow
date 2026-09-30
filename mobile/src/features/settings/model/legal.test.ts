import { privacyPolicyUrl } from './legal';

describe('privacyPolicyUrl', () => {
    it('returns the stamped https address', () => {
        expect(privacyPolicyUrl({ privacyPolicyUrl: 'https://beeflow.nl/privacy' })).toBe(
            'https://beeflow.nl/privacy',
        );
    });

    it('trims whitespace around it', () => {
        expect(privacyPolicyUrl({ privacyPolicyUrl: '  https://example.com/p  ' })).toBe(
            'https://example.com/p',
        );
    });

    it('hides anything that is not an https URL', () => {
        expect(privacyPolicyUrl({ privacyPolicyUrl: 'http://example.com/privacy' })).toBeNull();
        expect(privacyPolicyUrl({ privacyPolicyUrl: 'beeflow.nl/privacy' })).toBeNull();
        expect(privacyPolicyUrl({ privacyPolicyUrl: '' })).toBeNull();
        expect(privacyPolicyUrl({ privacyPolicyUrl: 42 })).toBeNull();
    });

    it('copes with a build that stamped nothing', () => {
        expect(privacyPolicyUrl({})).toBeNull();
        expect(privacyPolicyUrl(undefined)).toBeNull();
        expect(privacyPolicyUrl(null)).toBeNull();
    });
});
