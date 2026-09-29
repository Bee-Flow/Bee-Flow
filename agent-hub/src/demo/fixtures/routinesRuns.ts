/**
 * Run history for the Routines demo (the builder's Runs tab, handoff 5
 * artboard 5c, and the header's "Runs n").
 *
 * Each run is one row of a seed table: when, which version, how it started,
 * and one letter per top-level step (S success, E error, A waiting for an
 * approval, P not reached). The row the list shows (outcome, step bars, who
 * started it) and the step records the detail and the canvas show are both
 * derived from that one line, so they cannot disagree.
 *
 * The newest spend-report run is the test run that failed at "Post to
 * finance". The builder rehydrates the canvas from the newest run, so every
 * step upstream shows its output and the failed step's drawer shows the
 * plain error card (errorInfo, server/utils/stepErrorInfo.js).
 *
 * Shapes follow the S5s contract (server/routes/automation/runs.js and
 * server/automation/runListRows.js). Everything is invented.
 */

import { daysAgo, minutesAgo } from './common';
import { LOTTE, MARK, ME, PIETER, SANNE, ref, type DemoPerson } from './routinesPeople';

type Obj = Record<string, unknown>;
type Outcome = { code: string; params: Obj; text: string };
export interface StepRecord { stepId: string; stepType: string; status: string; input: unknown; output: unknown; error?: string | null; [key: string]: unknown }
type Sample = (stepId: string) => StepRecord;

interface Failure { stepId: string; input: Obj; error: string; errorClass: string; errorInfo: Obj }

export interface DemoRun {
    id: string; automationId: string; version: number; status: string; isTest: boolean;
    howStarted: string; startedBy: DemoPerson | null; startedAt: string; durationMs: number | null;
    /** One letter per top-level step, in run order. */
    steps: string; outcome: Outcome; triggerKind: string;
    triggerPayload?: Obj | null; failure?: Failure; approvalId?: string; parentRunId?: string | null;
}

const hoursAgo = (n: number) => minutesAgo(n * 60);

const SR = 'auto_demo_spend_report';
const IN = 'auto_demo_intake';
const DG = 'auto_demo_digest';

// ── Outcomes, in the server's words (automation/runOutcome.js) ───────────

const listFound = (step: string, stepId: string, count: number, noun: string, handled = 0): Outcome => ({
    code: 'success',
    params: { step, stepId, kind: 'list', count, noun, where: null, ...(handled ? { handled } : {}) },
    text: `${step}: ${count} ${noun} found`,
});
const fileResult = (step: string, stepId: string, name: string): Outcome => ({
    code: 'success', params: { step, stepId, kind: 'file', name }, text: `${step}: ${name}`,
});
const finishedWith = (step: string, stepId: string): Outcome => ({
    code: 'success', params: { step, stepId, kind: 'text' }, text: `Finished with "${step}"`,
});
const stoppedAt = (step: string, stepId: string, reasonCode: string, reason: string): Outcome => ({
    code: 'stopped_at', params: { step, stepId, reasonCode, reason, where: null }, text: `Stopped at "${step}": ${reason}`,
});
const waitingFor = (step: string, stepId: string, who: string, whoCount: number): Outcome => ({
    code: 'waiting_approval', params: { step, stepId, who, whoCount }, text: `Waiting for approval from ${who}`,
});
/** What a run that went through says, per routine (a retry, a run made in the demo). */
function wentThrough(automationId: string, payload?: Obj | null): Outcome {
    if (automationId === SR) return listFound('Sum totals per vendor', 'total_per_vendor', 5, 'vendors');
    const name = (payload?.file as Obj | undefined)?.name;
    if (automationId === IN && typeof name === 'string') return fileResult('Classify the document', 'classify', name);
    if (automationId === DG) return finishedWith('Gather open actions', 'gather');
    return { code: 'success', params: { kind: 'none' }, text: 'Finished' };
}

const SKIPPED_BUSY: Outcome = {
    code: 'cancelled', params: { reasonCode: 'already_running' }, text: 'Skipped because the routine was already running',
};

// ── The failures: errorInfo exactly as the classifier writes it ──────────

const fix = (id: string, label: string, params?: Obj) => ({ id, label, labelKey: `routines.output.fix_${id}`, ...(params ? { params } : {}) });

const RECIPIENT_REJECTED = '550 5.1.1 <finance-team@example.com>: Recipient address rejected: User unknown in virtual mailbox table';
const POST_FAILED: Failure = {
    stepId: 'notify_finance',
    input: { channel: 'email', to: 'finance-team@example.com', subject: 'Weekly AI/SaaS spend' },
    error: RECIPIENT_REJECTED,
    errorClass: 'ValidationError',
    errorInfo: {
        code: 'validation',
        title: 'A setting has a value this step cannot use',
        cause: 'Email did not accept the value of "to". Check that setting and try again.',
        titleKey: 'routines.step_error.validation.title',
        causeKey: 'routines.step_error.validation.cause',
        params: { service: 'Email', field: 'to' },
        settingKey: 'inputs.to',
        fixes: [fix('open_settings', 'Open the setting', { settingKey: 'inputs.to' })],
        technical: RECIPIENT_REJECTED,
    },
};

const GMAIL_EXPIRED: Failure = {
    stepId: 'search_invoices',
    input: { query: 'from:(billing OR invoice) newer_than:7d', maxResults: 100 },
    error: 'Gmail API 401: invalid_grant (Token has been expired or revoked.)',
    errorClass: 'PermissionError',
    errorInfo: {
        code: 'auth_expired',
        title: 'The Gmail sign-in has expired',
        cause: 'Bee can no longer sign in to Gmail for the account this step uses. Reconnect and try again.',
        titleKey: 'routines.step_error.auth_expired.title',
        causeKey: 'routines.step_error.auth_expired.cause',
        params: { service: 'Gmail' },
        settingKey: 'connection',
        fixes: [fix('reconnect', 'Reconnect', { service: 'Gmail' }), fix('switch_account', 'Other account', { settingKey: 'connection' })],
        technical: 'Gmail API 401: invalid_grant (Token has been expired or revoked.)',
    },
};

const SHIELD_BLOCKED: Failure = {
    stepId: 'classify',
    input: { modelTier: 'fast', file: 'Scan-2026-09-24.pdf' },
    error: 'Blocked by guardrail: document contains a citizen service number (BSN)',
    errorClass: 'guardrail_blocked',
    errorInfo: {
        code: 'guardrail_blocked',
        title: 'The privacy shield stopped this step',
        cause: 'This step would have sent data that your organisation\'s privacy policy blocks.',
        titleKey: 'routines.step_error.guardrail_blocked.title',
        causeKey: 'routines.step_error.guardrail_blocked.cause',
        params: { service: 'AI model' },
        settingKey: null,
        fixes: [],
        technical: 'Blocked by guardrail: document contains a citizen service number (BSN)',
    },
};

// ── The seed table ───────────────────────────────────────────────────────

const clientFile = (name: string) => ({ file: { name, path: `/Clients/${name}`, mimeType: 'application/pdf' } });

export function seedRuns(): DemoRun[] {
    const manual = { triggerKind: 'manual', howStarted: 'manual' };
    return [
        // The spend report: live on v3, v4 and v5 only ever ran as tests.
        { id: 'run_demo_sr_09', automationId: SR, version: 5, status: 'error', isTest: true, ...manual, startedBy: ME, startedAt: minutesAgo(22), durationMs: 9_400,
            steps: 'SSSSSSE', outcome: stoppedAt('Post to finance', 'notify_finance', 'validation', 'a setting has a value this step cannot use'), failure: POST_FAILED },
        { id: 'run_demo_sr_08', automationId: SR, version: 3, status: 'awaiting_approval', isTest: false, ...manual, startedBy: MARK, startedAt: minutesAgo(103), durationMs: null,
            steps: 'SSSSAP', outcome: waitingFor('Ask finance to approve', 'approve_summary', SANNE.name, 1), approvalId: 'appr_demo_sr_08' },
        { id: 'run_demo_sr_07', automationId: SR, version: 3, status: 'success', isTest: false, triggerKind: 'agent_call', howStarted: 'agent', startedBy: SANNE, startedAt: hoursAgo(26), durationMs: 734_000,
            steps: 'SSSSSS', outcome: listFound('Sum totals per vendor', 'total_per_vendor', 5, 'vendors') },
        { id: 'run_demo_sr_06', automationId: SR, version: 3, status: 'error', isTest: false, ...manual, startedBy: MARK, startedAt: hoursAgo(51), durationMs: 1_240,
            steps: 'EPPPPP', outcome: stoppedAt('Search AI/SaaS billing emails', 'search_invoices', 'auth_expired', 'the Gmail sign-in has expired'), failure: GMAIL_EXPIRED },
        { id: 'run_demo_sr_05', automationId: SR, version: 3, status: 'success', isTest: false, ...manual, startedBy: MARK, startedAt: hoursAgo(49), durationMs: 402_300,
            steps: 'SSSSSS', outcome: listFound('Sum totals per vendor', 'total_per_vendor', 6, 'vendors'), parentRunId: 'run_demo_sr_06' },
        { id: 'run_demo_sr_04', automationId: SR, version: 4, status: 'success', isTest: true, ...manual, startedBy: ME, startedAt: hoursAgo(71), durationMs: 8_900,
            steps: 'SSSSSS', outcome: listFound('Sum totals per vendor', 'total_per_vendor', 5, 'vendors') },
        { id: 'run_demo_sr_03', automationId: SR, version: 3, status: 'cancelled', isTest: false, ...manual, startedBy: LOTTE, startedAt: hoursAgo(98), durationMs: 120,
            steps: 'PPPPPP', outcome: SKIPPED_BUSY },
        { id: 'run_demo_sr_02', automationId: SR, version: 3, status: 'success', isTest: false, ...manual, startedBy: LOTTE, startedAt: hoursAgo(98.1), durationMs: 1_265_000,
            steps: 'SSSSSS', outcome: listFound('Sum totals per vendor', 'total_per_vendor', 4, 'vendors') },
        { id: 'run_demo_sr_01', automationId: SR, version: 3, status: 'success', isTest: false, ...manual, startedBy: SANNE, startedAt: hoursAgo(147), durationMs: 911_000,
            steps: 'SSSSSS', outcome: listFound('Sum totals per vendor', 'total_per_vendor', 5, 'vendors', 1) },
        { id: 'run_demo_sr_00', automationId: SR, version: 3, status: 'success', isTest: false, ...manual, startedBy: SANNE, startedAt: daysAgo(9), durationMs: 688_000,
            steps: 'SSSSSS', outcome: listFound('Sum totals per vendor', 'total_per_vendor', 5, 'vendors') },
        { id: 'run_demo_sr_b2', automationId: SR, version: 1, status: 'success', isTest: false, ...manual, startedBy: ME, startedAt: daysAgo(16), durationMs: 540_000,
            steps: 'SSSSSS', outcome: listFound('Sum totals per vendor', 'total_per_vendor', 4, 'vendors') },
        { id: 'run_demo_sr_b1', automationId: SR, version: 1, status: 'success', isTest: false, ...manual, startedBy: ME, startedAt: daysAgo(23), durationMs: 610_000,
            steps: 'SSSSSS', outcome: listFound('Sum totals per vendor', 'total_per_vendor', 5, 'vendors') },

        // New client intake: a Nextcloud file event.
        { id: 'run_demo_in_05', automationId: IN, version: 3, status: 'success', isTest: false, triggerKind: 'app_event', howStarted: 'file', startedBy: null, startedAt: minutesAgo(37), durationMs: 64_000,
            steps: 'SSS', outcome: fileResult('Classify the document', 'classify', 'Contract-VanDijk-2026.pdf'), triggerPayload: clientFile('Contract-VanDijk-2026.pdf') },
        { id: 'run_demo_in_04', automationId: IN, version: 3, status: 'awaiting_approval', isTest: false, triggerKind: 'app_event', howStarted: 'file', startedBy: null, startedAt: hoursAgo(5), durationMs: null,
            steps: 'SSA', outcome: waitingFor('Ask the account manager to confirm', 'ask_review', 'L. Bakker and Account managers', 2),
            approvalId: 'appr_demo_in_04', triggerPayload: clientFile('Framework-agreement-Meridian.pdf') },
        { id: 'run_demo_in_03', automationId: IN, version: 3, status: 'success', isTest: false, triggerKind: 'app_event', howStarted: 'file', startedBy: null, startedAt: hoursAgo(27), durationMs: 2_100,
            steps: 'SS', outcome: fileResult('Classify the document', 'classify', 'Invoice-2026-0917.pdf'), triggerPayload: clientFile('Invoice-2026-0917.pdf') },
        { id: 'run_demo_in_02', automationId: IN, version: 3, status: 'error', isTest: false, triggerKind: 'app_event', howStarted: 'file', startedBy: null, startedAt: hoursAgo(50), durationMs: 900,
            steps: 'EPP', outcome: stoppedAt('Classify the document', 'classify', 'guardrail_blocked', 'the privacy shield stopped this step'),
            failure: SHIELD_BLOCKED, triggerPayload: clientFile('Scan-2026-09-24.pdf') },
        { id: 'run_demo_in_01', automationId: IN, version: 3, status: 'success', isTest: false, triggerKind: 'app_event', howStarted: 'file', startedBy: null, startedAt: hoursAgo(75), durationMs: 3_300_000,
            steps: 'SSS', outcome: fileResult('Classify the document', 'classify', 'NDA-Harbour-Logistics.pdf'), triggerPayload: clientFile('NDA-Harbour-Logistics.pdf') },

        // Monday morning digest: weekly on a schedule.
        { id: 'run_demo_dg_03', automationId: DG, version: 3, status: 'success', isTest: false, triggerKind: 'schedule', howStarted: 'schedule', startedBy: null, startedAt: daysAgo(5), durationMs: 14_200,
            steps: 'SS', outcome: finishedWith('Gather open actions', 'gather') },
        { id: 'run_demo_dg_02', automationId: DG, version: 3, status: 'success', isTest: false, triggerKind: 'schedule', howStarted: 'schedule', startedBy: null, startedAt: daysAgo(12), durationMs: 12_800,
            steps: 'SS', outcome: finishedWith('Gather open actions', 'gather') },
        { id: 'run_demo_dg_01', automationId: DG, version: 5, status: 'success', isTest: true, triggerKind: 'manual', howStarted: 'manual', startedBy: PIETER, startedAt: daysAgo(2), durationMs: 11_500,
            steps: 'SS', outcome: finishedWith('Gather open actions', 'gather') },
    ];
}

// ── Step records ─────────────────────────────────────────────────────────

const LETTER: Record<string, string> = { S: 'success', E: 'error', A: 'awaiting_approval', P: 'pending', H: 'handled_error', K: 'skipped' };
const DONE = new Set(['success', 'pinned', 'skipped', 'handled_error']);
const statusesOf = (run: DemoRun) => [...run.steps].map(c => LETTER[c] || 'pending');

/** Outputs for the steps the spend report's run engine (routines.js) does not know. */
const SAMPLES: Record<string, { stepType: string; input: unknown; output: unknown }> = {
    approve_summary: { stepType: 'approval', input: { assignee: SANNE.name, prompt: 'This week’s AI/SaaS spend summary is ready. Send it to finance?' }, output: { decision: 'approved', decidedBy: SANNE.name } },
    classify: { stepType: 'ai_step', input: { modelTier: 'fast' }, output: { text: 'contract' } },
    route: { stepType: 'switch', input: { on: 'contract' }, output: { branch: 'contract' } },
    ask_review: { stepType: 'approval', input: { assignee: LOTTE.name }, output: { decision: 'approved', decidedBy: LOTTE.name } },
    gather: { stepType: 'ai_step', input: { modelTier: 'fast' }, output: { text: 'Open actions from last week:\n- Send the Q3 forecast to the board (P. Visser)\n- Renew the Meridian Cloud contract (M. Jansen)\n- Book a venue for the team day (L. Bakker)' } },
    send: { stepType: 'notification', input: { channel: 'email', to: 'team@example.com' }, output: { delivered: false, to: 'team@example.com', demo: 'No email was sent. The demo has no network access.' } },
};

const DURATION: Record<string, number> = {
    search_invoices: 1_240, read_each: 5_380, total_per_vendor: 40, to_euros: 12, over_budget: 3, write_summary: 2_120, notify_finance: 610,
    classify: 900, route: 5, gather: 11_200, send: 640,
};

interface RunState {
    automations: Array<{ id: string; version: number; definition?: unknown; title?: string; triggerType?: string }>;
    versions: Record<string, Array<{ version: number; definition: unknown }>>;
    runs: DemoRun[];
    reminded?: Record<string, number>;
}

/** The definition the run executed: its version's snapshot, the working copy for the current one. */
export function definitionFor(state: RunState, run: DemoRun): { trigger?: Obj; steps?: Obj[] } | null {
    const a = state.automations.find(x => x.id === run.automationId);
    if (!a) return null;
    const snap = run.version === a.version ? a.definition : state.versions[a.id]?.find(v => v.version === run.version)?.definition;
    return (snap || a.definition || null) as { trigger?: Obj; steps?: Obj[] } | null;
}

const topSteps = (def: { steps?: Obj[] } | null) => (def?.steps || []).filter(s => s.type !== 'note');

/** Every recorded step of one run: the trigger, then each step it reached. */
export function stepsFor(state: RunState, run: DemoRun, sample: Sample): StepRecord[] {
    const def = definitionFor(state, run);
    const statuses = statusesOf(run);
    let clock = new Date(run.startedAt).getTime();
    const at = (ms: number) => { const from = clock; clock += ms; return { startedAt: new Date(from).toISOString(), finishedAt: new Date(clock).toISOString(), durationMs: ms }; };
    const trigger = def?.trigger as Obj | undefined;
    const rows: StepRecord[] = [{
        stepId: String(trigger?.id || 'trg'), stepType: 'trigger', status: 'success', input: null,
        output: run.triggerPayload || { triggeredBy: run.startedBy?.email || null, kind: run.triggerKind },
        ...at(0),
    }];
    topSteps(def).forEach((s, i) => {
        const status = statuses[i] || 'pending';
        if (status === 'pending') return;
        const id = String(s.id);
        const known = SAMPLES[id];
        const base: StepRecord = known ? { stepId: id, status, ...known } : { ...sample(id), stepType: String(s.type) };
        if (status === 'error' && run.failure?.stepId === id) {
            rows.push({ ...base, status, input: run.failure.input, output: null, error: run.failure.error, errorClass: run.failure.errorClass, errorInfo: run.failure.errorInfo, ...at(DURATION[id] ?? 500) });
        } else if (status === 'awaiting_approval') {
            rows.push({ ...base, status, output: null, error: null, startedAt: new Date(clock).toISOString(), finishedAt: null, durationMs: null });
        } else {
            rows.push({ ...base, status, error: null, errorInfo: null, ...at(DURATION[id] ?? 800) });
        }
    });
    return rows;
}

/** The list row: the run plus the S5s decorations. */
export function rowOf(run: DemoRun) {
    const statuses = statusesOf(run);
    const finishedAt = run.durationMs != null ? new Date(new Date(run.startedAt).getTime() + run.durationMs).toISOString() : null;
    const waiting = run.status.startsWith('awaiting');
    return {
        id: run.id, automationId: run.automationId, version: run.version, userId: ME.id,
        triggerKind: run.triggerKind, triggerPayload: run.triggerPayload || null, mode: 'live', status: run.status,
        startedAt: run.startedAt, finishedAt, durationMs: run.durationMs,
        error: run.failure?.error || null, errorClass: run.failure?.errorClass || null, summary: null,
        parentRunId: run.parentRunId || null, rootRunId: run.id, awaitingStepId: waiting ? run.outcome.params.stepId : null,
        outcome: run.outcome, stepsTotal: statuses.length, stepsDone: statuses.filter(s => DONE.has(s)).length, stepStatuses: statuses,
        startedBy: run.startedBy ? ref(run.startedBy) : null, howStarted: run.howStarted, isTest: run.isTest,
        ...(waiting ? { approvalId: run.approvalId || null } : {}),
    };
}

// ── Filters, as GET /:id/runs reads them ─────────────────────────────────

function matchesQuery(run: DemoRun, q: string): boolean {
    const hay = [run.id, run.outcome.text, run.startedBy?.name, ...Object.values(run.triggerPayload?.file as Obj || {})]
        .filter(v => typeof v === 'string').join(' ').toLowerCase();
    return hay.includes(q.toLowerCase());
}

function filtered(runs: DemoRun[], query: URLSearchParams, withStatus: boolean): DemoRun[] {
    const since = query.get('since');
    const until = query.get('until');
    const tests = query.get('tests') || 'include';
    const q = (query.get('q') || '').trim();
    const by = query.get('startedBy');
    const statuses = (query.get('status') || '').split(',').filter(Boolean);
    const who = by === 'me' ? ME.id : by;
    const checks: Array<(r: DemoRun) => boolean> = [
        r => !since || r.startedAt >= since,
        r => !until || r.startedAt <= until,
        r => (tests === 'exclude' ? !r.isTest : tests === 'only' ? r.isTest : true),
        r => !q || matchesQuery(r, q),
        r => !who || r.startedBy?.id === who,
        r => !withStatus || !statuses.length || statuses.includes(r.status),
    ];
    return runs.filter(r => checks.every(check => check(r)));
}

function facets(runs: DemoRun[]) {
    const byStatus: Record<string, number> = {};
    for (const r of runs) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    const n = (...s: string[]) => s.reduce((sum, k) => sum + (byStatus[k] || 0), 0);
    return { all: runs.length, failed: n('error'), waiting: n('awaiting_approval', 'awaiting_form', 'awaiting_confirm'), running: n('running', 'queued'), byStatus };
}

const newestFirst = (a: DemoRun, b: DemoRun) => b.startedAt.localeCompare(a.startedAt);
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Ctx = { state: RunState; params: Record<string, string>; query: URLSearchParams };

/** Studio → Automations → Runs: every routine's runs, with the routine's name on each row. */
function recentRuns(state: RunState, query: URLSearchParams) {
    const only = query.get('automationId');
    const runs = filtered(state.runs.filter(r => !only || r.automationId === only).sort(newestFirst), query, true);
    return {
        runs: runs.slice(0, Math.min(Number(query.get('limit')) || 50, 100)).map((r) => {
            const a = state.automations.find(x => x.id === r.automationId);
            return { ...rowOf(r), automationTitle: a?.title || null, automationTriggerType: a?.triggerType || null, automationKind: 'automation' };
        }),
        nextCursor: null,
    };
}

/** The chip counts of that page: per status and per trigger, within `range` hours. */
function recentFacets(state: RunState, query: URLSearchParams) {
    const since = new Date(Date.now() - (Number(query.get('range')) || 24) * 3_600_000).toISOString();
    const only = query.get('automationId');
    const status: Record<string, number> = {};
    const triggerKind: Record<string, number> = {};
    for (const r of state.runs.filter(x => x.startedAt >= since && (!only || x.automationId === only))) {
        status[r.status] = (status[r.status] || 0) + 1;
        triggerKind[r.triggerKind] = (triggerKind[r.triggerKind] || 0) + 1;
    }
    return { facets: { status, triggerKind } };
}

/** The run routes; `sample` is the spend report's run engine (routines.js). */
export function runRoutes(sample: Sample) {
    const find = (state: RunState, id: string) => state.runs.find(r => r.id === id) || null;
    return {
        'GET /api/automation/_runs/recent': ({ state, query }: Ctx) => recentRuns(state, query),
        'GET /api/automation/_runs/facets': ({ state, query }: Ctx) => recentFacets(state, query),
        'GET /api/automation/:id/runs': ({ state, params, query }: Ctx) => {
            const mine = state.runs.filter(r => r.automationId === params.id).sort(newestFirst);
            const limit = Math.min(Number(query.get('limit')) || 100, 100);
            const runs = filtered(mine, query, true).slice(0, limit).map(rowOf);
            return { runs, nextCursor: null, myRole: 'owner', onlyMine: false, ...(query.get('cursor') ? {} : { facets: facets(filtered(mine, query, false)) }) };
        },
        'GET /api/automation/runs/:runId': ({ state, params }: Ctx) => {
            const run = find(state, params.runId);
            return run ? { run: rowOf(run) } : json({ error: 'Not found' }, 404);
        },
        'GET /api/automation/runs/:runId/steps': ({ state, params }: Ctx) => {
            const run = find(state, params.runId);
            if (!run) return json({ error: 'Not found' }, 404);
            return { steps: stepsFor(state, run, sample), definition: definitionFor(state, run) };
        },
        // "Run again with this input": a new run of the same version that goes through.
        'POST /api/automation/:id/runs/:runId/retry': ({ state, params }: Ctx) => {
            const original = find(state, params.runId);
            if (!original) return json({ error: 'Not found' }, 404);
            if (original.status === 'running' || original.status.startsWith('awaiting')) {
                return json({ error: 'This run has not finished yet.', code: 'run_not_finished', details: { status: original.status } }, 409);
            }
            const run: DemoRun = {
                ...original, id: `run_demo_retry_${state.runs.length + 1}`, status: 'success', startedBy: ME, howStarted: 'manual',
                startedAt: new Date().toISOString(), durationMs: 8_700, steps: 'S'.repeat(original.steps.length), failure: undefined,
                parentRunId: original.id,
                outcome: original.status === 'success' ? original.outcome : wentThrough(original.automationId, original.triggerPayload),
            };
            state.runs.push(run);
            return { accepted: true, runId: run.id, run: rowOf(run), steps: stepsFor(state, run, sample) };
        },
        'POST /api/automation/approvals/:id/remind': ({ state, params }: Ctx) => {
            state.reminded = state.reminded || {};
            const last = state.reminded[params.id] || 0;
            const next = last + 10 * 60_000;
            if (Date.now() < next) {
                return json({ error: 'A reminder went out less than 10 minutes ago.', code: 'remind_rate_limited', details: { lastRemindedAt: new Date(last).toISOString(), nextAllowedAt: new Date(next).toISOString(), retryAfterSec: Math.ceil((next - Date.now()) / 1000) } }, 429);
            }
            state.reminded[params.id] = Date.now();
            return { reminded: true, remindedAt: new Date().toISOString(), nextAllowedAt: new Date(Date.now() + 10 * 60_000).toISOString(), recipients: 1 };
        },
        // The builder header's tab counts: journeys of the last 7 days, tests left out.
        'GET /api/automation/:id/counts': ({ state, params }: Ctx) => {
            const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
            const week = state.runs.filter(r => r.automationId === params.id && !r.isTest && r.startedAt >= weekAgo);
            const a = state.automations.find(x => x.id === params.id) as { pendingChanges?: number } | undefined;
            return {
                runs7d: week.length,
                runsFailed7d: week.filter(r => r.status === 'error').length,
                versions: state.versions[params.id]?.length ?? 1,
                pendingChanges: a?.pendingChanges || 0,
            };
        },
    };
}

/** A run the demo just made (Test, Run flow): newest in the list, so the Runs tab shows it. */
export function recordRun(state: RunState, automationId: string, isTest: boolean): DemoRun {
    const a = state.automations.find(x => x.id === automationId);
    const count = topSteps((a?.definition || null) as { steps?: Obj[] } | null).length;
    const run: DemoRun = {
        id: `run_demo_new_${state.runs.length + 1}`, automationId, version: a?.version || 1, status: 'success', isTest,
        triggerKind: 'manual', howStarted: 'manual', startedBy: ME, startedAt: new Date(Date.now() - 1200).toISOString(), durationMs: 1200,
        steps: 'S'.repeat(count), outcome: wentThrough(automationId),
    };
    state.runs.push(run);
    return run;
}
