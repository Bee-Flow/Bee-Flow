/**
 * Android's notification permission, read the way the app acts on it: when
 * the system dialog can still help, and when only Android's settings can.
 */

import { alertPermissionOf } from './permission';

describe('alertPermissionOf', () => {
    it('reads a grant as granted', () => {
        expect(alertPermissionOf({ status: 'granted', granted: true, canAskAgain: true })).toEqual({
            granted: true,
            canAskAgain: true,
            unknown: false,
        });
    });

    it('never asked (Android 13+): the dialog can help', () => {
        expect(alertPermissionOf({ status: 'undetermined', granted: false, canAskAgain: true })).toMatchObject({
            granted: false,
            canAskAgain: true,
        });
    });

    it('refused once: the dialog can still help', () => {
        expect(alertPermissionOf({ status: 'denied', granted: false, canAskAgain: true })).toMatchObject({
            granted: false,
            canAskAgain: true,
        });
    });

    it('refused twice, or switched off below Android 13: only the settings can', () => {
        expect(alertPermissionOf({ status: 'denied', granted: false, canAskAgain: false })).toMatchObject({
            granted: false,
            canAskAgain: false,
        });
    });

    it('granted but switched off in Android settings: only the settings can, whatever canAskAgain says', () => {
        expect(alertPermissionOf({ status: 'denied', granted: true, canAskAgain: true })).toMatchObject({
            granted: false,
            canAskAgain: false,
        });
    });
});
