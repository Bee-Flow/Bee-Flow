import { describe, it, expect } from 'vitest';

import { STEP_OF, derivePosture, reviewItems } from './orgShieldPosture';

/**
 * Pure module, so these assert on `tone` and the structured `value` rather
 * than on copy. The rows worth testing are the ones that flag a state the old
 * page rendered as if it were fine.
 */

const CATEGORIES = Array.from({ length: 21 }, (_, i) => ({ id: `c${i}` }));

const BASE = {
    enabled: true,
    piiCategories: ['c0', 'c1'],
    piiConfidenceThreshold: 0.7,
    piiAction: 'block',
    showRawPayload: false,
    applyToAutomations: true,
    dlpEnabled: false,
    dlpMode: 'ask',
    webSearchGuard: false,
    euModeEnabled: false,
    toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] } },
    customDataTypes: [],
    piiAllowTerms: [],
    piiAllowPublicOrgs: true,
};

const derive = (over = {}, opts = {}) => derivePosture(
    { ...BASE, ...over },
    { categories: CATEGORIES, env: {}, licence: {}, ...opts },
);

const rowById = (result, id) => result.rows.find(r => r.id === id);

describe('derivePosture', () => {
    it('reports a disabled shield as off, with no rows to explain', () => {
        const result = derive({ enabled: false });
        expect(result.off).toBe(true);
        expect(result.rows).toEqual([]);
    });

    it('flags "shield on, zero categories" — detection that can never fire', () => {
        const result = derive({ piiCategories: [] });
        expect(rowById(result, 'categories').tone).toBe('warn');
        expect(rowById(result, 'categories').value).toEqual({ n: 0, total: 21 });
    });

    it('does not flag a normal category selection', () => {
        expect(rowById(derive(), 'categories').tone).toBe('ok');
    });

    it('reports a preset by id and a custom threshold as a percentage', () => {
        expect(rowById(derive({ piiConfidenceThreshold: 0.45 }), 'sensitivity').value)
            .toEqual({ presetId: 'high' });
        expect(rowById(derive({ piiConfidenceThreshold: 0.62 }), 'sensitivity').value)
            .toEqual({ customPct: 62 });
    });

    it('flags tokenize stored against a licence that no longer includes it', () => {
        // The state that used to render as "no action card selected" with no
        // explanation at all: the server does not clamp this field, so the row
        // really is tokenize while the runtime blocks.
        const result = derive({ piiAction: 'tokenize' }, { licence: { canTokenizePii: false } });
        const row = rowById(result, 'action');
        expect(row.tone).toBe('warn');
        expect(row.value).toEqual({ action: 'tokenize', unlicensed: true });
    });

    it('does not flag tokenize when the licence allows it', () => {
        const result = derive({ piiAction: 'tokenize' }, { licence: { canTokenizePii: true } });
        expect(rowById(result, 'action').tone).toBe('ok');
        expect(rowById(result, 'action').value.unlicensed).toBe(false);
    });

    it('treats transparency as off whenever the action is not tokenize', () => {
        // showRawPayload can be stored true while the control is not rendered.
        const result = derive({ piiAction: 'block', showRawPayload: true });
        expect(rowById(result, 'transparency').value).toEqual({ on: false });
    });

    it('reports the DLP mode only while DLP is on', () => {
        expect(rowById(derive({ dlpEnabled: false, dlpMode: 'block' }), 'dlp').value)
            .toEqual({ on: false, mode: null });
        expect(rowById(derive({ dlpEnabled: true, dlpMode: 'auto_redact' }), 'dlp').value)
            .toEqual({ on: true, mode: 'auto_redact' });
    });

    it('counts both tool classes against the catalog total', () => {
        const result = derive({
            toolPiiPolicy: { external: { blockCategories: ['c0'] }, internal: { blockCategories: ['c0', 'c1'] } },
        });
        const row = rowById(result, 'toolcalls');
        expect(row.value.external).toBe(1);
        expect(row.value.internal).toBe(2);
        expect(row.value.total).toBe(21);
        // Change goes to the matrix, where "may a tool carry this" now sits
        // beside "do we even look for this".
        expect(row.tab).toBe('detection');
    });

    it('names the org\'s own types, not just a count, and sends Change to their tab', () => {
        const result = derive({
            customDataTypes: [
                { id: 'cdt_0000000001', name: 'AURORA', method: 'words' },
                { id: 'cdt_0000000002', name: 'Contractnummer', method: 'pattern' },
                { id: 'cdt_0000000003', name: 'Derde', method: 'ai' },
            ],
        });
        // Two is what fits on one line once the label is translated.
        const row = rowById(result, 'customterms');
        expect(row.value).toEqual({ n: 3, sample: ['AURORA', 'Contractnummer'] });
        expect(row.tab).toBe('owndata');
    });

    it('does not count the org\'s own type ids as built-in kinds', () => {
        // The switches of "Your own data" are ids in the same lists. Counted
        // here they would read "3 of 21", or clear the zero-kinds warning.
        const result = derive({
            piiCategories: ['cdt_0000000001'],
            toolPiiPolicy: { external: { blockCategories: ['c1', 'cdt_0000000001'] }, internal: { blockCategories: ['cdt_0000000001'] } },
        });
        expect(rowById(result, 'categories').value).toEqual({ n: 0, total: 21 });
        expect(rowById(result, 'categories').tone).toBe('warn');
        expect(rowById(result, 'toolcalls').value.external).toBe(1);
        expect(rowById(result, 'toolcalls').value.internal).toBe(0);
    });

    it('only mentions web search and EU models when they are configured at all', () => {
        expect(rowById(derive(), 'websearch')).toBeUndefined();
        expect(rowById(derive(), 'eu')).toBeUndefined();
        const withEnv = derive({}, { env: { hasWebSearchEnabled: true, hasEuModelsConfigured: true } });
        expect(rowById(withEnv, 'websearch')).toBeDefined();
        expect(rowById(withEnv, 'eu')).toBeDefined();
    });

    it('notes an active never-redact list without calling it an error', () => {
        expect(rowById(derive(), 'allowlist').tone).toBe('ok');
        const withTerms = derive({ piiAllowTerms: ['Microsoft'] });
        // A deliberate exception, not a misconfiguration — but the one control
        // that makes the shield leak on purpose, so it gets pointed at.
        expect(rowById(withTerms, 'allowlist').tone).toBe('note');
        expect(rowById(withTerms, 'allowlist').value).toEqual({ terms: 1, publicOrgs: true });
    });

    it('puts an unreachable guard first, as an error', () => {
        const result = derive({}, { guard: { configured: true, reachable: false } });
        expect(result.rows[0].id).toBe('guard');
        expect(result.rows[0].tone).toBe('error');
        // No tab to jump to: this is not fixed on this screen.
        expect(result.rows[0].tab).toBeNull();
    });

    it('says nothing about a healthy guard', () => {
        const result = derive({}, { guard: { configured: true, reachable: true } });
        expect(rowById(result, 'guard')).toBeUndefined();
    });

    // ── Evidence sharpens two rows, and only those two ───────────────────
    //
    // "EU-hosted AI only: Off" is not a finding by itself — plenty of orgs run
    // one model and it is in Frankfurt. It becomes one once calls have in fact
    // carried personal data out of Europe.
    describe('with egress evidence', () => {
        const ENV = { env: { hasEuModelsConfigured: true } };

        it('leaves EU-only and the tool lists plain when nothing has left Europe', () => {
            const result = derive({}, { ...ENV, egress: { piiNonEuCount: 0 } });
            expect(rowById(result, 'eu').tone).toBe('ok');
            expect(rowById(result, 'toolcalls').tone).toBe('ok');
            expect(rowById(result, 'toolcalls').value.leakedCount).toBeNull();
        });

        it('treats missing evidence as unknown rather than as zero', () => {
            // No licence for the monitoring endpoints, or a stack whose API
            // predates them. Claiming "nothing left Europe" would be a lie.
            const result = derive({}, ENV);
            expect(rowById(result, 'eu').tone).toBe('ok');
            expect(rowById(result, 'toolcalls').value.leakedCount).toBeNull();
        });

        it('flags both rows once personal data actually went abroad', () => {
            const result = derive({}, {
                ...ENV,
                egress: { piiNonEuCount: 14, piiCategories: ['Email', 'Person'] },
            });
            expect(rowById(result, 'eu').tone).toBe('warn');
            const tools = rowById(result, 'toolcalls');
            expect(tools.tone).toBe('warn');
            expect(tools.value.leakedCount).toBe(14);
            expect(tools.value.leakedCategories).toEqual(['Email', 'Person']);
        });

        it('stops flagging EU-only once it is actually on', () => {
            const result = derive({ euModeEnabled: true }, { ...ENV, egress: { piiNonEuCount: 14 } });
            expect(rowById(result, 'eu').tone).toBe('ok');
            // The tool row still flags: EU-only governs MODELS, so turning it
            // on does not stop a connected app from carrying a name to Iowa.
            expect(rowById(result, 'toolcalls').tone).toBe('warn');
        });
    });

    describe('attention count', () => {
        it('counts the warn and error rows, and nothing else', () => {
            // note-toned rows (an active allowlist, transparency on) are
            // deliberate choices, not findings — they must not inflate a badge
            // that an admin reads as a to-do list.
            const quiet = derive({ piiAllowTerms: ['Microsoft'], piiAction: 'tokenize', showRawPayload: true },
                { licence: { canTokenizePii: true } });
            expect(quiet.attention).toBe(0);

            const noisy = derive({ piiCategories: [] }, {
                env: { hasEuModelsConfigured: true },
                guard: { configured: true, reachable: false },
                egress: { piiNonEuCount: 14 },
            });
            // zero categories + unreachable guard + EU-only off + tools leaking
            expect(noisy.attention).toBe(4);
        });

        it('is zero while the shield is off — there is nothing to attend to', () => {
            expect(derive({ enabled: false }).attention).toBe(0);
        });
    });

    describe('review list', () => {
        it('offers a last check that is off, without calling it attention', () => {
            const result = derive({ dlpEnabled: false });
            expect(rowById(result, 'dlp').tone).toBe('suggest');
            expect(result.attention).toBe(0);
            expect(result.review).toBe(1);
            expect(rowById(derive({ dlpEnabled: true }), 'dlp').tone).toBe('ok');
        });

        it('lists error, then warn, then note, then suggest — and counts exactly those', () => {
            const result = derive(
                { piiCategories: [], piiAction: 'tokenize', showRawPayload: true, dlpEnabled: false },
                { licence: { canTokenizePii: true }, guard: { configured: true, reachable: false } },
            );
            expect(reviewItems(result).map(r => r.id)).toEqual(['guard', 'categories', 'transparency', 'dlp']);
            expect(result.review).toBe(4);
            expect(result.attention).toBe(2);
        });

        it('is empty while the shield is off', () => {
            const off = derive({ enabled: false });
            expect(off.review).toBe(0);
            expect(reviewItems(off)).toEqual([]);
        });
    });

    describe('knowledge bases', () => {
        it('reads an absent setting as on, like the server does', () => {
            expect(rowById(derive(), 'knowledge').value).toEqual({ on: true });
            expect(rowById(derive({ scanKnowledgeBases: false }), 'knowledge').value).toEqual({ on: false });
            expect(rowById(derive(), 'knowledge').tab).toBe('processing');
        });
    });

    it('edits the never-hide list next to the org\'s own types', () => {
        expect(rowById(derive(), 'allowlist').tab).toBe('owndata');
    });

    it('carries every tool call with personal data beside the leak count, and null when unknown', () => {
        expect(rowById(derive({}, { egress: { piiNonEuCount: 2, toolPii: 9 } }), 'toolcalls').value.toolPii).toBe(9);
        expect(rowById(derive(), 'toolcalls').value.toolPii).toBeNull();
    });

    it('puts every non-guard row under a numbered step', () => {
        const ids = derive({}, { env: { hasEuModelsConfigured: true, hasWebSearchEnabled: true } }).rows.map(r => r.id);
        for (const id of ids) expect(STEP_OF[id]).toBeGreaterThanOrEqual(1);
    });
});
