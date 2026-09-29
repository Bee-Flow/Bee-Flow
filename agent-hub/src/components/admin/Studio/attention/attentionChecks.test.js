// Unit tests for the "Needs attention" register (attentionChecks.js).
//
// Two halves, deliberately:
//   - the PURE reader and summariser, driven with plain objects carrying the
//     exact body GET /api/studio/attention answers with;
//   - the runner, driven through a stubbed authFetch, so the gates, the
//     per-check isolation and the named gaps are exercised the way the screen
//     will hit them.
//
// The three rules this file exists to keep honest:
//   1. "found nothing" and "could not look" are different verdicts;
//   2. a finding the client cannot draw is COUNTED, not dropped;
//   3. severity orders the list, the source never does.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args) => fetchMock(...args),
}));

import {
    ATTENTION_CHECKS, AVAILABILITY, SOURCE_LABELS, SOURCE_ORDER,
    attentionSourceNames, checkAvailability, evaluateStudioAttention,
    normaliseAttentionRow, runAttentionChecks, runCheck, sortFindings,
    summarizeAttention,
} from './attentionChecks';

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const ADMIN = { id: 'u1', permissions: ['all'] };
const MEMBER = { id: 'u2', permissions: [] };

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status = 500) => ({ ok: false, status, json: async () => ({}) });

const answers = (body) => fetchMock.mockImplementation(async () => (typeof body === 'function' ? body() : ok(body)));

/** A row exactly as routes/studio/attention.js toRow builds it. */
const row = (over = {}) => ({
    source: 'solutionBlocked',
    code: 'solution.blocked',
    severity: 'error',
    kind: 'solution',
    targetId: 'p1',
    message: '"Onboarding" cannot be published yet: 2 findings need a person.',
    deepLink: null,
    ...over,
});

const EMPTY_BODY = { rows: [], total: 0, sources: {}, unavailable: [], gated: [], complete: true };

/* ── Reading one row ─────────────────────────────────────────────────────── */

describe('normaliseAttentionRow', () => {
    it('keeps every field the screen draws from', () => {
        expect(normaliseAttentionRow(row({ remediation: 'Open it', deepLink: '/app/studio/solutions/p1' }))).toEqual({
            source: 'solutionBlocked',
            code: 'solution.blocked',
            severity: 'error',
            kind: 'solution',
            targetId: 'p1',
            message: '"Onboarding" cannot be published yet: 2 findings need a person.',
            remediation: 'Open it',
            deepLink: '/app/studio/solutions/p1',
        });
    });

    it('refuses a row it cannot place, and keeps null ids nullable', () => {
        expect(normaliseAttentionRow(row({ code: '' }))).toBeNull();
        expect(normaliseAttentionRow(row({ severity: 'catastrophe' }))).toBeNull();
        expect(normaliseAttentionRow(null)).toBeNull();
        // A producer that only saw a definition has no row to point at, and
        // null must not become the string 'null'.
        expect(normaliseAttentionRow(row({ targetId: null })).targetId).toBeNull();
        expect(normaliseAttentionRow(row({ targetId: 7 })).targetId).toBe('7');
        // Blank text is no text.
        expect(normaliseAttentionRow(row({ message: '   ' })).message).toBeNull();
    });
});

/* ── Reading the body ────────────────────────────────────────────────────── */

describe('evaluateStudioAttention', () => {
    it('carries the rows, the gaps and the gated sources through unchanged', () => {
        const verdict = evaluateStudioAttention({
            rows: [row()],
            total: 1,
            unavailable: ['appValidation'],
            gated: ['solutionBlocked'],
            complete: false,
        });
        expect(verdict.findings).toHaveLength(1);
        expect(verdict.unavailable).toEqual(['appValidation']);
        expect(verdict.skipped).toEqual(['solutionBlocked']);
        expect(verdict.complete).toBe(false);
        expect(verdict.truncated).toBe(0);
    });

    it('a body with no rows array is a gap, not an organisation with nothing wrong', () => {
        expect(evaluateStudioAttention({}).unavailable).toEqual(['body']);
        expect(evaluateStudioAttention({}).complete).toBe(false);
        expect(evaluateStudioAttention(null).findings).toEqual([]);
        expect(evaluateStudioAttention('nonsense').unavailable).toEqual(['body']);
    });

    it('counts what the endpoint found beyond its cap, and what it could not read', () => {
        const verdict = evaluateStudioAttention({
            rows: [row(), row({ code: '' })], // one good row, one unreadable
            total: 23,
            unavailable: [], gated: [], complete: true,
        });
        expect(verdict.findings).toHaveLength(1);
        // 21 found-not-sent + 1 sent-but-unreadable.
        expect(verdict.truncated).toBe(22);
    });

    it('never lets a nonsense total shrink the problem', () => {
        const verdict = evaluateStudioAttention({ rows: [row(), row()], total: 0, complete: true });
        expect(verdict.truncated).toBe(0);
        expect(evaluateStudioAttention({ rows: [row()], complete: true }).truncated).toBe(0);
    });

    it('takes `complete` from the server, and only an explicit true', () => {
        expect(evaluateStudioAttention({ rows: [], complete: true }).complete).toBe(true);
        // An answer from a build that predates the field: unknown narrows.
        expect(evaluateStudioAttention({ rows: [] }).complete).toBe(false);
        expect(evaluateStudioAttention({ rows: [], complete: 'yes' }).complete).toBe(false);
    });
});

/* ── Gates ───────────────────────────────────────────────────────────────── */

describe('checkAvailability — unknown narrows', () => {
    // The register declares no gate today (the endpoint gates its own six
    // sources); these pin the contract the next entry will be resolved by.
    const permissioned = { gate: { permission: 'manage_agents' } };
    const licensed = { gate: { feature: 'projects' } };

    it('runs an ungated check for anybody', () => {
        expect(checkAvailability(ATTENTION_CHECKS.studio, {})).toBe(AVAILABILITY.READY);
        expect(checkAvailability({}, {})).toBe(AVAILABILITY.READY);
    });

    it('a resolvable "no" is GATED — not yours, and not a gap', () => {
        expect(checkAvailability(permissioned, { user: MEMBER })).toBe(AVAILABILITY.GATED);
        expect(checkAvailability(licensed, { user: ADMIN, hasFeature: () => false })).toBe(AVAILABILITY.GATED);
    });

    it('an UNRESOLVABLE gate is unknown, never open and never empty', () => {
        // No user object: checkPermission would answer false, which reads the
        // same as "you may not". It is not the same, so it is not said.
        expect(checkAvailability(permissioned, { hasFeature: () => true })).toBe(AVAILABILITY.UNKNOWN);
        // No hasFeature: actionChecks lets a feature gate pass here. Inverted.
        expect(checkAvailability(licensed, { user: ADMIN })).toBe(AVAILABILITY.UNKNOWN);
    });

    it('lets a permitted user through', () => {
        expect(checkAvailability(permissioned, { user: ADMIN })).toBe(AVAILABILITY.READY);
        expect(checkAvailability(licensed, { user: ADMIN, hasFeature: () => true })).toBe(AVAILABILITY.READY);
    });
});

/* ── Sorting ─────────────────────────────────────────────────────────────── */

describe('sortFindings — severity decides, the source does not', () => {
    it('puts a blocking Solution above an empty knowledge base above advice', () => {
        const advice = { code: 'agent.no_knowledge_base', severity: 'info', source: 'agentNoKb', message: 'A' };
        const warn = { code: 'knowledge_base.empty_in_use', severity: 'warning', source: 'kbEmptyInUse', message: 'B' };
        const block = { code: 'solution.blocked', severity: 'error', source: 'solutionBlocked', message: 'C' };
        // Handed over in SOURCE order — which is the reverse of the right one.
        expect(SOURCE_ORDER.indexOf('agentNoKb')).toBeLessThan(SOURCE_ORDER.indexOf('solutionBlocked'));
        expect(sortFindings([advice, warn, block]).map((f) => f.code))
            .toEqual(['solution.blocked', 'knowledge_base.empty_in_use', 'agent.no_knowledge_base']);
    });

    it('breaks a tie by source and then by sentence, so the list never shuffles', () => {
        const a = { code: 'x', severity: 'warning', source: 'kbEmptyInUse', message: 'Beta' };
        const b = { code: 'x', severity: 'warning', source: 'kbEmptyInUse', message: 'Alpha' };
        const c = { code: 'x', severity: 'warning', source: 'appValidation', message: 'Zulu' };
        expect(sortFindings([a, b, c]).map((f) => f.message)).toEqual(['Zulu', 'Alpha', 'Beta']);
    });

    it('a source this build has never heard of sorts last, not first', () => {
        const known = { code: 'x', severity: 'warning', source: 'appValidation', message: 'A' };
        const alien = { code: 'y', severity: 'warning', source: 'somethingNew', message: 'B' };
        expect(sortFindings([alien, known]).map((f) => f.code)).toEqual(['x', 'y']);
    });
});

/* ── The screen's view of a run ──────────────────────────────────────────── */

describe('summarizeAttention', () => {
    const state = (findings, rest = {}) => ({
        findings, unavailable: [], complete: true, checked: [], skipped: [], truncated: 0, ...rest,
    });
    const finding = (over = {}) => normaliseAttentionRow(row(over));

    it('a kind this build cannot draw is COUNTED, never dropped', () => {
        // 'notebook' is a real object in the product and NOT one of the ten
        // kinds kindColors paints — the server folds it onto another kind for
        // exactly this reason. A build that has not learned it must say so.
        const foreign = finding({ kind: 'notebook', code: 'notebook.stale', source: 'appValidation' });
        const view = summarizeAttention(state([finding(), foreign]));
        expect(view.items.map((i) => i.finding.code)).toEqual(['solution.blocked']);
        expect(view.hidden).toBe(1);
        expect(view.total).toBe(2);
    });

    it('a row with no sentence falls back to its source line, not to silence', () => {
        const view = summarizeAttention(state([finding({ message: null, source: 'kbSourceError', kind: 'kb' })]));
        expect(view.hidden).toBe(0);
        expect(view.items[0].message).toBeNull();
        expect(view.items[0].labelKey).toBe(SOURCE_LABELS.kbSourceError.key);
    });

    it('a row with neither a sentence nor a known source is counted, not rendered', () => {
        const view = summarizeAttention(state([finding({ message: null, source: 'somethingNew' })]));
        expect(view.items).toEqual([]);
        expect(view.hidden).toBe(1);
    });

    it('the total is what was FOUND: drawn, undrawable and capped alike', () => {
        const view = summarizeAttention(state([finding()], { truncated: 4 }));
        expect(view.items).toHaveLength(1);
        expect(view.truncated).toBe(4);
        expect(view.total).toBe(5);
    });

    it('passes `complete` through, and knows nothing about a run it never got', () => {
        expect(summarizeAttention(state([], { complete: false })).complete).toBe(false);
        // No run at all is NOT a clean bill of health.
        expect(summarizeAttention(null).complete).toBe(false);
        expect(summarizeAttention(undefined).items).toEqual([]);
    });
});

/* ── One entry ───────────────────────────────────────────────────────────── */

describe('runCheck — the three answers, in order', () => {
    const asked = vi.fn();
    const fixture = (gate) => ({
        gate,
        fetchState: async (ctx) => { asked(ctx); return { rows: [row()], total: 1, unavailable: [], gated: [], complete: true }; },
        evaluate: evaluateStudioAttention,
    });

    beforeEach(() => { asked.mockReset(); });

    it('a closed gate asks nothing, produces no rows and is NOT a gap — but it SAYS SO', async () => {
        const result = await runCheck('x', fixture({ permission: 'manage_agents' }), { user: MEMBER });
        expect(result).toMatchObject({ availability: AVAILABILITY.GATED, findings: [], gaps: [], whole: true });
        // Not a gap, but not invisible either. Without its own key in
        // `skipped` a gated entry leaves no trace at all — no rows, no gap, no
        // footnote — and the list would print "Nothing needs attention" over a
        // check that never ran. The endpoint pushes the same key onto
        // `gated[]` for the same reason.
        expect(result.skipped).toEqual(['x']);
        // "Just to be sure" is how a client 403s its way through a permission.
        expect(asked).not.toHaveBeenCalled();
    });

    it('a run made only of gated entries reaches the screen as SKIPPED, never as silence', async () => {
        const only = { studio: fixture({ permission: 'manage_agents' }) };
        const state = await runAttentionChecks({ user: MEMBER }, only);
        expect(state.findings).toEqual([]);
        expect(state.unavailable).toEqual([]);
        expect(state.skipped).toEqual(['studio']);
        const view = summarizeAttention(state);
        expect(view.skipped).toEqual(['studio']);
    });

    it('a gate it cannot answer asks nothing either, and IS a gap', async () => {
        const result = await runCheck('x', fixture({ feature: 'projects' }), { user: ADMIN });
        expect(result).toMatchObject({ availability: AVAILABILITY.UNKNOWN, gaps: ['x:gate'], whole: false });
        expect(asked).not.toHaveBeenCalled();
    });

    it('an open gate runs the check and hands it the caller\'s context', async () => {
        const ctx = { user: ADMIN, hasFeature: () => true };
        const result = await runCheck('x', fixture({ feature: 'projects' }), ctx);
        expect(result).toMatchObject({ availability: AVAILABILITY.READY, whole: true });
        expect(result.findings).toHaveLength(1);
        expect(asked).toHaveBeenCalledWith(ctx);
    });

    it('never throws: a fetch that blows up becomes a gap named after the check', async () => {
        const boom = { fetchState: async () => { throw new Error('nope'); }, evaluate: evaluateStudioAttention };
        await expect(runCheck('x', boom, {})).resolves.toMatchObject({
            availability: 'failed', error: 'nope', gaps: ['x'], whole: false,
        });
    });
});

/* ── The runner ──────────────────────────────────────────────────────────── */

describe('runAttentionChecks', () => {
    beforeEach(() => { fetchMock.mockReset(); });

    it('asks the aggregate and sorts what comes back by severity', async () => {
        answers({
            rows: [
                row({ source: 'agentNoKb', code: 'agent.no_knowledge_base', severity: 'info', kind: 'agent', targetId: 'a1', message: 'A' }),
                row({ source: 'kbEmptyInUse', code: 'knowledge_base.empty_in_use', severity: 'warning', kind: 'kb', targetId: 'k1', message: 'K' }),
                row(),
            ],
            total: 3, unavailable: [], gated: [], complete: true,
        });
        const run = await runAttentionChecks({ user: ADMIN, hasFeature: () => true });
        expect(fetchMock.mock.calls[0][0]).toBe('/api/studio/attention');
        expect(run.findings.map((f) => f.code)).toEqual([
            'solution.blocked', 'knowledge_base.empty_in_use', 'agent.no_knowledge_base',
        ]);
        expect(run.complete).toBe(true);
        expect(run.unavailable).toEqual([]);
        expect(run.checked).toEqual(['studio']);
    });

    it('an empty answer that checked everything is the ONE clean state', async () => {
        answers(EMPTY_BODY);
        const run = await runAttentionChecks({ user: ADMIN });
        expect(run.findings).toEqual([]);
        expect(run.complete).toBe(true);
        expect(run.skipped).toEqual([]);
    });

    it('an endpoint that did not answer is a gap, never a clean bill of health', async () => {
        answers(() => fail(500));
        const run = await runAttentionChecks({ user: ADMIN });
        expect(run.findings).toEqual([]);
        expect(run.unavailable).toEqual(['studio']);
        expect(run.complete).toBe(false);
        expect(run.checked).toEqual([]);
    });

    it('a source the SERVER could not read is named, and its rows still stand', async () => {
        answers({ rows: [row()], total: 1, unavailable: ['kbSourceError'], gated: [], complete: false });
        const run = await runAttentionChecks({ user: ADMIN });
        expect(run.findings).toHaveLength(1);
        expect(run.unavailable).toEqual(['studio:kbSourceError']);
        expect(run.complete).toBe(false);
    });

    it('a gated source is skipped, and skipping is not a gap', async () => {
        answers({ rows: [], total: 0, unavailable: [], gated: ['agentNoKb', 'appValidation'], complete: true });
        const run = await runAttentionChecks({ user: MEMBER });
        expect(run.skipped).toEqual(['agentNoKb', 'appValidation']);
        expect(run.unavailable).toEqual([]);
        expect(run.complete).toBe(true);
    });

    it('a body it cannot read is a gap of its own', async () => {
        answers({ ok: true });
        const run = await runAttentionChecks({ user: ADMIN });
        expect(run.unavailable).toEqual(['studio:body']);
        expect(run.complete).toBe(false);
    });

    it('carries the found-but-not-shown count', async () => {
        answers({ rows: [row()], total: 12, unavailable: [], gated: [], complete: true });
        const run = await runAttentionChecks({ user: ADMIN });
        expect(run.truncated).toBe(11);
    });
});

/* ── Registry integrity ──────────────────────────────────────────────────── */

describe('register integrity', () => {
    it('every entry is runnable and pure where it says it is', () => {
        for (const [id, check] of Object.entries(ATTENTION_CHECKS)) {
            expect(typeof check.fetchState, `${id} needs a fetchState`).toBe('function');
            expect(typeof check.evaluate, `${id} needs an evaluator`).toBe('function');
            // An evaluator handed nothing must answer with a gap, not silence.
            const verdict = check.evaluate({});
            expect(verdict.findings, `${id} on empty input`).toEqual([]);
            expect(verdict.unavailable.length, `${id} must name its gap`).toBeGreaterThan(0);
            expect(verdict.complete, `${id} must not call an unread answer whole`).toBe(false);
        }
    });

    it('a `complete` the body never carried is not whole, even with no gap of our own', async () => {
        // The second half of "the only licence to say nothing is wrong":
        // `results.every(r => r.whole)`. It fires for a body with rows, an
        // empty `unavailable`, and NO `complete` field — an older server pod
        // during a rolling deploy. Without the conjunct that reads as a clean
        // answer.
        const old = {
            studio: {
                fetchState: async () => ({ rows: [row()], total: 1, unavailable: [] }),
                evaluate: evaluateStudioAttention,
            },
        };
        const state = await runAttentionChecks({}, old);
        expect(state.unavailable).toEqual([]);
        expect(state.complete).toBe(false);
    });

    it('a capped source travels through as its own word — not a gap, not silence', async () => {
        const big = {
            studio: {
                fetchState: async () => ({
                    rows: [], total: 0, unavailable: [], capped: ['solutionBlocked'], gated: [], complete: false,
                }),
                evaluate: evaluateStudioAttention,
            },
        };
        const state = await runAttentionChecks({}, big);
        expect(state.unavailable).toEqual([]);
        expect(state.capped).toEqual(['solutionBlocked']);
        expect(state.complete).toBe(false);
        expect(summarizeAttention(state).capped).toEqual(['solutionBlocked']);
    });

    it('names the sections behind the source keys, from the registry, without repeating one', () => {
        const t = (key, fallback) => fallback || key;
        // Both knowledge sources name the SAME section, once.
        expect(attentionSourceNames(['kbEmptyInUse', 'kbSourceError'], t)).toHaveLength(1);
        expect(attentionSourceNames(['appValidation', 'solutionBlocked'], t)).toHaveLength(2);
        // A gap carries the check's prefix; a gated/capped key does not. Both
        // name the same section.
        expect(attentionSourceNames(['studio:appValidation'], t))
            .toEqual(attentionSourceNames(['appValidation'], t));
        // A key from a newer server is still reported, under its own name.
        expect(attentionSourceNames(['somethingNew'], t)).toEqual(['somethingNew']);
        expect(attentionSourceNames(null, t)).toEqual([]);
    });

    it('every source this client knows about carries a line, a kind and a rank', () => {
        // WHAT THIS DOES NOT GUARD, said plainly: the server's SOURCES list.
        // A seventh source added to routes/studio/attentionChecks.js cannot
        // turn this red — nothing in a browser bundle may import a server
        // module, and the two lists stay hand-kept (the endpoint exports
        // SOURCE_KEYS for a reader, not for this runner). What it DOES guard
        // is that the three client-side lists stay in step with each other:
        // a source in the copy table with no rank sorts last by accident, one
        // with no `kind` cannot be NAMED in the "not checked" line, and one
        // with no sentence draws a row with a glyph and a code and no words.
        expect(Object.keys(SOURCE_LABELS).sort()).toEqual([...SOURCE_ORDER].sort());
        for (const [source, copy] of Object.entries(SOURCE_LABELS)) {
            expect(copy.key.startsWith('studio.attention.'), `${source} key namespace`).toBe(true);
            expect(copy.fallback.length, `${source} needs English words`).toBeGreaterThan(0);
            expect(typeof copy.kind, `${source} needs a kind to be nameable`).toBe('string');
            // And that kind must resolve to a section, or the gap line falls
            // back to the raw source key in the middle of a sentence.
            expect(attentionSourceNames([source], (k, f) => f || k)[0], `${source} name`)
                .not.toBe(source);
        }
    });
});
