// Unit tests — pure evaluators behind the verified hands-on checks
// (actionChecks.js). Network fetch is not exercised here; these pin the
// verdict logic against the real API row shapes (rowToAutomation /
// coworkStore.getSchedules).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The generated checks' shipped path goes through the network (fetchState →
// evaluate), so the endpoint layer is stubbed and driven per test. Nothing else
// in this file touches it.
const { routes } = vi.hoisted(() => ({ routes: new Map() }));
vi.mock('../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async (url) => (routes.has(url)
        ? { ok: true, status: 200, json: async () => routes.get(url) }
        : { ok: false, status: 404, json: async () => ({}) })),
}));

import { authFetch } from '../../utils/helpers';
import {
    evaluateAutomationFirst, evaluateCoworkFirst, evaluateAgentCreated,
    evaluateKbWithDoc, evaluateHiveMaster, applicableCriteria, ACTION_CHECKS,
    rowsOf, rowOwnedBy, resolveEndpoint, fieldAt, evaluateCriterion,
    isVerifiable, getActionCheck, runActionCheck,
} from './actionChecks';
import { GENERATED_ACTION_CHECKS } from './generated/actionChecks';

beforeEach(() => { routes.clear(); vi.mocked(authFetch).mockClear(); });

describe('evaluateAutomationFirst', () => {
    it('fails everything on an empty account', () => {
        expect(evaluateAutomationFirst({ automations: [], runs: [] }))
            .toEqual({ created: false, trigger: false, ran: false });
        expect(evaluateAutomationFirst(null))
            .toEqual({ created: false, trigger: false, ran: false });
    });

    it('passes created for any automation, trigger only once one has a trigger', () => {
        const noTrigger = { id: 'a1', title: 'Draft', definition: {} };
        expect(evaluateAutomationFirst({ automations: [noTrigger], runs: [] }))
            .toEqual({ created: true, trigger: false, ran: false });

        const viaTriggerType = { ...noTrigger, triggerType: 'schedule' };
        expect(evaluateAutomationFirst({ automations: [viaTriggerType], runs: [] }).trigger).toBe(true);

        const viaDefinition = { ...noTrigger, definition: { trigger: { kind: 'webhook' } } };
        expect(evaluateAutomationFirst({ automations: [viaDefinition], runs: [] }).trigger).toBe(true);
    });

    it('passes ran on a recent run (dry_run counts) or a lastRunAt stamp', () => {
        const auto = { id: 'a1', triggerType: 'schedule', definition: { trigger: {} } };
        expect(evaluateAutomationFirst({ automations: [auto], runs: [{ id: 'r1', mode: 'dry_run' }] }).ran).toBe(true);
        expect(evaluateAutomationFirst({ automations: [{ ...auto, lastRunAt: '2026-08-01T00:00:00Z' }], runs: [] }).ran).toBe(true);
    });
});

describe('evaluateCoworkFirst', () => {
    it('fails on an empty list', () => {
        expect(evaluateCoworkFirst({ schedules: [] })).toEqual({ created: false, ran: false });
        expect(evaluateCoworkFirst(undefined)).toEqual({ created: false, ran: false });
    });

    it('passes created for any item; ran needs lastRunAt or a run count', () => {
        const pending = { id: 'c1', title: 'Digest', nextRunAt: '2026-09-01T08:00:00Z' };
        expect(evaluateCoworkFirst({ schedules: [pending] })).toEqual({ created: true, ran: false });
        expect(evaluateCoworkFirst({ schedules: [{ ...pending, lastRunAt: '2026-08-20T08:00:00Z' }] }).ran).toBe(true);
        expect(evaluateCoworkFirst({ schedules: [{ ...pending, runCount: 2 }] }).ran).toBe(true);
    });
});

describe('evaluateAgentCreated', () => {
    it('seeded system/swarm agents never count as the learner\'s own', () => {
        const rows = [
            { id: 's1', owner_id: 'system', is_published: true },
            { id: 's2', owner_id: 'swarm' },
        ];
        expect(evaluateAgentCreated({ agents: rows, userId: 'u1' }))
            .toEqual({ created: false, published: false });
    });

    it('counts own agents (scoped to userId when known) and flags a published one', () => {
        const rows = [
            { id: 'a1', owner_id: 'u1', is_published: false },
            { id: 'a2', owner_id: 'someone-else', is_published: true },
        ];
        expect(evaluateAgentCreated({ agents: rows, userId: 'u1' }))
            .toEqual({ created: true, published: false });
        expect(evaluateAgentCreated({ agents: [{ id: 'a1', owner_id: 'u1', is_published: true }], userId: 'u1' }).published).toBe(true);
        // No userId (degraded ctx) → any non-seeded row counts.
        expect(evaluateAgentCreated({ agents: rows }).created).toBe(true);
    });
});

describe('evaluateKbWithDoc', () => {
    it('needs an OWN, non-system KB; doc needs document_count > 0', () => {
        const kbs = [
            { id: 'k1', tenant_id: 'u1', document_count: 0 },
            { id: 'k2', tenant_id: 'other', document_count: 5 },
            { id: 'k3', tenant_id: 'u1', document_count: 2, source_kind: 'system_managed' },
        ];
        expect(evaluateKbWithDoc({ kbs, userId: 'u1' })).toEqual({ created: true, doc: false });
        expect(evaluateKbWithDoc({ kbs: [{ id: 'k1', tenant_id: 'u1', document_count: '3' }], userId: 'u1' }).doc).toBe(true);
        expect(evaluateKbWithDoc({ kbs: [], userId: 'u1' })).toEqual({ created: false, doc: false });
    });
});

describe('evaluateHiveMaster', () => {
    const scheduledRan = { id: 'a1', triggerType: 'schedule', lastRunAt: '2026-08-20T00:00:00Z' };
    it('automation criterion needs a SCHEDULE trigger that has run', () => {
        // Manual trigger that ran — not enough.
        expect(evaluateHiveMaster({ automations: [{ id: 'a2', triggerType: 'manual', lastRunAt: '2026-08-20T00:00:00Z' }] }).automation).toBe(false);
        // Schedule, never ran, no recent runs — not enough.
        expect(evaluateHiveMaster({ automations: [{ id: 'a3', triggerType: 'schedule' }], runs: [] }).automation).toBe(false);
        // Schedule + lastRunAt, or schedule + any recent run.
        expect(evaluateHiveMaster({ automations: [scheduledRan] }).automation).toBe(true);
        expect(evaluateHiveMaster({ automations: [{ id: 'a3', triggerType: 'schedule' }], runs: [{ id: 'r1' }] }).automation).toBe(true);
        // definition.trigger.type also identifies a schedule.
        expect(evaluateHiveMaster({ automations: [{ id: 'a4', definition: { trigger: { type: 'schedule' } }, lastRunAt: 'x' }] }).automation).toBe(true);
    });

    it('builder criterion is an OR: own agent, or own KB with a document', () => {
        const base = { automations: [scheduledRan], schedules: [{ id: 'c1' }], userId: 'u1' };
        expect(evaluateHiveMaster({ ...base, agents: [], kbs: [] }).builder).toBe(false);
        expect(evaluateHiveMaster({ ...base, agents: [{ id: 'a', owner_id: 'u1' }], kbs: [] }).builder).toBe(true);
        expect(evaluateHiveMaster({ ...base, agents: [], kbs: [{ id: 'k', tenant_id: 'u1', document_count: 1 }] }).builder).toBe(true);
        // KB without a doc does not satisfy builder.
        expect(evaluateHiveMaster({ ...base, agents: [], kbs: [{ id: 'k', tenant_id: 'u1', document_count: 0 }] }).builder).toBe(false);
    });

    it('cowork criterion mirrors evaluateCoworkFirst.created', () => {
        expect(evaluateHiveMaster({ schedules: [{ id: 'c1' }] }).cowork).toBe(true);
        expect(evaluateHiveMaster({ schedules: [] }).cowork).toBe(false);
    });
});

describe('applicableCriteria (per-criterion gating)', () => {
    const check = ACTION_CHECKS['hive-master'];
    it('drops the builder criterion for a member without builder permissions', () => {
        const ctx = { user: { permissions: [] }, hasFeature: () => true };
        const ids = applicableCriteria(check, ctx).map((c) => c.id);
        expect(ids).toEqual(['automation', 'cowork']);
    });
    it('keeps everything for an admin with the feature', () => {
        const ctx = { user: { permissions: ['all'] }, hasFeature: () => true };
        expect(applicableCriteria(check, ctx).map((c) => c.id)).toEqual(['automation', 'cowork', 'builder']);
    });
    it('drops feature-gated criteria when the plan lacks the feature', () => {
        const ctx = { user: { permissions: ['all'] }, hasFeature: (f) => f !== 'automations' };
        expect(applicableCriteria(check, ctx).map((c) => c.id)).toEqual(['cowork', 'builder']);
    });
    it('no ctx (engine context) keeps ungated + permission-passing criteria only', () => {
        // checkPermission(null, …) fails closed; feature gates without a
        // hasFeature fn are treated as visible (page is the authority).
        const ids = applicableCriteria(check, {}).map((c) => c.id);
        expect(ids).toEqual(['automation', 'cowork']);
    });
});

describe('check registry integrity', () => {
    it('every check has criteria that its evaluator can actually report on', () => {
        for (const [id, check] of Object.entries(ACTION_CHECKS)) {
            expect(check.criteria.length, `${id} needs criteria`).toBeGreaterThan(0);
            const verdict = check.evaluate({});
            for (const c of check.criteria) {
                expect(Object.prototype.hasOwnProperty.call(verdict, c.id), `${id} evaluator misses criterion ${c.id}`).toBe(true);
            }
        }
    });
});

describe('generated list checks (at least one X exists)', () => {
    it('finds the rows in a bare array or the first array-valued property', () => {
        expect(rowsOf([{ id: 1 }])).toEqual([{ id: 1 }]);
        expect(rowsOf({ items: [{ id: 2 }], total: 1 })).toEqual([{ id: 2 }]);
        expect(rowsOf({ forms: [{ id: 3 }] })).toEqual([{ id: 3 }]);
        expect(rowsOf({ count: 0 })).toEqual([]);
        expect(rowsOf(null)).toEqual([]);
    });

    it('counts a row as the learner\'s when it carries no owner, or their own id', () => {
        expect(rowOwnedBy({ id: 1 }, 'u1')).toBe(true);
        expect(rowOwnedBy({ id: 1, ownerId: 'u1' }, 'u1')).toBe(true);
        expect(rowOwnedBy({ id: 1, owner_id: 'u2' }, 'u1')).toBe(false);
        expect(rowOwnedBy(null, 'u1')).toBe(false);
    });

    it('never treats an owned row as the learner\'s while the learner is unknown', () => {
        // The lesson host can render before the user object is populated, and
        // several of these endpoints are org-wide. An owner we cannot match is
        // not a pass — otherwise "you created one" ticks off a colleague's row.
        expect(rowOwnedBy({ id: 1, createdBy: 'u2' }, null)).toBe(false);
        expect(rowOwnedBy({ id: 1, ownerId: 'u2' }, undefined)).toBe(false);
        expect(rowOwnedBy({ id: 1, userId: 'u2' }, '')).toBe(false);
        // A row with no owner field at all still counts: the endpoint itself is
        // scoped to the caller (e.g. /ai/direct/conversations).
        expect(rowOwnedBy({ id: 1 }, null)).toBe(true);
    });

    it('does not credit a colleague\'s row to a learner whose id is missing', async () => {
        routes.set('/api/webpages', { webpages: [{ id: 'w1', userId: 'someone-else' }] });
        const res = await runActionCheck('webpage-created', { user: {} });
        expect(res.passes.page).toBe(false);
        expect(res.allPassed).toBe(false);
    });
});

describe('generated checks: path templating and field predicates', () => {
    const ctx = { user: { id: 'u1', organizationId: 'org-7' } };

    it('substitutes the learner\'s organisation into a templated path', () => {
        expect(resolveEndpoint('/api/org-privacy-shield/:orgid', ctx)).toBe('/api/org-privacy-shield/org-7');
        expect(resolveEndpoint('/auth/organizations/:id/encryption', ctx)).toBe('/auth/organizations/org-7/encryption');
        expect(resolveEndpoint('/api/kb', ctx)).toBe('/api/kb');
    });

    it('refuses to run a templated check for a user with no organisation', () => {
        expect(resolveEndpoint('/api/org-privacy-shield/:orgid', { user: { id: 'u1' } })).toBeNull();
    });

    it('reads a dotted field out of the body', () => {
        expect(fieldAt({ a: { b: 3 } }, 'a.b')).toBe(3);
        expect(fieldAt({ a: null }, 'a.b')).toBeUndefined();
        expect(fieldAt(null, 'a')).toBeUndefined();
    });

    it('evaluates each expect kind, and a config object no longer needs to be a list', () => {
        const rows = { id: 'created', expect: { kind: 'rows' } };
        expect(evaluateCriterion(rows, [{ id: 1, ownerId: 'u1' }], 'u1')).toBe(true);
        expect(evaluateCriterion(rows, [{ id: 1, ownerId: 'u2' }], 'u1')).toBe(false);

        const truthy = { id: 'on', expect: { kind: 'truthy', field: 'shield.enabled' } };
        expect(evaluateCriterion(truthy, { shield: { enabled: true } }, 'u1')).toBe(true);
        expect(evaluateCriterion(truthy, { shield: { enabled: false } }, 'u1')).toBe(false);

        const nonEmpty = { id: 'terms', expect: { kind: 'nonEmpty', field: 'terms' } };
        expect(evaluateCriterion(nonEmpty, { terms: ['x'] }, 'u1')).toBe(true);
        expect(evaluateCriterion(nonEmpty, { terms: [] }, 'u1')).toBe(false);

        const equals = { id: 'tier', expect: { kind: 'equals', field: 'tier', value: 'strict' } };
        expect(evaluateCriterion(equals, { tier: 'strict' }, 'u1')).toBe(true);
        expect(evaluateCriterion(equals, { tier: 'basic' }, 'u1')).toBe(false);

        expect(evaluateCriterion(truthy, null, 'u1')).toBe(false); // endpoint failed
    });
});

describe('generated checks: a criterion that cannot be checked never passes', () => {
    const ctx = { user: { id: 'u1', organizationId: 'org-7' } };

    it('a criterion with no checkable expect is flagged, not silently downgraded to "any row"', () => {
        // The registry-wide invariant behind the bug: 99 of the generated
        // criteria named a list endpoint and nothing else, and the evaluator
        // used to read that as "at least one row the learner owns".
        for (const [id, spec] of Object.entries(GENERATED_ACTION_CHECKS)) {
            for (const cr of spec.criteria) {
                if (isVerifiable(cr)) continue;
                const anyRow = [{ id: 'row-1' }];
                expect(evaluateCriterion(cr, anyRow, 'u1'), `${id}.${cr.id} passed off an unrelated row`).toBe(false);
                expect(evaluateCriterion(cr, { items: anyRow }, 'u1'), `${id}.${cr.id} passed off an unrelated row`).toBe(false);
                const shipped = getActionCheck(id).criteria.find((c) => c.id === cr.id);
                expect(shipped.unverifiable, `${id}.${cr.id} is not flagged unverifiable`).toBe(true);
            }
        }
    });

    it('does not credit "a depth you picked" or "holds an attachment" to a learner who only opened a chat', async () => {
        routes.set('/ai/direct/conversations', [{ id: 'c1', title: 'Hello', model_tier: 'auto' }]);
        for (const checkId of ['chat-tier-chosen', 'chat-attachment']) {
            const res = await runActionCheck(checkId, ctx);
            expect(res.allPassed, `${checkId} claimed a pass`).toBe(false);
            expect(Object.values(res.passes).some(Boolean), `${checkId} ticked a criterion`).toBe(false);
            // Nothing in these checks is checkable, so they say so rather than
            // fetching a list and calling any row proof.
            expect(res.error).toBe('unverifiable');
            expect(res.unverifiable.length).toBeGreaterThan(0);
        }
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('still verifies the claims a list endpoint really does prove', async () => {
        routes.set('/ai/direct/conversations', [{ id: 'c1', title: 'Hello' }]);
        const res = await runActionCheck('chat-first', ctx);
        expect(res).toMatchObject({ passes: { conversation: true }, allPassed: true, error: null });
    });

    it('a half-checkable check ticks what it verified and never reports allPassed', async () => {
        // app-published: "you own an app" is row existence (checkable);
        // "one of your apps is published" is not, from this endpoint.
        routes.set('/api/studio-apps/mine', { apps: [{ id: 'a1', userId: 'u1', isPublished: false }] });
        const res = await runActionCheck('app-published', ctx);
        expect(res.passes).toEqual({ owned: true, published: false });
        expect(res.allPassed).toBe(false);
        expect(res.unverifiable).toEqual(['published']);
        expect(res.error).toBeNull();
    });
});

describe('generated checks: the shipped evaluation path (listCheckFromSpec)', () => {
    const ctx = { user: { id: 'u1', organizationId: 'org-7' } };

    it('judges each criterion against its own endpoint, and a dead leg is a miss, not a throw', async () => {
        // ai-switchboard-read fans out over two endpoints with two expect kinds.
        routes.set('/ai/providers', { providers: [{ id: 'anthropic' }] });
        const res = await runActionCheck('ai-switchboard-read', ctx);   // /ai/config/chat-models 404s
        expect(res.passes).toEqual({ providers: true, 'fast-model': false });
        expect(res.error).toBeNull();
        expect(res.allPassed).toBe(false);

        routes.set('/ai/config/chat-models', { fast: { modelId: 'claude-haiku-4-5' } });
        const full = await runActionCheck('ai-switchboard-read', ctx);
        expect(full).toMatchObject({ passes: { providers: true, 'fast-model': true }, allPassed: true, error: null });
    });

    it('substitutes the organisation into the endpoint it actually fetches', async () => {
        routes.set('/api/org-privacy-shield/org-7', { enabled: true, piiDetectionCategories: ['email'] });
        const res = await runActionCheck('shield-configured', ctx);
        expect(res).toMatchObject({ passes: { enabled: true, categories: true }, allPassed: true });
        expect(authFetch).toHaveBeenCalledWith('/api/org-privacy-shield/org-7');
    });

    it('reports an unreachable API as an error so the step can offer the honor path', async () => {
        const res = await runActionCheck('chat-first', ctx);   // no routes registered → 404
        expect(res).toMatchObject({ passes: {}, allPassed: false, error: 'fetch_failed' });
    });
});

/* ── The generated registry is the AUTHORED curriculum ────────────────────────
 * generated/actionChecks.js is written by .claude/handoff/curriculum/generate.mjs
 * and says so on line 1 — yet an expectation added there by hand survives right
 * up to the next regeneration, which silently threw 36 of them away and left
 * four of the tests above red with an unchanged source tree. These two guards
 * make that failure loud: the shipped registry must match the authored lessons
 * field for field, so a hand-edit and a stale regeneration both fail here
 * instead of in a learner's checklist.
 * ────────────────────────────────────────────────────────────────────────── */

// Vitest serves this module over its own dev server, so import.meta.url is no
// file path to walk from; find the repo root by walking up from the run
// directory instead (works from agent-hub/ and from the repo root alike).
const LESSONS_DIR = (() => {
    const rel = '.claude/handoff/curriculum/lessons';
    let dir = process.cwd();
    for (let up = 0; up < 5; up += 1) {
        if (fs.existsSync(path.join(dir, rel))) return path.join(dir, rel);
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return path.resolve(process.cwd(), '..', rel);
})();

function authoredChecks() {
    const out = new Map();
    for (const file of fs.readdirSync(LESSONS_DIR).filter((f) => f.endsWith('.json')).sort()) {
        const doc = JSON.parse(fs.readFileSync(path.join(LESSONS_DIR, file), 'utf8'));
        for (const ck of doc.actionChecks || []) {
            // generate.mjs keys newChecks by checkId, so a duplicate would make
            // "the authored source" ambiguous — and one lesson's expectations
            // would vanish into the other's.
            expect(out.has(ck.checkId), `${ck.checkId} is declared twice (${out.get(ck.checkId)?.file} and ${file})`).toBe(false);
            out.set(ck.checkId, {
                file,
                criteria: (ck.criteria || []).map((cr, i) => ({
                    id: cr.id,
                    // the generator's own fallback: the criterion's endpoint, else
                    // the endpoint at its index, else the first one
                    endpoint: cr.endpoint || (ck.endpoints[i] || ck.endpoints[0]).path,
                    expect: cr.expect ?? null,
                })),
            });
        }
    }
    return out;
}

// A checkout without the authored curriculum (it lives beside the code, not in
// the bundle) cannot run this comparison; everything above still does.
const haveLessons = fs.existsSync(LESSONS_DIR);

describe.skipIf(!haveLessons)('generated/actionChecks.js mirrors the authored lessons', () => {
    it('ships exactly the checks, endpoints and expectations the lessons declare', () => {
        const authored = authoredChecks();
        expect(Object.keys(GENERATED_ACTION_CHECKS).sort()).toEqual([...authored.keys()].sort());
        for (const [checkId, spec] of Object.entries(GENERATED_ACTION_CHECKS)) {
            const shipped = spec.criteria.map((c) => ({ id: c.id, endpoint: c.endpoint, expect: c.expect ?? null }));
            expect(shipped, `${checkId} differs from ${authored.get(checkId).file} — re-run curriculum/generate.mjs, and author the change in the lesson JSON`)
                .toEqual(authored.get(checkId).criteria);
        }
    });

    it('never claims ownership on a list whose owner column the runtime cannot read', () => {
        // rowOwnedBy binds on OWNER_FIELDS only, and treats a row with none of
        // them as "the endpoint is already scoped to me". These three answer
        // with organisation-wide rows that name their owner some other way —
        // /api/datatables with ownerUserId, /api/kb with tenant_id,
        // /api/automation/forms with a `mine` flag — so a `rows` expectation
        // there would tick off a colleague's table, base or form as the
        // learner's own work.
        const UNBINDABLE = ['/api/datatables', '/api/kb', '/api/automation/forms'];
        for (const [checkId, spec] of Object.entries(GENERATED_ACTION_CHECKS)) {
            for (const cr of spec.criteria) {
                const base = String(cr.endpoint || '').split('?')[0].replace(/\/$/, '');
                if (!UNBINDABLE.includes(base)) continue;
                expect(cr.expect?.kind, `${checkId}.${cr.id} claims rows on ${base}, which cannot prove the learner owns one`).not.toBe('rows');
            }
        }
    });
});
