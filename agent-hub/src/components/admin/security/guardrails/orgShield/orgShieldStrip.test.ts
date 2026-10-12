/**
 * The path strip's read-outs. Asserted on data (step numbers, counts, tones,
 * which items exist) with a `t` that returns its English fallback, so a
 * wording change in the dictionary does not churn these.
 *
 * Run: npx vitest run src/components/admin/security/guardrails/orgShield/orgShieldStrip.test.ts
 */
import { describe, expect, it } from 'vitest';

import { buildStripItems, dirtyChips } from './orgShieldStrip';
import type { StripInput, StripItem } from './orgShieldStrip';
import type { TranslateFn } from '../../../../../hooks/useTranslation';

const t: TranslateFn = (key, fallbackOrParams, paramsArg) => {
    const fallback = typeof fallbackOrParams === 'string' ? fallbackOrParams : key;
    const params = typeof fallbackOrParams === 'object' ? fallbackOrParams : paramsArg;
    return Object.entries(params || {}).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), fallback);
};

const input = (over: Partial<StripInput> = {}, f: Partial<StripInput['f']> = {}): StripInput => ({
    f: {
        enabled: true,
        piiCategories: ['Email', 'Person'],
        piiConfidenceThreshold: 0.7,
        piiAction: 'tokenize',
        dlpEnabled: false,
        customDataTypes: [],
        toolPiiPolicy: { external: { blockCategories: ['Email'] } },
        ...f,
    },
    total: 21,
    posture: { review: 0, attention: 0 },
    licence: { canTokenizePii: true, canUseCustomData: true },
    guard: { configured: true, reachable: true },
    canSeeActivity: true,
    showActivityTab: true,
    t,
    ...over,
});

const byId = (items: StripItem[], id: string): StripItem => {
    const item = items.find(x => x.id === id);
    if (!item) throw new Error(`no strip item ${id}`);
    return item;
};

describe('buildStripItems', () => {
    it('numbers the four path steps 1–4 and leaves the two pills unnumbered', () => {
        const items = buildStripItems(input());
        expect(items.map(x => [x.id, x.step ?? null, x.inPipeline])).toEqual([
            ['overview', null, false],
            ['detection', 1, true],
            ['owndata', 2, true],
            ['processing', 3, true],
            ['outbound', 4, true],
            ['activity', null, false],
        ]);
        expect(byId(items, 'processing').label).toBe('When we find something');
    });

    it('offers What happened only on a mount that asks for it', () => {
        expect(buildStripItems(input({ showActivityTab: false })).map(x => x.id)).not.toContain('activity');
    });

    it('promises the 30-day window only with the licence that shows it', () => {
        expect(byId(buildStripItems(input()), 'activity').summary).toBe('last 30 days');
        expect(byId(buildStripItems(input({ canSeeActivity: false })), 'activity').summary).toBeUndefined();
    });

    describe('Overview', () => {
        it('counts the review list, amber only when something needs attention', () => {
            const calm = byId(buildStripItems(input({ posture: { review: 3, attention: 0 } })), 'overview');
            expect(calm).toMatchObject({ summary: '3 to review', summaryTone: undefined });
            const alarmed = byId(buildStripItems(input({ posture: { review: 3, attention: 1 } })), 'overview');
            expect(alarmed).toMatchObject({ summary: '3 to review', summaryTone: 'warn' });
        });

        it('says all clear when the review list is empty', () => {
            expect(byId(buildStripItems(input()), 'overview').summary).toBe('all clear');
        });
    });

    describe('step 1', () => {
        it('counts only the built-in kinds and names the strictness preset', () => {
            const item = byId(buildStripItems(input({}, { piiCategories: ['Email', 'Person', 'cdt_0123456789'] })), 'detection');
            expect(item.summary).toBe('2 of 21 · Balanced');
            expect(item.summaryTone).toBeUndefined();
        });

        it('shows a custom level as its percentage', () => {
            expect(byId(buildStripItems(input({}, { piiConfidenceThreshold: 0.6 })), 'detection').summary)
                .toBe('2 of 21 · Custom (60%)');
        });

        it('turns amber when nothing is looked for', () => {
            const item = byId(buildStripItems(input({}, { piiCategories: [] })), 'detection');
            expect(item.summary).toMatch(/^0 of 21/);
            expect(item.summaryTone).toBe('warn');
        });
    });

    it('step 2 is the Your own data pane\'s own summary', () => {
        expect(byId(buildStripItems(input()), 'owndata').summary).toBe('none yet');
    });

    describe('step 3', () => {
        it('reads replace or stopped', () => {
            expect(byId(buildStripItems(input()), 'processing').summary).toBe('replace with placeholders');
            expect(byId(buildStripItems(input({}, { piiAction: 'block' })), 'processing').summary).toBe('stopped');
        });

        it('turns amber when placeholders are stored but not licensed', () => {
            const item = byId(buildStripItems(input({ licence: { canTokenizePii: false, canUseCustomData: true } })), 'processing');
            expect(item.summaryTone).toBe('warn');
        });
    });

    describe('step 4', () => {
        it('reads the last check alone while outside tools hold kinds back', () => {
            const item = byId(buildStripItems(input({}, { dlpEnabled: true })), 'outbound');
            expect(item).toMatchObject({ summary: 'check on', summaryTone: undefined });
        });

        it('adds "tools open", in amber, when no built-in kind is held back from outside tools', () => {
            // An own type alone does not close the gap for the 21 built-in kinds.
            const item = byId(buildStripItems(input({}, {
                toolPiiPolicy: { external: { blockCategories: ['cdt_0123456789'] } },
            })), 'outbound');
            expect(item).toMatchObject({ summary: 'no last check · tools open', summaryTone: 'warn' });
        });

        it('treats a missing tool policy as open', () => {
            expect(byId(buildStripItems(input({}, { toolPiiPolicy: null })), 'outbound').summary).toMatch(/tools open$/);
        });
    });

    it('disables the four steps while the shield is off, never the two pills', () => {
        const items = buildStripItems(input({}, { enabled: false }));
        expect(items.filter(x => x.disabled).map(x => x.id)).toEqual(['detection', 'owndata', 'processing', 'outbound']);
    });
});


describe('dirtyChips', () => {
    it('names each stage as the strip does and drops unknown ids', () => {
        const chips = dirtyChips([{ id: 'processing', count: 2 }, { id: 'nope', count: 1 }], t);
        expect(chips.map(({ id, label, count }) => ({ id, label, count }))).toEqual([
            { id: 'processing', label: 'When we find something', count: 2 },
        ]);
    });
});
