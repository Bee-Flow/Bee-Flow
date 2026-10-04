'use strict';

/**
 * The Runs tab's row fields (handoff 5, artboard 5c), added to a page of run
 * rows AFTER the list query:
 *
 *   stepsTotal, stepsDone   "2 of 2 steps", "step 3 of 4"
 *   stepStatuses            one entry per step for the little bars, in the
 *                           order they ran, padded with 'pending' up to
 *                           stepsTotal (capped at STEP_BARS_MAX entries)
 *   startedBy               { id, name } of whoever pressed the button or filled
 *                           in the form; null for schedules, events, webhooks
 *   howStarted              'manual'|'schedule'|'file'|'form'|'email'|'app'
 *                           |'webhook'|'agent'|'app_button'
 *   approvalId              the pending approval a waiting run waits on
 *   isTest, version, outcome  normalised (never undefined)
 *
 * One batched read per kind of fact per page (step statuses, definitions,
 * names, approvals), never one per row. Every lookup is injected, and every
 * failure degrades to "less detail on the row", never to a failed list.
 */

const { indexDefinition, finalRows } = require('./runOutcome');

const STEP_BARS_MAX = 60;
/** Nodes that are not steps a person would count. */
const NOT_A_STEP = new Set(['note', 'sticky', 'sticky_note', 'comment', 'trigger']);
/** A step that is behind the run: it ran, was skipped on purpose, or was absorbed. */
const DONE = new Set(['success', 'pinned', 'skipped', 'handled_error']);
const WAITING = new Set(['awaiting_approval', 'awaiting_form', 'awaiting_confirm']);

const HOW_BY_KIND = Object.freeze({
    manual: 'manual', manual_step: 'manual', dry_run: 'manual', first_run_confirm: 'manual',
    schedule: 'schedule', cron: 'schedule',
    form: 'form', form_page: 'form', webpage: 'form',
    webhook: 'webhook',
    agent_call: 'agent', agent: 'agent', chat: 'agent', skill: 'agent',
    studio_app: 'app_button', app_button: 'app_button',
});
const MAIL_PROVIDERS = new Set(['gmail', 'outlook', 'msgraph', 'microsoft', 'imap', 'soverin', 'email', 'mail']);

/** Top-level steps of a definition a person would count (not triggers or notes). */
function countedSteps(definition) {
    const steps = Array.isArray(definition?.steps) ? definition.steps : [];
    const { triggerIds } = indexDefinition(definition);
    return steps.filter(s => s && s.id && !triggerIds.has(s.id) && !NOT_A_STEP.has(s.type));
}

/**
 * @param {object|null} definition   the copy that ran (null when unknown)
 * @param {Array<object>} stepRows   status rows of every leg of the journey
 * @param {string} status            the journey's effective status
 */
function stepProgress(definition, stepRows, status) {
    const { triggerIds } = indexDefinition(definition);
    const recorded = finalRows(stepRows)
        .filter(r => r && !r.parentStepId && !triggerIds.has(r.stepId) && !NOT_A_STEP.has(r.stepType));
    const statuses = recorded.map(r => String(r.status || 'pending'));
    const stepsDone = statuses.filter(s => DONE.has(s)).length;
    const planned = definition ? countedSteps(definition).length : 0;
    // A finished run counts the steps it took: the branch it did not take is
    // not "2 of 3". Anything still going (or stopped) counts the plan, so a
    // failure at step 3 of 4 reads that way.
    const stepsTotal = status === 'success'
        ? (recorded.length || planned)
        : Math.max(recorded.length, planned);
    const bars = statuses.slice(0, STEP_BARS_MAX);
    while (bars.length < Math.min(stepsTotal, STEP_BARS_MAX)) bars.push('pending');
    return { stepsTotal, stepsDone, stepStatuses: bars };
}

/** The trigger node a run entered through. */
function enteredTrigger(definition, rootStepId) {
    const all = [definition?.trigger, ...(Array.isArray(definition?.triggers) ? definition.triggers : [])].filter(Boolean);
    return (rootStepId && all.find(t => t.id === rootStepId)) || definition?.trigger || null;
}

/** 'manual' | 'schedule' | 'file' | 'form' | 'email' | 'app' | 'webhook' | 'agent' | 'app_button' */
function howStartedOf(run, definition = null) {
    if (run?.callerAgentId) return 'agent';
    const kind = String(run?.triggerKind || '').toLowerCase();
    if (kind === 'app_event') {
        const payload = run?.triggerPayload && typeof run.triggerPayload === 'object' ? run.triggerPayload : {};
        const trig = enteredTrigger(definition, run?.rootStepId);
        const provider = String(payload.provider || trig?.appEvent?.provider || '').toLowerCase();
        const event = String(payload.event || trig?.appEvent?.event || '').toLowerCase();
        if (MAIL_PROVIDERS.has(provider) || /mail/.test(event)) return 'email';
        if (/file|folder/.test(event)) return 'file';
        return 'app';
    }
    return HOW_BY_KIND[kind] || 'manual';
}

/** A person's name as the rest of the product shows it. */
const displayName = (u) => (u ? (u.displayName || u.username || null) : null);

/**
 * @param {{
 *   store: {
 *     getJourneyStepStatuses?: (rootIds: string[]) => Promise<Map<string, any[]>>,
 *     getVersionDefinitions?: (pairs: Array<{automationId: string, version: number}>) => Promise<Map<string, any>>,
 *     getPendingApprovalIdsForRuns?: (runIds: string[]) => Promise<Map<string, string>>,
 *   },
 *   getUsersByIds?: (ids: string[]) => Promise<Array<{ id: string, displayName?: string, username?: string }>>,
 * }} deps
 */
function makeRunRowDecorator(deps = {}) {
    const store = deps.store || {};
    const safe = async (fn, fallback) => {
        try { return (await fn()) ?? fallback; } catch (_) { return fallback; }
    };

    /**
     * @param {Array<object>} runs  rows from listRunsScoped (journey heads)
     * @param {{ automation?: object|null, withStarter?: boolean, withApprovals?: boolean }} [opts]
     *   automation     the automation when the page is one automation's: its
     *                  current definition stands in for a missing snapshot
     *   withStarter    false on the org-wide log, whose rows carry no identity
     *   withApprovals  false where the caller cannot open approvals anyway
     */
    async function decorate(runs, { automation = null, withStarter = true, withApprovals = true } = {}) {
        const list = Array.isArray(runs) ? runs : [];
        if (!list.length) return list;
        const rootIds = list.map(r => r.id);
        const pairs = list.filter(r => r.automationId && r.version != null)
            .map(r => ({ automationId: r.automationId, version: r.version }));
        const starterIds = withStarter
            ? [...new Set(list.map(r => r.startedByUserId || r.submittedByUserId).filter(Boolean))]
            : [];
        const waitingLegs = withApprovals
            ? list.filter(r => r.status === 'awaiting_approval').map(r => r.journeyRunId || r.id)
            : [];

        const [statuses, definitions, users, approvals] = await Promise.all([
            store.getJourneyStepStatuses ? safe(() => store.getJourneyStepStatuses(rootIds), new Map()) : new Map(),
            store.getVersionDefinitions && pairs.length ? safe(() => store.getVersionDefinitions(pairs), new Map()) : new Map(),
            deps.getUsersByIds && starterIds.length ? safe(() => deps.getUsersByIds(starterIds), []) : [],
            store.getPendingApprovalIdsForRuns && waitingLegs.length
                ? safe(() => store.getPendingApprovalIdsForRuns(waitingLegs), new Map()) : new Map(),
        ]);
        const names = new Map((users || []).map(u => [u.id, displayName(u)]));

        return list.map((row) => {
            const def = definitions.get(`${row.automationId}@${row.version}`)
                || (automation && automation.id === row.automationId ? automation.definition : null);
            const progress = stepProgress(def, statuses.get(row.id) || [], row.status);
            const starterId = withStarter ? (row.startedByUserId || row.submittedByUserId || null) : null;
            const out = {
                ...row,
                ...progress,
                howStarted: howStartedOf(row, def),
                startedBy: starterId ? { id: starterId, name: names.get(starterId) || null } : null,
                isTest: !!row.isTest,
                version: row.version ?? null,
                outcome: row.outcome ?? null,
            };
            if (withApprovals && WAITING.has(row.status)) {
                out.approvalId = approvals.get(row.journeyRunId || row.id) || null;
            }
            return out;
        });
    }

    return { decorate };
}

/** The four counts of the Runs tab's filter segment, from a status facet map. */
function segmentCounts(byStatus) {
    const s = byStatus || {};
    const sum = (keys) => keys.reduce((n, k) => n + (Number(s[k]) || 0), 0);
    return {
        all: Object.values(s).reduce((n, v) => n + (Number(v) || 0), 0),
        failed: sum(['error']),
        waiting: sum(['awaiting_approval', 'awaiting_form', 'awaiting_confirm']),
        running: sum(['running', 'queued']),
        byStatus: { ...s },
    };
}

module.exports = {
    makeRunRowDecorator,
    stepProgress,
    howStartedOf,
    segmentCounts,
    countedSteps,
    STEP_BARS_MAX,
};
