import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { BROWSER_STEPS, browserStepFor, buildBrowserSteps } from './browserSteps';
import { MAX_WAIT_SECONDS } from './browserSteps/wait';
import { createScreenTrail } from './screenTrail';
import { definitionReadsUi, mentionsUiRoot } from '../uiState';

const require = createRequire(import.meta.url);
const registry = require('../../../../../../../../server/appStudio/componentSpecs/stepRegistry.js') as {
    EXTENSION_STEP_ENTRIES: Array<{ kind: string; side: string }>;
};
const { LIMITS } = require('../../../../../../../../server/appStudio/componentSpecs/limits.js') as { LIMITS: Record<string, number> };

/**
 * The browser runners under browserSteps/ and the server's client kinds of the
 * step registry (server/appStudio/componentSpecs/steps/ with side 'client') name
 * the same kinds: a client kind without a runner would be a step that silently
 * does nothing.
 */
describe('browserSteps: one runner per client kind of the step registry', () => {
    it('has exactly the registry client kinds', () => {
        const client = registry.EXTENSION_STEP_ENTRIES.filter((e) => e.side === 'client').map((e) => e.kind).sort();
        expect(Object.keys(BROWSER_STEPS).sort()).toEqual(client);
    });

    it('holds the browser wait to the definition limit', () => {
        expect(MAX_WAIT_SECONDS).toBe(LIMITS.MAX_CLIENT_WAIT_SECONDS);
    });

    it('answers null for a kind it has no runner for, and refuses a file that names another kind', () => {
        expect(browserStepFor('navigate')).toBeNull();
        expect(browserStepFor(undefined)).toBeNull();
        expect(browserStepFor('__proto__')).toBeNull();
        expect(() => buildBrowserSteps({ './browserSteps/a.ts': { default: { kind: 'b', run: () => {} } } })).toThrow(/own kind/);
    });
});

describe('screenTrail: the screens a back step returns to', () => {
    it('remembers each screen left, by id and params, and walks back without swinging', () => {
        const trail = createScreenTrail();
        expect(trail.back()).toBeNull();
        trail.observe({ id: 'a', params: {} });
        trail.observe({ id: 'a', params: {} });
        trail.observe({ id: 'b', params: { r: 1 } });
        trail.observe({ id: 'c' });
        expect(trail.back()).toEqual({ id: 'b', params: { r: 1 } });
        trail.observe({ id: 'b', params: { r: 1 } });
        expect(trail.back()).toEqual({ id: 'a', params: {} });
        trail.observe({ id: 'a', params: {} });
        expect(trail.back()).toBeNull();
    });

    it('ignores what is not a screen, and keeps at most its maximum', () => {
        const trail = createScreenTrail(2);
        for (const s of [null, 'x', { id: '' }, { id: 1 }]) trail.observe(s);
        for (const id of ['a', 'b', 'c', 'd']) trail.observe({ id });
        expect(trail.back()?.id).toBe('c');
        expect(trail.back()?.id).toBe('b');
        expect(trail.back()).toBeNull();
    });
});

describe('definitionReadsUi: only a definition that names the ui root subscribes', () => {
    it('finds ui. as a root, not as the tail of another name', () => {
        expect(mentionsUiRoot('ui.tabs.x.active')).toBe(true);
        expect(mentionsUiRoot('count(ui.selection.g) > 0')).toBe(true);
        for (const text of ['gui.x', 'vars.ui.x', 'my_ui.x', '$ui.x', 'ui', 'UI.x']) expect(mentionsUiRoot(text)).toBe(false);
    });

    it('scans the whole definition once per object', () => {
        const reads = { screens: [{ sections: [{ children: [{ computed: { text: 'ui.modals.m.open' } }] }] }] };
        expect(definitionReadsUi(reads)).toBe(true);
        expect(definitionReadsUi({ screens: [], actions: { a: { kind: 'sequence', steps: [{ kind: 'set_ui', nodeId: 'gui' }] } } })).toBe(false);
        expect(definitionReadsUi(null)).toBe(false);
    });
});
