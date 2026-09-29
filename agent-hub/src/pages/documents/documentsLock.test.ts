import { describe, expect, it } from 'vitest';
import { documentsLockText, documentsRefusalText, STUDIO_DOCUMENTS } from './documentsLock';

/**
 * The words for a locked `studio_documents`: which lock it is, and that the
 * documents somebody already made still open, download and archive.
 */

const en = (text: string) => text;
const nl = (_en: string, text?: string) => text || _en;

describe('documentsLockText', () => {
    it('distinguishes "ask an admin" from "higher plan", and says what still works', () => {
        expect(documentsLockText('not_granted', en)).toMatch(/ask an admin/);
        expect(documentsLockText('ceiling', en)).toMatch(/higher plan/);
        for (const reason of ['not_granted', 'ceiling']) {
            expect(documentsLockText(reason, en)).toMatch(/open, download and archive/);
        }
    });

    it('speaks Dutch to a Dutch reader', () => {
        expect(documentsLockText('ceiling', nl)).toMatch(/hoger abonnement/);
        expect(documentsLockText('not_granted', nl)).toMatch(/beheerder/);
    });
});

describe('documentsRefusalText', () => {
    it('reads the licence refusal documentsApi carries', () => {
        expect(documentsRefusalText({ status: 403, code: 'feature_locked', feature: STUDIO_DOCUMENTS }, en)).toBe(documentsLockText('ceiling', en));
        expect(documentsRefusalText({ status: 403, code: 'feature_disabled', feature: STUDIO_DOCUMENTS }, en)).toBe(documentsLockText('not_granted', en));
    });

    it('leaves every other failure to its own message', () => {
        expect(documentsRefusalText({ status: 404, code: 'feature_locked', feature: STUDIO_DOCUMENTS }, en)).toBeNull();
        expect(documentsRefusalText({ status: 403, code: 'feature_locked', feature: 'webpages' }, en)).toBeNull();
        expect(documentsRefusalText(new Error('boom'), en)).toBeNull();
        expect(documentsRefusalText(null, en)).toBeNull();
    });
});
