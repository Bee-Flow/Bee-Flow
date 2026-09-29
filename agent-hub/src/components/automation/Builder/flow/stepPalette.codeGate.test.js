import { describe, it, expect } from 'vitest';
import { buildStepGroups, buildSearchResults, itemForKey, codeItemFor, CODE_OFF_REASONS } from './stepPalette';

/**
 * The Code step is offered exactly as honestly as the server answers.
 *
 * `flags.code` is the server's "would a code step RUN here?": the one
 * question execCode asks, codeSandbox.isAvailable(). There is no switch and
 * no per-org beta. When the answer is no, `flags.codeReason` says why and
 * the palette offers the step DISABLED WITH THE REASON, because a missing
 * entry reads as "this product cannot do that" — the same lesson the form
 * pages taught (BFSF-348).
 *
 * The flag itself must stay a BOOLEAN: every call site here reads it for
 * truthiness, so an object would be permanently truthy and would OPEN the gate.
 */
const catalogWith = (flags) => ({ apps: [], steps: [], flags });

const integrations = (catalog) => buildStepGroups({ catalog })
    .find(g => g.key === 'flow').sections.find(s => s.key === 'integrations').items;
const codeIn = (catalog) => integrations(catalog).find(i => i.id === 'code') || null;
const codeHit = (catalog) => buildSearchResults('code', { catalog }).find(r => r.key === 'code') || null;

describe('stepPalette — the code step says what the runner would say', () => {
    it('offers it for real when the server says yes', () => {
        const catalog = catalogWith({ code: true, codeReason: null });
        const item = codeIn(catalog);
        expect(item).toBeTruthy();
        expect(item.disabled).toBeUndefined();
        expect(codeHit(catalog).disabled).toBeUndefined();
    });

    it('no sandbox on the server: shown DISABLED with the reason, not dropped', () => {
        const catalog = catalogWith({ code: false, codeReason: 'runtime' });
        const item = codeIn(catalog);
        expect(item).toBeTruthy();
        expect(item.disabled).toBe(true);
        expect(item.disabledReason).toBe(CODE_OFF_REASONS.runtime);
        expect(item.disabledReason).toMatch(/without the code sandbox/i);
    });

    it('has no switch to send anyone to: code steps have no platform or workspace setting', () => {
        expect(Object.keys(CODE_OFF_REASONS).sort()).toEqual(['runtime', 'unknown']);
        for (const text of Object.values(CODE_OFF_REASONS)) expect(text).not.toMatch(/administrator|switch|enable/i);
        // An older server that still says 'platform' or 'org' is a definite no,
        // told as "did not say" rather than naming a switch that is gone.
        for (const reason of ['platform', 'org']) {
            expect(codeIn(catalogWith({ code: false, codeReason: reason })).disabledReason).toBe(CODE_OFF_REASONS.unknown);
        }
    });

    it('says the same thing in search, rather than returning nothing', () => {
        const hit = codeHit(catalogWith({ code: false, codeReason: 'runtime' }));
        expect(hit).toBeTruthy();
        expect(hit.disabled).toBe(true);
        expect(hit.disabledReason).toBe(CODE_OFF_REASONS.runtime);
    });

    it('carries every reason the server can send, and falls back rather than showing nothing', () => {
        for (const reason of ['runtime', 'unknown']) {
            expect(codeIn(catalogWith({ code: false, codeReason: reason })).disabledReason)
                .toBe(CODE_OFF_REASONS[reason]);
        }
        // A reason string this build has never heard of is still a definite
        // "no" — it must not fall through to an addable step.
        const odd = codeIn(catalogWith({ code: false, codeReason: 'licence_expired' }));
        expect(odd.disabled).toBe(true);
        expect(odd.disabledReason).toBe(CODE_OFF_REASONS.unknown);
    });

    it('a catalog that says nothing makes no claim — no entry at all', () => {
        // Tri-state, like gated()'s hasFormTrigger: nothing loaded yet, or an
        // older server that sends no reason, is not an answer. Unchanged
        // behaviour for both.
        expect(codeIn(catalogWith({}))).toBeNull();
        expect(codeIn(null)).toBeNull();
        expect(codeHit(catalogWith({}))).toBeNull();
        expect(codeIn(catalogWith({ code: false }))).toBeNull();
    });

    it('the "Frequently used" / "Suggested next" shortcut asks the same question', () => {
        // itemForKey resolved 'step:code' out of ALL_STATIC_ITEMS with no flag
        // consulted, so a user who used code steps elsewhere still got an
        // addable Code shortcut on an install without the sandbox: the
        // trap this whole change exists to close, one row higher up.
        expect(itemForKey('step:code', { catalog: catalogWith({ code: true }) }).payload.kind).toBe('code');
        // A definite no: no shortcut. It is dropped rather than stamped
        // `disabled` because AddStepRibbon's Frequent cluster renders these
        // items always-clickable — see the comment at the call site. The step
        // stays visible WITH its reason in the palette's Integrations section,
        // which this same catalog proves.
        for (const reason of ['runtime', 'unknown']) {
            const cat = catalogWith({ code: false, codeReason: reason });
            expect(itemForKey('step:code', { catalog: cat }), `${reason} still offered a shortcut`).toBeNull();
            expect(codeIn(cat).disabled, `${reason} lost its palette entry`).toBe(true);
        }
        // An older server's bare `code: false` is a definite no too, and a
        // catalog that has not loaded is not an answer — neither may hand out
        // an addable shortcut.
        expect(itemForKey('step:code', { catalog: catalogWith({ code: false }) })).toBeNull();
        expect(itemForKey('step:code', { catalog: null })).toBeNull();
        // Every other usage key is untouched by this branch.
        expect(itemForKey('step:loop', { catalog: catalogWith({}) })).toBeTruthy();
        expect(itemForKey('step:guard', { catalog: catalogWith({ code: false, codeReason: 'runtime' }) })).toBeTruthy();
    });

    it('an object-shaped flag cannot open the gate it was widened to close', () => {
        // The trap. `flags.code = {sandbox:false}` is truthy, so every
        // `if (flags.code)` would pass, including on the installs the object
        // was added to exclude. Only the literal `true` produces an
        // ADDABLE step; anything else with a reason beside it is the disabled
        // entry.
        const objectish = codeItemFor(catalogWith({ code: { sandbox: false }, codeReason: 'runtime' }));
        expect(objectish.disabled).toBe(true);
        expect(objectish.disabledReason).toBe(CODE_OFF_REASONS.runtime);
        expect(codeItemFor(catalogWith({ code: false, codeReason: 'runtime' })).disabled).toBe(true);
        // And the boolean yes is still a yes.
        expect(codeItemFor(catalogWith({ code: true })).disabled).toBeUndefined();
    });
});
