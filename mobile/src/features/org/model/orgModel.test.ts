/**
 * The pure parts of the org-admin sections: the form-as-edits diff, the
 * profile and domain rules, the theme knobs and the number wording.
 */

import { _reset, setCatalogue } from '@/core/i18n';

import { changedKeys, isEmptyPatch } from './draft';
import { byActivity, fill, formatBytes, formatTokens, memberMatches, minutesOf, relativeActivity } from './format';
import { isValidDomain, normalizeDomain, PROFILE_FIELDS, profileFormOf, serverImageUri } from './profile';
import type { AcademyMember } from './sectionTypes';
import { formatRadius, isValidAccent, normalizeAccent } from './theme';

const t = (_key: string, fallback: string, params?: Record<string, string | number>) =>
    Object.entries(params ?? {}).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), fallback);

describe('changedKeys', () => {
    it('keeps only the edits that differ from the server', () => {
        const base = { name: 'Acme', city: 'Delft', domains: ['a.nl'] };
        expect(changedKeys(base, { name: 'Acme', city: 'Leiden' })).toEqual({ city: 'Leiden' });
        expect(changedKeys(base, { domains: ['a.nl'] })).toEqual({});
        expect(changedKeys(base, { domains: ['a.nl', 'b.nl'] })).toEqual({ domains: ['a.nl', 'b.nl'] });
        expect(isEmptyPatch({})).toBe(true);
        expect(isEmptyPatch({ a: 1 })).toBe(false);
    });
});

describe('the profile form', () => {
    it('lists the thirteen fields in the web order and reads absent ones as empty', () => {
        expect(PROFILE_FIELDS).toHaveLength(13);
        const form = profileFormOf({ id: 'o1', name: 'Acme', billingCountry: 'NL' });
        expect(form.name).toBe('Acme');
        expect(form.billingCountry).toBe('NL');
        expect(form.vat).toBe('');
    });

    it('checks domains with the web and server rule, lower-cased', () => {
        expect(normalizeDomain('  Example.COM ')).toBe('example.com');
        expect(isValidDomain('example.com')).toBe(true);
        expect(isValidDomain('sub.example.co.uk')).toBe(true);
        expect(isValidDomain('example')).toBe(false);
        expect(isValidDomain('-bad.com')).toBe(false);
    });

    it('resolves a server-relative image and passes absolute ones through', () => {
        const resolve = (p: string) => `https://bee.example${p}`;
        expect(serverImageUri('/uploads/logo.png', resolve)).toBe('https://bee.example/uploads/logo.png');
        expect(serverImageUri('uploads/logo.png', resolve)).toBe('https://bee.example/uploads/logo.png');
        expect(serverImageUri('https://cdn.example/l.png', resolve)).toBe('https://cdn.example/l.png');
        expect(serverImageUri('', resolve)).toBeNull();
        expect(
            serverImageUri('/x', () => {
                throw new Error('no server');
            }),
        ).toBeNull();
    });
});

describe('the theme knobs', () => {
    it('accepts only #rrggbb, normalised as the server stores it', () => {
        expect(normalizeAccent(' 3B82F6 ')).toBe('#3b82f6');
        expect(isValidAccent('#3b82f6')).toBe(true);
        expect(isValidAccent('#FFF')).toBe(false);
        expect(formatRadius(1)).toBe('1.00×');
    });
});

describe('the number wording', () => {
    it('writes sizes, minutes, tokens and the web placeholders', () => {
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(2048)).toBe('2 kB');
        expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
        expect(minutesOf(300)).toBe(5);
        expect(formatTokens(750000)).toBe('750,000');
        expect(fill('Delete the {{n}} stored answer(s) now', { n: 3 })).toBe('Delete the 3 stored answer(s) now');
    });

    it('says how long ago a member was active', () => {
        const now = Date.parse('2026-09-24T12:00:00Z');
        expect(relativeActivity(null, t, now)).toBe('Not started');
        expect(relativeActivity('2026-09-24T08:00:00Z', t, now)).toBe('Today');
        expect(relativeActivity('2026-09-23T08:00:00Z', t, now)).toBe('Yesterday');
        expect(relativeActivity('2026-09-14T12:00:00Z', t, now)).toBe('10 days ago');
        expect(relativeActivity('2026-06-01T12:00:00Z', t, now)).toBe('3mo ago');
        expect(relativeActivity('2024-01-01T12:00:00Z', t, now)).toBe('Jan 1, 2024');
    });

    it('writes numbers and dates in the app’s language, not in American English', () => {
        setCatalogue('nl', {});
        try {
            expect(formatTokens(750000)).toBe('750.000');
            expect(formatBytes(3 * 1024 * 1024)).toBe('3,0 MB');
            expect(relativeActivity('2024-01-01T12:00:00Z', t, Date.parse('2026-09-24T12:00:00Z'))).toBe('1 jan 2024');
        } finally {
            _reset();
        }
    });

    it('searches and orders members as the web does', () => {
        const member = (userId: string, displayName: string, lastActivity: string | null): AcademyMember => ({
            userId,
            displayName,
            email: `${userId}@acme.nl`,
            avatar: null,
            avatarType: null,
            coursesDone: [],
            badges: [],
            certificates: [],
            lastActivity,
        });
        const rows = [member('a', 'Ada', null), member('b', 'Bo', '2026-09-01'), member('c', 'Cy', '2026-09-20')];
        expect(byActivity(rows).map((m) => m.userId)).toEqual(['c', 'b', 'a']);
        expect(memberMatches(rows[0] as AcademyMember, 'ada')).toBe(true);
        expect(memberMatches(rows[1] as AcademyMember, 'b@acme')).toBe(true);
        expect(memberMatches(rows[2] as AcademyMember, 'zed')).toBe(false);
    });
});
