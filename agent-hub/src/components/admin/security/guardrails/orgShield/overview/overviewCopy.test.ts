import { describe, expect, it } from 'vitest';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import { formatChanged } from './ComplianceLink';
import {
    STEPS, factsForStep, reviewCopy, reviewHeading, rowsForStep, stepLink, type CopyContext,
} from './overviewCopy';
import type { Posture, PostureRow, PostureValue, Tone } from './types';

/**
 * The Overview's words, without rendering: which number may be shown, which
 * wording fits which state, and which rows sit on which step card.
 */

const t: TranslateFn = (key, fallbackOrParams, paramsArg) => {
    const hasFallback = typeof fallbackOrParams === 'string';
    const params = hasFallback ? paramsArg : fallbackOrParams;
    let out = hasFallback ? (fallbackOrParams as string) : key;
    if (params && typeof params === 'object') {
        for (const [k, v] of Object.entries(params)) out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(v));
    }
    return out;
};

const row = (id: string, value: PostureValue, tone: Tone = 'ok', tab: string | null = 'detection'): PostureRow => ({ id, tab, tone, value });
const posture = (...rows: PostureRow[]): Posture => ({ off: false, rows, attention: 0, review: 0 });
const ctx = (over: Partial<CopyContext> = {}): CopyContext => ({ t, ownDataLicensed: true, customTypes: [], guard: null, ...over });

describe('step cards', () => {
    it('groups rows by step and lists the tool lists before the last check', () => {
        const p = posture(
            row('dlp', { on: false }), row('toolcalls', { external: 0, internal: 0, total: 21 }),
            row('categories', { n: 9, total: 21 }), row('eu', { on: false }),
        );
        expect(rowsForStep(p, 4).map(r => r.id)).toEqual(['toolcalls', 'dlp', 'eu']);
        expect(rowsForStep(p, 1).map(r => r.id)).toEqual(['categories']);
    });

    it('words the never-hidden list for every combination', () => {
        const value = (v: PostureValue) => factsForStep(posture(row('allowlist', v)), 1, ctx())[0];
        expect(value({ terms: 0, publicOrgs: true }).value).toBe('221 well-known companies');
        expect(value({ terms: 3, publicOrgs: true }).value).toBe('221 well-known companies + 3 of your own');
        expect(value({ terms: 3, publicOrgs: false }).value).toBe('3 of your own');
        expect(value({ terms: 0, publicOrgs: false }).value).toBe('None');
        // A description, not a setting: it does not read bold.
        expect(value({ terms: 0, publicOrgs: true }).strong).toBe(false);
    });

    it('keeps a custom strictness as a percentage, and notes the tested preset', () => {
        const facts = (v: PostureValue) => factsForStep(posture(row('sensitivity', v)), 1, ctx())[0];
        expect(facts({ customPct: 65 })).toMatchObject({ value: 'Custom (65%)', note: null });
        expect(facts({ presetId: 'balanced' })).toMatchObject({ value: 'Balanced', note: '— the tested setting' });
    });

    it('suggests the two starters only while there are no own types, and links "Add"', () => {
        const empty = posture(row('customterms', { n: 0, sample: [] }, 'ok', 'owndata'));
        expect(factsForStep(empty, 2, ctx()).map(f => [f.label, f.value])).toEqual([
            ['Your own types', 'None yet'],
            ['Suggested', 'Project code names · Customer numbers'],
        ]);
        expect(stepLink(STEPS[1], empty, ctx())).toEqual({ text: 'Add', ariaLabel: 'Add to Your own data' });

        const two = posture(row('customterms', { n: 2, sample: ['Polisnummer', 'Projectnamen'] }, 'ok', 'owndata'));
        expect(factsForStep(two, 2, ctx())).toEqual([expect.objectContaining({ value: '2 types', note: 'Polisnummer · Projectnamen' })]);
        expect(stepLink(STEPS[1], two, ctx()).text).toBe('Change');
    });

    it('reads own types the way the strip does when the plan does not include them', () => {
        const p = posture(row('customterms', { n: 0, sample: [] }, 'ok', 'owndata'));
        const facts = factsForStep(p, 2, ctx({ ownDataLicensed: false }));
        expect(facts.map(f => f.value)).toEqual(['Enterprise']);
        expect(stepLink(STEPS[1], p, ctx({ ownDataLicensed: false })).text).toBe('Change');
    });

    it('marks the values a review item is about in warning ink', () => {
        const p = posture(
            row('transparency', { on: true }, 'note', 'processing'),
            row('automations', { on: true }, 'ok', 'processing'),
            row('knowledge', { on: false }, 'ok', 'processing'),
        );
        expect(factsForStep(p, 3, ctx()).map(f => [f.value, f.warn])).toEqual([
            ['On', true], ['Covered', false], ['Not covered', false],
        ]);
    });

    it('says how many kinds are held back on each side', () => {
        const p = posture(row('toolcalls', { external: 4, internal: 1, total: 21 }, 'warn'));
        expect(factsForStep(p, 4, ctx())[0]).toMatchObject({ value: '4 of 21 outside · 1 of 21 own server', warn: true });
    });
});

describe('review copy', () => {
    it('only claims the last 30 days when they were read', () => {
        expect(reviewHeading(3, true, t)).toEqual({ title: '3 things to review', basis: 'based on your settings and the last 30 days' });
        expect(reviewHeading(1, false, t)).toEqual({ title: '1 thing to review', basis: 'based on your settings' });
    });

    it('leaves an unknown number out rather than showing it as zero', () => {
        const unknown = reviewCopy(row('toolcalls', { external: 0, total: 21, toolPii: null, leakedCount: null }, 'warn'), t);
        expect(unknown?.body).toBe('No kind is held back from outside tools (0 of 21).');
        const noLeak = reviewCopy(row('toolcalls', { external: 0, total: 21, toolPii: 12, leakedCount: null }, 'warn'), t);
        expect(noLeak?.body).toBe('No kind is held back from outside tools (0 of 21). In the last 30 days, 12 tool calls left with personal data.');
    });

    it('does not say "1 tool calls"', () => {
        const one = reviewCopy(row('toolcalls', { external: 0, total: 21, toolPii: 1, leakedCount: 1 }, 'warn'), t);
        expect(one?.body).toContain('1 tool call left with personal data, to a server outside Europe.');
    });

    it('names the missing and the silent detection service apart', () => {
        expect(reviewCopy(row('guard', { configured: false, reachable: false }, 'error', null), t)?.title)
            .toBe('The detection service is not installed');
        expect(reviewCopy(row('guard', { configured: true, reachable: false }, 'error', null), t)?.title)
            .toBe('The detection service is not responding');
    });

    it('has nothing to say about a row that is never reviewed', () => {
        expect(reviewCopy(row('automations', { on: true }), t)).toBeNull();
    });
});

describe('last changed', () => {
    it('formats a date, and passes through what does not parse', () => {
        expect(formatChanged('2026-09-28T15:48:00Z')).toMatch(/2026/);
        expect(formatChanged('not a date')).toBe('not a date');
    });
});
