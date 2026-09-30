/**
 * The public-address form. Each rule here keeps a live link alive: a typed
 * password mints a new address, so none is sent unless typed; a table left
 * out of `publicColumns` goes to zero columns, so every bound table is sent.
 */

import type { WebpageAudience } from './audienceTypes';
import { draftProblem, initialDraft, parseEmails, toChoice, toggleColumn } from './publicChoice';

const NOW = Date.parse('2026-09-24T12:00:00Z');

const AUDIENCE: WebpageAudience = {
    internal: { mode: 'org', isPublished: true, sharedGroups: [] },
    public: {
        on: true,
        known: true,
        accessMode: 'password',
        hasPassword: true,
        allowedEmails: [],
        expiresAt: '2026-10-01T00:00:00Z',
        viewCount: 3,
        lastViewedAt: null,
    },
    address: { slug: 'launch', path: '/w/launch', url: null },
    columnGate: {
        tables: [{ datatableId: 't1', label: 'Leads', columns: ['name', 'email'], publicColumns: ['name'] }],
        anyBound: true,
        sharingCount: 1,
    },
    shareCount: 1,
};

describe('initialDraft and toChoice', () => {
    it('starts from what is live and keeps it when nothing is changed', () => {
        const draft = initialDraft(AUDIENCE);
        expect(draft).toMatchObject({ accessMode: 'password', expiry: 'keep', columns: { t1: ['name'] } });
        expect(toChoice(draft, NOW)).toEqual({ on: true, publicColumns: { t1: ['name'] }, accessMode: 'password' });
    });

    it('sends a new password only when one was typed, and an expiry only when chosen', () => {
        const draft = { ...initialDraft(AUDIENCE), password: 'longenough', expiry: '7' as const };
        expect(toChoice(draft, NOW)).toMatchObject({
            password: 'longenough',
            expiresAt: '2026-10-01T12:00:00.000Z',
        });
        expect(toChoice({ ...draft, expiry: 'never' }, NOW).expiresAt).toBeNull();
    });

    it('sends the invite list only in e-mail mode', () => {
        const draft = { ...initialDraft(AUDIENCE), accessMode: 'email' as const, emails: 'A@b.nl, c@d.nl\na@b.nl' };
        expect(toChoice(draft, NOW)).toMatchObject({ allowedEmails: ['a@b.nl', 'c@d.nl'] });
        expect(toChoice(draft, NOW).password).toBeUndefined();
    });
});

describe('draftProblem, parseEmails and toggleColumn', () => {
    it('refuses what the server would refuse', () => {
        const draft = initialDraft(AUDIENCE);
        expect(draftProblem(draft, true)).toBeNull();
        expect(draftProblem(draft, false)).toBe('password');
        expect(draftProblem({ ...draft, password: 'short' }, true)).toBe('password');
        expect(draftProblem({ ...draft, accessMode: 'email', emails: ' ' }, true)).toBe('emails');
    });

    it('splits addresses on any separator', () => {
        expect(parseEmails(' a@b.nl;;c@d.nl  ')).toEqual(['a@b.nl', 'c@d.nl']);
    });

    it('toggles one column of one table', () => {
        const draft = toggleColumn(initialDraft(AUDIENCE), 't1', 'email');
        expect(draft.columns.t1).toEqual(['name', 'email']);
        expect(toggleColumn(draft, 't1', 'name').columns.t1).toEqual(['email']);
        expect(toggleColumn(draft, 't2', 'x').columns.t2).toEqual(['x']);
    });
});
