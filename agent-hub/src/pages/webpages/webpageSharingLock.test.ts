import { describe, expect, it } from 'vitest';
import { sharingLockText, sharingRefusalText, WEBPAGE_SHARING } from './webpageSharingLock';

/**
 * The words for a locked `webpage_sharing`: which of the two locks it is,
 * what still works, and never the bare `feature_locked` token the server's
 * gate answers with.
 */

const t = (_key: string, fallback?: unknown) => String(fallback ?? '');

describe('sharingLockText', () => {
    it('says "ask an admin" when the plan has it and the organisation did not switch it on', () => {
        expect(sharingLockText('not_granted', t)).toMatch(/ask an admin/);
    });

    it('says "higher plan" otherwise, and that what is shared stays shared', () => {
        const text = sharingLockText('ceiling', t);
        expect(text).toMatch(/higher plan/);
        expect(text).toMatch(/already shared stays shared/);
        expect(text).toMatch(/stop sharing/);
    });

    it('uses no dash as punctuation', () => {
        for (const reason of ['not_granted', 'ceiling']) expect(sharingLockText(reason, t)).not.toMatch(/ [—–-] /);
    });
});

describe('sharingRefusalText', () => {
    it('turns the gate\'s 403 into the matching sentence', () => {
        expect(sharingRefusalText(403, { error: 'feature_locked', feature: WEBPAGE_SHARING }, t)).toBe(sharingLockText('ceiling', t));
        expect(sharingRefusalText(403, { error: 'feature_disabled', feature: WEBPAGE_SHARING }, t)).toBe(sharingLockText('not_granted', t));
    });

    it('leaves every other answer alone', () => {
        expect(sharingRefusalText(403, { error: 'Permission denied' }, t)).toBeNull();
        expect(sharingRefusalText(403, { error: 'feature_locked', feature: 'webpages' }, t)).toBeNull();
        expect(sharingRefusalText(400, { error: 'feature_locked', feature: WEBPAGE_SHARING }, t)).toBeNull();
        expect(sharingRefusalText(403, null, t)).toBeNull();
    });
});
