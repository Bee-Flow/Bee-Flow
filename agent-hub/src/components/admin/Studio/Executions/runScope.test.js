// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { RUN_SCOPES, canOpenRun, effectiveRunScope, normaliseRunScope, runStreamEnabled } from './runScope';

describe('normaliseRunScope — unknown narrows', () => {
    it('is "org" for the exact string and for nothing else', () => {
        expect(normaliseRunScope('org')).toBe('org');
        // Everything a stale storage blob, a typo or a bad prop can be. Each of
        // these landing on 'org' would widen a list without anyone asking.
        for (const bad of [undefined, null, '', 'ORG', 'Org', ' org', 'org ', 'organisation',
            'all', 'everyone', 0, 1, true, {}, [], ['org'], { scope: 'org' }, NaN]) {
            expect(normaliseRunScope(bad), `${JSON.stringify(bad)} must narrow to mine`).toBe('mine');
        }
    });

    it('is idempotent, so a normalised value can be normalised again', () => {
        for (const s of RUN_SCOPES) expect(normaliseRunScope(normaliseRunScope(s))).toBe(normaliseRunScope(s));
    });
});

describe('effectiveRunScope — only the global surface has two scopes', () => {
    it('lets the global executions view be either', () => {
        expect(effectiveRunScope('global', 'org')).toBe('org');
        expect(effectiveRunScope('global', 'mine')).toBe('mine');
        expect(effectiveRunScope('global', undefined)).toBe('mine');
    });

    it('forces "mine" on a per-routine or per-Step surface', () => {
        // The builder's history tab is already about one routine the caller
        // owns. An 'org' left in storage by the Studio section must not follow
        // the user in there and turn it into "this routine's runs by anyone".
        expect(effectiveRunScope('automation', 'org')).toBe('mine');
        expect(effectiveRunScope('step', 'org')).toBe('mine');
        expect(effectiveRunScope(undefined, 'org')).toBe('mine');
        expect(effectiveRunScope(null, 'org')).toBe('mine');
        expect(effectiveRunScope('GLOBAL', 'org')).toBe('mine');
    });
});

describe('canOpenRun — mine is checked FOR TRUE', () => {
    it('opens anything in the personal scope: the endpoint returned nothing else', () => {
        expect(canOpenRun({ id: 'r1' }, 'mine')).toBe(true);
        expect(canOpenRun({ id: 'r1' }, undefined)).toBe(true);
    });

    it('opens only a row the server stamped mine in the org scope', () => {
        expect(canOpenRun({ id: 'r1', mine: true }, 'org')).toBe(true);
        expect(canOpenRun({ id: 'r1', mine: false }, 'org')).toBe(false);
        // An absent field is a server that did not say — and that is not
        // permission. Every per-run route 403s for anyone but the owner, so a
        // row opened on a guess is a dead end with an error in it.
        expect(canOpenRun({ id: 'r1' }, 'org')).toBe(false);
        expect(canOpenRun({ id: 'r1', mine: undefined }, 'org')).toBe(false);
        expect(canOpenRun({ id: 'r1', mine: null }, 'org')).toBe(false);
        // Truthy is not true: an older server sending a string, or a 1, is
        // still a server this build has no contract with.
        expect(canOpenRun({ id: 'r1', mine: 'true' }, 'org')).toBe(false);
        expect(canOpenRun({ id: 'r1', mine: 1 }, 'org')).toBe(false);
        expect(canOpenRun(null, 'org')).toBe(false);
        expect(canOpenRun(undefined, 'org')).toBe(false);
    });
});

describe('runStreamEnabled', () => {
    it('streams in the personal scope and stands down in the org scope', () => {
        // The stream drops other people's events and its polling fallback
        // reads the user-scoped list, so in the org scope it would keep only
        // the viewer's own rows ticking inside everybody's list.
        expect(runStreamEnabled('mine')).toBe(true);
        expect(runStreamEnabled(undefined)).toBe(true);
        expect(runStreamEnabled('org')).toBe(false);
    });
});
