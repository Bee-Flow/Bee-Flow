// Verified hands-on checks for Learning Center `action` steps (ActionStep.jsx).
//
// The Trailhead/HubSpot pattern, sized for Bee Flow: a lesson says "now build
// it for real", the learner does the task in the real app, and "Check my work"
// verifies it against the product's own APIs — the same user-scoped endpoints
// the features themselves use, so there is nothing new to secure. Each check
// returns per-criterion pass/fail so the step can show a live checklist and a
// targeted nudge for whatever is still missing.
//
// v2 adds per-criterion GATES for composite (capstone) checks: a criterion may
// carry { gate: { permission?, feature? } } and only counts when the learner
// could actually do that thing — a member without manage_agents isn't blocked
// on "create an agent". Callers pass ctx = { user, hasFeature }; criteria whose
// gate fails are excluded from both the checklist and the pass computation.
//
// Evaluators are PURE (data in → verdict out) and exported for unit tests;
// only fetchState touches the network. Composite fetches use
// Promise.allSettled so one 403 (e.g. a license-gated endpoint) leaves its
// criterion unmet instead of sinking the whole check; a total fetch failure
// yields { error } so the step can fall back to honor-system completion.
import { checkPermission } from '../../hooks/usePermissionCheck';
import { GENERATED_ACTION_CHECKS } from './generated/actionChecks';
import type { ActionCheck, ActionCheckResult, AgentRow, AutomationRow, CheckContext, CheckCriterion, CheckData, CheckVerdict, CoworkRow, KbRow } from './actionChecks.types';
import { messageOf } from '../../utils/caughtError';
import { getJson, settle, listCheckFromSpec } from './actionChecks.helpers';
export { rowsOf, rowOwnedBy, resolveEndpoint, fieldAt, isVerifiable, evaluateCriterion } from './actionChecks.helpers';

/* ── Pure evaluators ─────────────────────────────────────────────────────── */

// data: { automations: [...], runs: [...] } — from GET /api/automation/ and
// GET /api/automation/_runs/recent. Rows per rowToAutomation: id, title,
// definition, isActive, isDraft, triggerType, lastRunAt, …; runs carry
// { mode: 'dry_run'|…, status, … }.
export function evaluateAutomationFirst(data: CheckData | null | undefined): CheckVerdict {
    const automations = Array.isArray(data?.automations) ? data.automations : [];
    const runs = Array.isArray(data?.runs) ? data.runs : [];
    const hasTrigger = (a: AutomationRow): boolean => !!(a?.triggerType || a?.definition?.trigger);
    return {
        created: automations.length > 0,
        trigger: automations.some(hasTrigger),
        ran: runs.length > 0 || automations.some((a: AutomationRow) => !!a?.lastRunAt),
    };
}

// data: { schedules: [...] } — from GET /api/cowork. Each schedule carries
// title, prompt, nextRunAt, lastRunAt, repeatInterval, isActive, runCount.
export function evaluateCoworkFirst(data: CheckData | null | undefined): CheckVerdict {
    const items = Array.isArray(data?.schedules) ? data.schedules : [];
    const ran = (s: CoworkRow): boolean => !!(s?.lastRunAt || s?.last_run_at || (s?.runCount || s?.run_count || 0) > 0);
    return {
        created: items.length > 0,
        ran: items.some(ran),
    };
}

// data: { agents: [...], userId } — from GET /agents (bare array; own agents
// PLUS the seeded system agents, so the system/swarm rows must not count).
export function evaluateAgentCreated(data: CheckData | null | undefined): CheckVerdict {
    const agents = Array.isArray(data?.agents) ? data.agents : [];
    const own = agents.filter((a: AgentRow) => {
        const owner = a?.owner_id ?? a?.ownerId;
        if (owner === 'system' || owner === 'swarm') return false;
        return data?.userId ? owner === data.userId : true;
    });
    return {
        created: own.length > 0,
        published: own.some((a: AgentRow) => !!(a?.is_published ?? a?.isPublished)),
    };
}

// data: { kbs: [...], userId } — from GET /api/kb (bare array; personal KBs
// plus published org KBs; rows carry tenant_id (owner) and a computed
// document_count, with system-managed KBs marked by source_kind).
export function evaluateKbWithDoc(data: CheckData | null | undefined): CheckVerdict {
    const kbs = (Array.isArray(data?.kbs) ? data.kbs : []).filter((k: KbRow) => {
        if ((k?.source_kind ?? k?.sourceKind) === 'system_managed') return false;
        const owner = k?.tenant_id ?? k?.tenantId;
        return data?.userId ? owner === data.userId : true;
    });
    const docs = (k: KbRow): number => Number(k?.document_count ?? k?.documentCount ?? 0);
    return {
        created: kbs.length > 0,
        doc: kbs.some((k: KbRow) => docs(k) > 0),
    };
}

// The capstone: real artifacts across features, no step-by-step. data merges
// the sub-fetches (each may be a fallback after a 403/failure):
//   { automations, runs, schedules, agents, kbs, userId }
export function evaluateHiveMaster(data: CheckData | null | undefined): CheckVerdict {
    const automations = Array.isArray(data?.automations) ? data.automations : [];
    const scheduled = automations.filter((a: AutomationRow) => (a?.triggerType || a?.definition?.trigger?.type) === 'schedule');
    const agentVerdict = evaluateAgentCreated(data);
    const kbVerdict = evaluateKbWithDoc(data);
    return {
        automation: scheduled.some((a: AutomationRow) => !!a?.lastRunAt)
            || (scheduled.length > 0 && (Array.isArray(data?.runs) ? data.runs : []).length > 0),
        cowork: evaluateCoworkFirst(data).created,
        builder: agentVerdict.created || kbVerdict.doc,
    };
}

/* ── Check registry ──────────────────────────────────────────────────────────
 * id         — referenced by an action step's `checkId`
 * criteria   — ordered checklist rendered by ActionStep; `labelFallback` is the
 *              learner-facing line, `hintFallback` the nudge shown while unmet,
 *              `gate` (optional) hides the criterion from learners who lack the
 *              permission/feature to satisfy it
 * fetchState — gathers the data the evaluator needs (network); receives ctx
 * evaluate   — pure verdict: { [criterionId]: boolean }
 * ──────────────────────────────────────────────────────────────────────────── */
export const ACTION_CHECKS: Record<string, ActionCheck> = {
    'automation-first': {
        criteria: [
            {
                id: 'created',
                labelFallback: 'Create an automation',
                hintFallback: 'In Studio → Automations, press + for a new automation. Pick a trigger, or press Assistant on the empty canvas and describe what you want.',
            },
            {
                id: 'trigger',
                labelFallback: 'Give it a trigger',
                hintFallback: 'The canvas starts with “Choose a trigger” — a schedule is the easiest first pick.',
            },
            {
                id: 'ran',
                labelFallback: 'Run a dry-run preview',
                hintFallback: 'Open “Run flow ▾” and pick “Dry-run (preview)” — it executes nothing for real.',
            },
        ],
        async fetchState() {
            const [list, recent] = await Promise.all([
                getJson('/api/automation/'),
                getJson('/api/automation/_runs/recent'),
            ]);
            return { automations: list?.automations || [], runs: recent?.runs || [] };
        },
        evaluate: evaluateAutomationFirst,
    },

    'cowork-first': {
        criteria: [
            {
                id: 'created',
                labelFallback: 'Create a cowork',
                hintFallback: 'Open Cowork in the sidebar, describe the work in the box, and send it.',
            },
            {
                id: 'ran',
                labelFallback: 'Let it run once',
                hintFallback: 'Leave “When” on “Run now” and it runs immediately — or open your item and press Run now.',
            },
        ],
        async fetchState() {
            return getJson('/api/cowork');
        },
        evaluate: evaluateCoworkFirst,
    },

    'agent-created': {
        criteria: [
            {
                id: 'created',
                labelFallback: 'Create an agent of your own',
                hintFallback: 'Describe what it should do in the agent wizard — one plain-English sentence is enough.',
            },
            {
                id: 'published',
                labelFallback: 'Publish it (optional)',
                hintFallback: 'Drafts are private. Publish from the Agent Designer when it’s ready for the team.',
                optional: true,
            },
        ],
        async fetchState(ctx: CheckContext) {
            const agents = await getJson('/agents');
            return { agents: Array.isArray(agents) ? agents : [], userId: ctx?.user?.id || null };
        },
        evaluate: evaluateAgentCreated,
    },

    'kb-with-doc': {
        criteria: [
            {
                id: 'created',
                labelFallback: 'Create a knowledge base',
                hintFallback: 'Studio → Knowledge → the + button. Name it after the content it will hold.',
            },
            {
                id: 'doc',
                labelFallback: 'Upload at least one document',
                hintFallback: 'Any PDF, doc or spreadsheet works — Bee Flow indexes it so agents can search inside.',
            },
        ],
        async fetchState(ctx: CheckContext) {
            const kbs = await getJson('/api/kb');
            return { kbs: Array.isArray(kbs) ? kbs : [], userId: ctx?.user?.id || null };
        },
        evaluate: evaluateKbWithDoc,
    },

    // Capstone — requirements only, verified across features. Sub-fetches are
    // allSettled: a leg the learner can't even reach (403 on a license gate)
    // just leaves its criterion unmet, and gated criteria aren't asked of
    // learners who can't satisfy them.
    'hive-master': {
        criteria: [
            {
                id: 'automation',
                labelFallback: 'A schedule-triggered automation that has run',
                hintFallback: 'Build an automation with an “On a schedule” trigger and run it (a dry-run counts).',
                gate: { feature: 'automations' },
            },
            {
                id: 'cowork',
                labelFallback: 'A cowork item working for you',
                hintFallback: 'Delegate something real via Cowork — once is enough.',
            },
            {
                id: 'builder',
                labelFallback: 'An agent of your own, or a knowledge base with a document',
                hintFallback: 'Create an agent in the wizard, or a knowledge base with at least one uploaded file.',
                gate: { permission: ['manage_agents', 'manage_knowledge'] },
            },
        ],
        async fetchState(ctx: CheckContext) {
            const [list, recent, cowork, agents, kbs] = await Promise.all([
                settle(getJson('/api/automation/'), null),
                settle(getJson('/api/automation/_runs/recent'), null),
                settle(getJson('/api/cowork'), null),
                settle(getJson('/agents'), null),
                settle(getJson('/api/kb'), null),
            ]);
            // All legs down = nothing to verify against — surface as an error
            // so the honor fallback appears rather than a silent all-fail.
            if (!list && !recent && !cowork && !agents && !kbs) throw new Error('fetch_failed');
            return {
                automations: list?.automations || [],
                runs: recent?.runs || [],
                schedules: cowork?.schedules || [],
                agents: Array.isArray(agents) ? agents : [],
                kbs: Array.isArray(kbs) ? kbs : [],
                userId: ctx?.user?.id || null,
            };
        },
        evaluate: evaluateHiveMaster,
    },
};

/* ── Generated, declaration-driven checks ───────────────────────────────
 * The 2026-09 curriculum lets a lesson declare a simple check: each criterion
 * names an endpoint and an `expect` — what the response must show before the
 * learner is credited. The same user-scoped endpoints the features themselves
 * use, so nothing new to secure.
 *
 * A criterion WITHOUT a checkable `expect` is NOT silently downgraded to "any
 * row exists": most such criteria assert something specific (a depth the
 * learner picked, an attachment on a message) that no single list response can
 * prove, and passing them off one unrelated row makes the product claim a
 * learner did work they never did. They are reported as unverifiable and stay
 * unmet; the step's honor path carries the learner on.
 *
 * Pure pieces (rowsOf, rowOwnedBy, isVerifiable, evaluateCriterion) are
 * exported for unit tests; only fetchState touches the network.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Criterion ids of a check this runtime cannot verify (they never auto-pass). */
export function unverifiableCriteria(check: ActionCheck | null | undefined): string[] {
    return (check?.criteria || []).filter((c: CheckCriterion) => c.unverifiable).map((c: CheckCriterion) => c.id);
}

for (const [id, spec] of Object.entries(GENERATED_ACTION_CHECKS)) {
    if (!ACTION_CHECKS[id]) ACTION_CHECKS[id] = listCheckFromSpec(spec);
}

export function getActionCheck(checkId: string): ActionCheck | null {
    return ACTION_CHECKS[checkId] || null;
}

// Which of a check's criteria apply to THIS learner (pure — unit-tested).
// A criterion with no gate always applies. The gate shape is the one lessons
// use (lessons.js lessonVisible), and so are its semantics: `permission` is
// ANY-of, `permissionsAll` is ALL-of, `feature` is ALL-of and may be a list.
// Keeping the two in step matters more here than it looks: a criterion whose
// feature list is only half-granted would otherwise be demanded of a learner
// who cannot reach the screen that satisfies it, and an unsatisfiable
// criterion blocks the course badge behind it forever.
export function applicableCriteria(check: ActionCheck | null | undefined, ctx: CheckContext = {}): CheckCriterion[] {
    return (check?.criteria || []).filter((c: CheckCriterion) => {
        const gate = c.gate;
        if (!gate) return true;
        if (gate.permission && !checkPermission(ctx.user, gate.permission)) return false;
        if (gate.permissionsAll && !gate.permissionsAll.every((p: string) => checkPermission(ctx.user, p))) return false;
        if (gate.feature && typeof ctx.hasFeature === 'function') {
            const required = Array.isArray(gate.feature) ? gate.feature : [gate.feature];
            if (!required.every((f: string) => (ctx.hasFeature as (feature: string) => boolean)(f))) return false;
        }
        return true;
    });
}

// Run a check end to end. Resolves to
//   { passes: { [criterionId]: bool }, allPassed, error: null }
// or { passes: {}, allPassed: false, error } when the API was unreachable —
// the caller decides whether to offer the honor-system fallback. `allPassed`
// is computed over the criteria APPLICABLE to this learner (minus `optional`
// ones), so a gated-away criterion never blocks.
export async function runActionCheck(checkId: string, ctx: CheckContext = {}): Promise<ActionCheckResult> {
    const check = getActionCheck(checkId);
    if (!check) return { passes: {}, allPassed: false, error: 'unknown_check', unverifiable: [] };
    const unverifiable = unverifiableCriteria(check);
    try {
        const data = await check.fetchState(ctx);
        const passes = check.evaluate(data);
        const required = applicableCriteria(check, ctx).filter((c: CheckCriterion) => !c.optional);
        // A criterion this runtime cannot check is never a pass, so 'passed'
        // ("Verified — you built the real thing") stays honest.
        const allPassed = required.every((c: CheckCriterion) => !c.unverifiable && !!passes[c.id]);
        return { passes, allPassed, error: null, unverifiable };
    } catch (e) {
        return { passes: {}, allPassed: false, error: messageOf(e, 'fetch_failed'), unverifiable };
    }
}
