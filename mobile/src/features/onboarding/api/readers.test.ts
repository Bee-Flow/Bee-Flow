/**
 * The onboarding readers are new. The setup document drives what the login
 * screen OFFERS, so "the server did not say" must stay distinct from "the
 * server said no": an absent password switch still shows the form.
 */

import { readSetupStatus } from './readers';

describe('readSetupStatus', () => {
    it('keeps absent switches absent rather than false', () => {
        const status = readSetupStatus({ isGoogleConfigured: true });
        expect(status?.allowPasswordLogin).toBeUndefined();
        expect(status?.isGoogleConfigured).toBe(true);
        expect(status?.branding).toBeNull();
        expect(status?.consumerLoginMethods).toEqual([]);
    });

    it('reads an explicit refusal and the branding', () => {
        const status = readSetupStatus({ allowPasswordLogin: false, branding: { name: 'Acme', logo: null } });
        expect(status?.allowPasswordLogin).toBe(false);
        expect(status?.branding).toEqual({ name: 'Acme', logo: null });
    });

    it('answers null when there is no document', () => {
        expect(readSetupStatus(null)).toBeNull();
    });
});
