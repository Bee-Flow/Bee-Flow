import { describe, it, expect, beforeEach } from 'vitest';
import {
    applyAlternative, diffAlternative, experimentAttrs, readExperiment, supportsExperiment, resetDraws, resolveBlock, secureRandom, stripExperiment, variantFor,
} from './experiment';

const base = { title: 'Control', lead: 'Same', abKey: 'hero-title', abAlt: { title: 'Alternative' }, abShare: 30, abGoal: 'signup' };

beforeEach(() => resetDraws());

describe('readExperiment', () => {
    it('reads a complete experiment and defaults the share and goal', () => {
        expect(readExperiment(base)).toEqual({ key: 'hero-title', share: 30, goal: 'signup', alt: { title: 'Alternative' } });
        expect(readExperiment({ abKey: 'k', abAlt: { a: 1 } })).toEqual({ key: 'k', share: 50, goal: 'ab_goal', alt: { a: 1 } });
    });
    it('is no experiment without a valid name or a non-empty alternative', () => {
        expect(readExperiment({ title: 'x' })).toBeNull();
        expect(readExperiment({ abKey: 'Bad Name', abAlt: { a: 1 } })).toBeNull();
        expect(readExperiment({ abKey: 'k', abAlt: {} })).toBeNull();
        expect(readExperiment({ abKey: 'k', abAlt: [1] })).toBeNull();
        expect(readExperiment(undefined)).toBeNull();
    });
    it('ignores a share outside 1-99', () => {
        expect(readExperiment({ abKey: 'k', abAlt: { a: 1 }, abShare: 100 })?.share).toBe(50);
    });
});

describe('variants', () => {
    it('draws b below the share and a above it, then keeps the draw for the page view', () => {
        const exp = readExperiment(base)!;
        expect(variantFor(exp, () => 0.29)).toBe('b');
        expect(variantFor(exp, () => 0.99)).toBe('b');
        resetDraws();
        expect(variantFor(exp, () => 0.3)).toBe('a');
    });
    it('secureRandom stays in [0, 1)', () => {
        for (let i = 0; i < 50; i++) {
            const r = secureRandom();
            expect(r).toBeGreaterThanOrEqual(0);
            expect(r).toBeLessThan(1);
        }
    });
    it('stores nothing in the browser', () => {
        const before = [localStorage.length, sessionStorage.length, document.cookie];
        resolveBlock(base, { random: () => 0.1 });
        expect([localStorage.length, sessionStorage.length, document.cookie]).toEqual(before);
    });
});

describe('resolveBlock', () => {
    it('serves the alternative on top of the original for b, and strips the ab fields either way', () => {
        const b = resolveBlock(base, { random: () => 0 });
        expect(b.content).toEqual({ title: 'Alternative', lead: 'Same' });
        expect(b.experiment).toEqual({ key: 'hero-title', variant: 'b', goal: 'signup' });
        resetDraws();
        const a = resolveBlock(base, { random: () => 0.99 });
        expect(a.content).toEqual({ title: 'Control', lead: 'Same' });
        expect(a.experiment?.variant).toBe('a');
    });
    it('always shows the original in the editor preview and draws nothing', () => {
        const r = resolveBlock(base, { preview: true, random: () => 0 });
        expect(r.content).toBe(base);
        expect(r.experiment).toBeNull();
    });
    it('passes a block without an experiment through untouched', () => {
        const c = { title: 'x' };
        expect(resolveBlock(c).content).toBe(c);
    });
});

describe('alternative editing helpers', () => {
    it('diffAlternative keeps only the fields that differ from the original', () => {
        expect(diffAlternative(base, { ...base, title: 'New', lead: 'Same', cta: { label: 'Go' } })).toEqual({ title: 'New', cta: { label: 'Go' } });
    });
    it('applyAlternative never lets ab fields of the alternative through', () => {
        expect(applyAlternative(base, { title: 'T', abKey: 'x' })).toEqual({ title: 'T', lead: 'Same' });
        expect(stripExperiment(base)).toEqual({ title: 'Control', lead: 'Same' });
    });
});

describe('what an alternative may not change', () => {
    const formAlt = {
        title: 'B title',
        consent: { enabled: true, text: 'Different wording' },
        fields: [{ id: 'x', type: 'text' }],
        automationId: 'other',
    };
    it('drops consent, fields and the automation from the alternative of a form', () => {
        const out = applyAlternative({ title: 'A', consent: { text: 'Own' } }, formAlt, 'form');
        expect(out).toEqual({ title: 'B title', consent: { text: 'Own' } });
    });
    it('keeps the consent and the automation fixed for any block type', () => {
        const out = applyAlternative({ title: 'A' }, formAlt, 'hero');
        expect(out.consent).toBeUndefined();
        expect(out.automationId).toBeUndefined();
        expect(out.fields).toEqual(formAlt.fields);
    });
    it('shows no experiment at all on a form or customer-support block', () => {
        for (const type of ['form', 'customer-support']) {
            const r = resolveBlock({ ...base, abAlt: formAlt }, { random: () => 0, type });
            expect(r.experiment).toBeNull();
            expect(r.content).toEqual(stripExperiment({ ...base, abAlt: formAlt }));
        }
    });
    it('knows which block types can run a test', () => {
        expect(supportsExperiment('form')).toBe(false);
        expect(supportsExperiment('customer-support')).toBe(false);
        expect(supportsExperiment('hero')).toBe(true);
    });
});

describe('experimentAttrs', () => {
    it('gives the data attributes of the block wrapper, or nothing', () => {
        expect(experimentAttrs(base, { random: () => 0 })).toEqual({
            'data-cms-experiment': 'hero-title', 'data-cms-variant': 'b', 'data-cms-goal': 'signup',
        });
        expect(experimentAttrs({ title: 'x' })).toEqual({});
        expect(experimentAttrs(base, { preview: true })).toEqual({});
    });
});
