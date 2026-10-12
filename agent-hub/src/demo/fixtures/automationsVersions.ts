/**
 * Version history for the Automations demo (the builder's Versions tab and the
 * header's "Make vN live", handoff 5 artboards 5a/5d).
 *
 * The spend report tells one story across five versions:
 *   v1  created from the organisation's template
 *   v2  steps reordered (works the same)
 *   v3  the extraction prompt sharpened; named "Approved by finance" and live
 *   v4  the manual approval replaced by a €2,000 threshold
 *   v5  the working copy: a wider search query and a longer run history
 * so the automation is live on v3 with two changes not live yet.
 *
 * Every version stores what it changed relative to the one before it, per
 * setting. The field diff between any two versions is composed from those
 * lists, so v5 against v3 is exactly v4's changes followed by v5's, and the
 * reverse direction swaps before and after. Shapes follow the S1b contract
 * (server/routes/automation/versionHistory.js).
 */

import { daysAgo, minutesAgo } from './common';
import { LOTTE, MARK, ME, SANNE, type DemoPerson } from './automationsPeople';

type Obj = Record<string, unknown>;
export interface FlowDef { trigger?: Obj; steps: Obj[]; edges: Obj[]; [key: string]: unknown }

type ChangeKind = 'added' | 'removed' | 'changed' | 'moved';
interface FieldChange {
    stepId: string | null; stepNumber: number | null; stepLabel: string; change: ChangeKind;
    setting: string | null; settingLabel: string | null; path: string | null;
    before: string | null; after: string | null;
}
interface DescEntry { code: string; params: Obj }

export interface VersionRecord {
    id: string;
    version: number;
    savedAt: string;
    savedBy: DemoPerson;
    name: string | null;
    description: string;
    descriptionJson: DescEntry[];
    /** Journeys that ran on this version before the demo's run list starts. */
    runsBefore: { total: number; failed: number } | null;
    liveSince?: string;
    definition: FlowDef;
    /** What this version changed relative to the one before it. */
    changes: FieldChange[];
}

export interface AutomationLike {
    id: string; version: number; liveVersion: number | null; liveAt?: string | null;
    pendingChanges?: number; neverLive?: boolean; definition?: unknown; title?: string;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const step = (stepId: string | null, stepNumber: number | null, stepLabel: string) => ({ stepId, stepNumber, stepLabel });
/** A changed setting: where, [code, English label, path], [before, after]. */
const setting = (at: ReturnType<typeof step>, [key, label, path]: [string, string, string], [before, after]: [string, string]): FieldChange => (
    { ...at, change: 'changed', setting: key, settingLabel: label, path, before, after });
const moved = (at: ReturnType<typeof step>, before: string, after: string): FieldChange => (
    { ...at, change: 'moved', setting: 'flowPosition', settingLabel: 'Position in the flow', path: null, before, after });
const added = (at: ReturnType<typeof step>, kind: string): FieldChange => (
    { ...at, change: 'added', setting: null, settingLabel: null, path: null, before: null, after: kind });
const removed = (at: ReturnType<typeof step>, kind: string): FieldChange => (
    { ...at, change: 'removed', setting: null, settingLabel: null, path: null, before: kind, after: null });

// ── The spend report ─────────────────────────────────────────────────────

const NEW_QUERY = 'from:(billing OR invoice OR receipt) newer_than:7d';
const OLD_QUERY = 'from:(billing OR invoice) newer_than:7d';
const OLD_RECIPIENT = 'finance@example.com';
const NEW_RECIPIENT = 'finance-team@example.com';
const OLD_PROMPT = 'Extract the line items from this invoice as JSON.';
const NEW_PROMPT = 'Extract every billing line item from this invoice email as JSON: vendor, description, amount, currency, period. If it is not an…';

const APPROVAL_STEP = {
    id: 'approve_summary',
    type: 'approval',
    label: 'Ask finance to approve',
    assignee: SANNE.email,
    prompt: 'This week’s AI/SaaS spend summary is ready. Send it to finance?',
};

/** v4 and later have the threshold; v3 and earlier had a person approve every report. */
function withApproval(current: FlowDef): FlowDef {
    const def = clone(current);
    def.steps = def.steps.filter(s => s.id !== 'over_budget');
    const at = def.steps.findIndex(s => s.id === 'notify_finance');
    def.steps.splice(at < 0 ? def.steps.length : at, 0, clone(APPROVAL_STEP));
    def.edges = [
        { from: 'trg', to: 'search_invoices' },
        { from: 'search_invoices', to: 'read_each' },
        { from: 'read_each', to: 'total_per_vendor' },
        { from: 'total_per_vendor', to: 'write_summary' },
        { from: 'write_summary', to: 'approve_summary' },
        { from: 'approve_summary', to: 'notify_finance', branch: 'approved' },
    ];
    delete def.runPolicy;
    return def;
}

/** v4 as it was: the narrower query, the old recipient, no run policy. */
function beforeV5(def: FlowDef): FlowDef {
    const out = clone(def);
    const search = out.steps.find(s => s.id === 'search_invoices');
    if (search) search.params = { ...(search.params as Obj), query: OLD_QUERY };
    const post = out.steps.find(s => s.id === 'notify_finance');
    if (post) post.to = OLD_RECIPIENT;
    delete out.runPolicy;
    return out;
}

function withPrompt(def: FlowDef, prompt: string): FlowDef {
    const out = clone(def);
    const loop = out.steps.find(s => s.id === 'read_each');
    const inner = (loop?.steps as Obj[] | undefined)?.find(s => s.id === 'extract_lines');
    if (inner) inner.prompt = `${prompt}\n\n{{ steps.read_message.body }}`;
    return out;
}

function spendReportVersions(current: FlowDef): VersionRecord[] {
    const v4 = beforeV5(current);
    const v3 = withApproval(v4);
    const v2 = withPrompt(v3, OLD_PROMPT);
    const search = step('search_invoices', 2, 'Search AI/SaaS billing emails');
    return [
        {
            id: 'ver_demo_sr_1', version: 1, savedAt: daysAgo(46), savedBy: ME, name: null,
            description: 'Created from template "Invoice spend summary"',
            descriptionJson: [{ code: 'created_from_template', params: { template: 'Invoice spend summary', templateId: 'org-demo-spend' } }],
            runsBefore: { total: 2, failed: 0 }, definition: v2, changes: [],
        },
        {
            id: 'ver_demo_sr_2', version: 2, savedAt: daysAgo(20), savedBy: ME, name: null,
            description: 'Steps reordered',
            descriptionJson: [{ code: 'steps_reordered', params: {} }],
            runsBefore: null, definition: v2,
            changes: [moved(step('approve_summary', 6, 'Ask finance to approve'), 'after "Post to finance"', 'after "Write the summary"')],
        },
        {
            id: 'ver_demo_sr_3', version: 3, savedAt: daysAgo(13), savedBy: SANNE, name: 'Approved by finance',
            description: 'Instruction changed in "Extract billing line items"',
            descriptionJson: [{ code: 'setting_changed', params: { setting: 'Instruction', settingKey: 'prompt', step: 'Extract billing line items' } }],
            runsBefore: { total: 3, failed: 0 }, liveSince: daysAgo(12), definition: v3,
            changes: [setting(step('extract_lines', null, 'Read & extract each invoice › Extract billing line items'), ['prompt', 'Instruction', 'prompt'], [OLD_PROMPT, NEW_PROMPT])],
        },
        {
            id: 'ver_demo_sr_4', version: 4, savedAt: daysAgo(3), savedBy: ME, name: null,
            description: 'Step added: "Above €2,000 this week?"',
            descriptionJson: [
                { code: 'step_added', params: { step: 'Above €2,000 this week?' } },
                { code: 'step_removed', params: { step: 'Ask finance to approve' } },
            ],
            runsBefore: null, definition: v4,
            changes: [
                added(step('over_budget', 5, 'Above €2,000 this week?'), 'Condition'),
                moved(step('write_summary', 6, 'Write the summary'), 'after "Sum totals per vendor"', 'after "Above €2,000 this week?"'),
                removed(step('approve_summary', null, 'Ask finance to approve'), 'Approval'),
            ],
        },
        {
            id: 'ver_demo_sr_5', version: 5, savedAt: minutesAgo(25), savedBy: ME, name: null,
            description: 'Search query changed in "Search AI/SaaS billing emails"',
            descriptionJson: [
                { code: 'setting_changed', params: { setting: 'Search query', settingKey: 'query', step: 'Search AI/SaaS billing emails' } },
                { code: 'setting_changed', params: { setting: 'Recipient', settingKey: 'to', step: 'Post to finance' } },
                { code: 'settings_changed', params: { setting: 'Keep run history', settingKey: 'retentionDays' } },
            ],
            runsBefore: null, definition: clone(current),
            changes: [
                setting(search, ['query', 'Search query', 'params.query'], [OLD_QUERY, NEW_QUERY]),
                setting(step('notify_finance', 7, 'Post to finance'), ['to', 'Recipient', 'to'], [OLD_RECIPIENT, NEW_RECIPIENT]),
                setting(step(null, null, 'Automation'), ['retentionDays', 'Keep run history', 'runPolicy.retentionDays'], ['30 days', '90 days']),
            ],
        },
    ];
}

// ── The other automations: shorter histories on their current definition ───

interface RowSeed extends Partial<VersionRecord> {
    id: string; version: number; savedAt: string; savedBy: DemoPerson; entry: DescEntry; description: string; definition: FlowDef;
}
function row({ entry, ...rest }: RowSeed): VersionRecord {
    return { name: null, runsBefore: null, changes: [], descriptionJson: [entry], ...rest };
}
const saved = (id: string, version: number, savedAt: string, savedBy: DemoPerson) => ({ id, version, savedAt, savedBy });
const changedIn = (setting: string, settingKey: string, stepLabel: string): DescEntry => (
    { code: 'setting_changed', params: { setting, settingKey, step: stepLabel } });

function digestVersions(current: FlowDef): VersionRecord[] {
    const send = step('send', 3, 'Email the team');
    const definition = current;
    return [
        row({ ...saved('ver_demo_dg_1', 1, daysAgo(90), MARK), entry: { code: 'created', params: {} }, description: 'Created', definition, runsBefore: { total: 6, failed: 0 } }),
        row({
            ...saved('ver_demo_dg_2', 2, daysAgo(62), MARK), entry: changedIn('Instruction', 'prompt', 'Gather open actions'),
            description: 'Instruction changed in "Gather open actions"', definition, runsBefore: { total: 4, failed: 1 },
            changes: [setting(step('gather', 2, 'Gather open actions'), ['prompt', 'Instruction', 'prompt'], ['List the open action items.', 'List the open action items from last week.'])],
        }),
        row({
            ...saved('ver_demo_dg_3', 3, daysAgo(31), MARK), entry: { code: 'trigger_changed', params: { step: 'Mondays at 08:00' } },
            description: 'Start changed', definition, name: 'Monday 08:00', liveSince: daysAgo(30), runsBefore: { total: 4, failed: 0 },
            changes: [setting(step('trg', 1, 'Mondays at 08:00'), ['cron', 'Schedule', 'cron'], ['Mondays at 09:00', 'Mondays at 08:00'])],
        }),
        row({
            ...saved('ver_demo_dg_4', 4, daysAgo(6), ME), entry: { code: 'step_renamed', params: { step: 'Email the team', from: 'Send email' } },
            description: 'Step renamed to "Email the team"', definition,
            changes: [setting(send, ['label', 'Name', 'label'], ['Send email', 'Email the team'])],
        }),
        row({
            ...saved('ver_demo_dg_5', 5, daysAgo(2), ME), entry: changedIn('Recipient', 'to', 'Email the team'),
            description: 'Recipient changed in "Email the team"', definition,
            changes: [setting(send, ['to', 'Recipient', 'to'], ['m.jansen@example.com', 'team@example.com'])],
        }),
    ];
}

function intakeVersions(current: FlowDef): VersionRecord[] {
    const withoutReview = clone(current);
    withoutReview.steps = withoutReview.steps.filter(s => s.id !== 'ask_review');
    withoutReview.edges = withoutReview.edges.filter(e => e.to !== 'ask_review');
    return [
        row({ ...saved('ver_demo_in_1', 1, daysAgo(12), LOTTE), entry: { code: 'created', params: {} }, description: 'Created', definition: withoutReview }),
        row({
            ...saved('ver_demo_in_2', 2, daysAgo(11), LOTTE), entry: { code: 'step_added', params: { step: 'Ask the account manager to confirm' } },
            description: 'Step added: "Ask the account manager to confirm"', definition: current,
            changes: [added(step('ask_review', 4, 'Ask the account manager to confirm'), 'Approval')],
        }),
        row({
            ...saved('ver_demo_in_3', 3, daysAgo(10), LOTTE), entry: changedIn('Instruction', 'prompt', 'Classify the document'),
            description: 'Instruction changed in "Classify the document"', definition: current,
            name: 'First live version', liveSince: daysAgo(10), runsBefore: { total: 9, failed: 0 },
            changes: [setting(step('classify', 2, 'Classify the document'), ['prompt', 'Instruction', 'prompt'],
                ['What kind of document is this?', 'Classify this document as one of: contract, id_document, invoice, other. Answer with one word.'])],
        }),
    ];
}

/** The seeded histories, keyed by automation id. Anything else gets one "Created" row. */
export function seedVersions(automations: Array<{ id: string; definition?: unknown }>): Record<string, VersionRecord[]> {
    const def = (id: string) => (automations.find(a => a.id === id)?.definition || { steps: [], edges: [] }) as FlowDef;
    return {
        auto_demo_spend_report: spendReportVersions(def('auto_demo_spend_report')),
        auto_demo_digest: digestVersions(def('auto_demo_digest')),
        auto_demo_intake: intakeVersions(def('auto_demo_intake')),
    };
}

// ── Reading them ─────────────────────────────────────────────────────────

interface VersionState {
    automations: AutomationLike[];
    versions: Record<string, VersionRecord[]>;
    runs?: Array<{ automationId: string; version?: number | null; isTest?: boolean; status?: string }>;
}

export function historyOf(state: VersionState, a: AutomationLike): VersionRecord[] {
    if (!state.versions[a.id]) {
        state.versions[a.id] = [row({
            ...saved(`ver_${a.id}_1`, a.version, daysAgo(1), ME), entry: { code: 'created', params: {} }, description: 'Created', definition: clone(a.definition as FlowDef),
        })];
    }
    return state.versions[a.id];
}

/** A version by number, 'live', 'working' or row id. */
function resolve(state: VersionState, a: AutomationLike, ref: string): VersionRecord | null {
    const rows = historyOf(state, a);
    const n = ref === 'live' ? a.liveVersion : ref === 'working' ? a.version : Number(ref);
    return rows.find(r => r.version === n || r.id === ref) || null;
}

function runsOn(state: VersionState, a: AutomationLike, v: VersionRecord) {
    const mine = (state.runs || []).filter(r => r.automationId === a.id && r.version === v.version && !r.isTest);
    if (!mine.length && !v.runsBefore) return v.version > (a.liveVersion ?? 0) ? { total: 0, failed: 0 } : null;
    const base = v.runsBefore || { total: 0, failed: 0 };
    return { total: base.total + mine.length, failed: base.failed + mine.filter(r => r.status === 'error').length };
}

function rowOut(state: VersionState, a: AutomationLike, v: VersionRecord) {
    const isLive = a.liveVersion === v.version;
    return {
        id: v.id, automationId: a.id, version: v.version, savedAt: v.savedAt,
        savedByUserId: v.savedBy.id, savedByName: v.savedBy.name, savedBy: { id: v.savedBy.id, name: v.savedBy.name },
        changeSummary: v.description, name: v.name, description: v.description, descriptionJson: v.descriptionJson,
        isLayoutOnly: false, isLive, liveSince: isLive ? (v.liveSince || a.liveAt || null) : null,
        isEditing: v.version === a.version, runs: runsOn(state, a, v),
    };
}

/** Changes from `from` up to `to` (from < to), merged per step and setting. */
function forward(rows: VersionRecord[], from: number, to: number): FieldChange[] {
    const merged = new Map<string, FieldChange>();
    for (const v of rows.filter(r => r.version > from && r.version <= to).sort((x, y) => x.version - y.version)) {
        for (const c of v.changes) {
            const key = `${c.stepId}|${c.setting ?? ''}`;
            const prev = merged.get(key);
            if (prev?.change === 'added' && c.change === 'removed') merged.delete(key);
            else if (prev) merged.set(key, { ...prev, after: c.after, change: prev.change === 'added' ? 'added' : c.change });
            else merged.set(key, { ...c });
        }
    }
    return [...merged.values()];
}

const INVERT: Record<ChangeKind, ChangeKind> = { added: 'removed', removed: 'added', changed: 'changed', moved: 'moved' };

export function fieldDiff(rows: VersionRecord[], version: number, other: number) {
    const changes = version >= other
        ? forward(rows, other, version)
        : forward(rows, version, other).map(c => ({ ...c, change: INVERT[c.change], before: c.after, after: c.before }));
    const ids = (kinds: ChangeKind[]) => [...new Set(changes.filter(c => c.stepId && kinds.includes(c.change)).map(c => c.stepId as string))];
    const addedIds = ids(['added']);
    const removedIds = ids(['removed']);
    const target = rows.find(r => r.version === version);
    return {
        version, other, changes,
        stepIds: { added: addedIds, removed: removedIds, changed: ids(['changed', 'moved']).filter(id => !addedIds.includes(id) && !removedIds.includes(id)) },
        descriptionJson: target?.descriptionJson || [], description: target?.description || null, layoutOnly: false,
    };
}

// ── Saves: a structural save is a new version, a layout-only save is not ──

const LAYOUT_KEYS = new Set(['position', 'size', 'width', 'height', 'color', 'icon', 'iconManual', 'labelManual', 'piiLineColors']);
const structure = (def: unknown) => JSON.stringify(def ?? null, (k, v) => (LAYOUT_KEYS.has(k) ? undefined : v));

function describeSave(before: FlowDef, after: FlowDef): DescEntry {
    const ids = (d: FlowDef) => new Map((d?.steps || []).map(s => [String(s.id), s]));
    const was = ids(before);
    const now = ids(after);
    const label = (s: Obj | undefined) => String(s?.label || s?.id || 'a step');
    const addedStep = [...now.keys()].find(id => !was.has(id));
    if (addedStep) return { code: 'step_added', params: { step: label(now.get(addedStep)) } };
    const gone = [...was.keys()].find(id => !now.has(id));
    if (gone) return { code: 'step_removed', params: { step: label(was.get(gone)) } };
    const touched = [...now.keys()].find(id => structure(now.get(id)) !== structure(was.get(id)));
    if (touched) return { code: 'step_changed', params: { step: label(now.get(touched)), count: 1 } };
    if (structure(before?.trigger) !== structure(after?.trigger)) return { code: 'trigger_changed', params: {} };
    return { code: 'settings_changed', params: {} };
}

/**
 * Called by PUT /:id with the definition as it was. A structural change
 * writes version n+1 (and, on a live automation, one more change not live);
 * dragging a node does not.
 */
export function recordSave(state: VersionState, a: AutomationLike, previous: unknown): void {
    if (structure(previous) === structure(a.definition)) return;
    const rows = historyOf(state, a);
    const entry = describeSave(previous as FlowDef, a.definition as FlowDef);
    a.version += 1;
    if (a.liveVersion != null) a.pendingChanges = (a.pendingChanges || 0) + 1;
    rows.push(row({ ...saved(`ver_${a.id}_${a.version}`, a.version, new Date().toISOString(), ME), entry, description: 'Saved in the demo', definition: clone(a.definition as FlowDef) }));
}

const notFound = (code: string) => new Response(JSON.stringify({ error: 'Not found', code }), { status: 404, headers: { 'Content-Type': 'application/json' } });

type Ctx = { state: VersionState; params: Record<string, string>; body: Obj | null };
const automationOf = (state: VersionState, id: string) => state.automations.find(x => x.id === id) || null;

export const VERSION_ROUTES = {
    'GET /api/automation/:id/versions': ({ state, params }: Ctx) => {
        const a = automationOf(state, params.id);
        if (!a) return notFound('not_found');
        const rows = historyOf(state, a).map(v => rowOut(state, a, v)).sort((x, y) => y.version - x.version);
        return { versions: rows, liveVersion: a.liveVersion, workingVersion: a.version, pendingChanges: a.pendingChanges || 0 };
    },
    'GET /api/automation/:id/versions/:ref': ({ state, params }: Ctx) => {
        const a = automationOf(state, params.id);
        const v = a ? resolve(state, a, params.ref) : null;
        if (!a || !v) return notFound('version_not_found');
        const working = v.version === a.version;
        return { version: { ...rowOut(state, a, v), definition: working ? a.definition : v.definition, readOnly: true } };
    },
    'GET /api/automation/:id/versions/:ref/fielddiff/:other': ({ state, params }: Ctx) => {
        const a = automationOf(state, params.id);
        const v = a ? resolve(state, a, params.ref) : null;
        const o = a ? resolve(state, a, params.other) : null;
        if (!a || !v || !o) return notFound('version_not_found');
        return fieldDiff(historyOf(state, a), v.version, o.version);
    },
    'PUT /api/automation/:id/versions/:version/name': ({ state, params, body }: Ctx) => {
        const a = automationOf(state, params.id);
        const v = a ? resolve(state, a, params.version) : null;
        if (!a || !v) return notFound('version_not_found');
        const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
        v.name = name || null;
        const out = rowOut(state, a, v);
        return { version: { id: out.id, version: out.version, name: out.name, isLive: out.isLive, liveSince: out.liveSince, isEditing: out.isEditing } };
    },
    'POST /api/automation/:id/versions/:versionId/restore': ({ state, params }: Ctx) => {
        const a = automationOf(state, params.id);
        const v = a ? resolve(state, a, params.versionId) : null;
        if (!a || !v) return notFound('version_not_found');
        const rows = historyOf(state, a);
        const back = fieldDiff(rows, v.version, a.version).changes;
        a.definition = clone(v.definition);
        a.version += 1;
        if (a.liveVersion != null) a.pendingChanges = (a.pendingChanges || 0) + 1;
        rows.push(row({
            ...saved(`ver_${a.id}_${a.version}`, a.version, new Date().toISOString(), ME), entry: { code: 'restored', params: { version: v.version } },
            description: `Restored from v${v.version}`, definition: clone(v.definition), changes: back,
        }));
        return { automation: a, restoredFromVersion: v.version };
    },
    // "Make vN live": the working copy becomes what runs.
    'POST /api/automation/:id/publish': ({ state, params }: Ctx) => {
        const a = automationOf(state, params.id);
        if (!a) return notFound('not_found');
        a.liveVersion = a.version;
        a.liveAt = new Date().toISOString();
        a.pendingChanges = 0;
        a.neverLive = false;
        const live = historyOf(state, a).find(v => v.version === a.version);
        if (live) live.liveSince = a.liveAt;
        return { automation: a, warnings: [] };
    },
};
