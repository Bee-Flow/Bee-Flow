/**
 * Pure model behind AutomationsOverview — which rows show, in what order, in
 * which column. React-free so the views can be tested as data.
 *
 * The three vocabularies this leans on already exist elsewhere and are NOT
 * redefined here:
 *   - live / paused / draft   is `shared/statusOf.automation` (the Studio's
 *                             "is this thing on?" word, painted by the pill)
 *   - success / error / …     is `shared/statusTokens` (what the LAST RUN did)
 *   - the trigger kinds       are what AutomationRow already draws an icon for
 *
 * A row's "state" filter mixes the first two on purpose: someone opening an
 * overview asks "what is on, what is off, what is broken" — and broken is a
 * run outcome on an automation that is otherwise live.
 */
import { nodeTypeLabel, stepFamily } from '../../../automation/Builder/flow/nodeDefs';
import { describeCron } from '../../../automation/Builder/flow/scheduleBuilderUtils';
import { APP_EVENT_TYPE_LABEL } from '../../../automation/Builder/flow/triggerLabels';
import { automation as lifecycleOf } from '../../../shared/statusOf';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { ProjectContextPillProject } from '../../../chat/ProjectContextPill';

/** One step of an automation's definition, as the list rows read it. */
export interface AutomationStep {
    id?: string;
    type?: string;
    label?: string;
    icon?: string;
    app?: string;
    action?: string;
    [key: string]: unknown;
}

type DateLike = string | number | Date | null | undefined;

/** What an automation's definition holds, as far as the list rows read it. */
export interface AutomationDefinition {
    trigger?: { id?: string; kind?: string; appEvent?: { provider: string; event: string } } | null;
    steps?: AutomationStep[] | null;
}

/** An automation (or prompt task) as the library lists it: every member may be missing. */
export interface AutomationRecord {
    id: string;
    title?: string;
    description?: string | null;
    isActive?: boolean;
    isDraft?: boolean;
    liveVersion?: number | null;
    neverLive?: boolean;
    pendingChanges?: number;
    myRole?: string | null;
    lastStatus?: string | null;
    lastRunAt?: DateLike;
    nextRunAt?: string | null;
    updatedAt?: DateLike;
    createdAt?: DateLike;
    folderId?: string | null;
    triggerType?: string;
    scheduleCron?: string;
    scheduleTz?: string;
    repeatInterval?: string;
    /** The row may carry the full definition (an AutomationDefinition) or none. */
    definition?: unknown;
    [key: string]: unknown;
}

/** The set of automations running right now. */
export interface RunIdSet {
    has(id: string | undefined): boolean;
}

/** One lane of the board. */
export interface OverviewLane {
    id: string;
    label: string;
    rows: AutomationRecord[];
}

export const VIEWS = Object.freeze(['list', 'cards', 'board']);
export const SORTS = Object.freeze(['updated', 'name', 'lastRun', 'nextRun', 'status']);
export const GROUPS = Object.freeze(['status', 'trigger', 'folder']);
export const STATE_FILTERS = Object.freeze(['all', 'live', 'paused', 'draft', 'failing', 'running']);
export const TRIGGER_KINDS = Object.freeze(['schedule', 'manual', 'webhook', 'app_event']);

export const TRIGGER_LABEL: Readonly<Record<string, string>> = Object.freeze({
    schedule: 'Schedule',
    manual: 'Manual',
    webhook: 'Webhook',
    app_event: 'App event',
    other: 'Other',
});

export const STATUS_LABEL: Readonly<Record<string, string>> = Object.freeze({
    live: 'Live',
    paused: 'Paused',
    draft: 'Draft',
});

const TRIGGER_LABEL_KEY: Readonly<Record<string, string>> = Object.freeze({
    schedule: 'studio_misc.overview.trigger_schedule',
    manual: 'studio_misc.overview.trigger_manual',
    webhook: 'studio_misc.overview.trigger_webhook',
    app_event: 'studio_misc.overview.trigger_app_event',
    other: 'studio_misc.overview.trigger_other',
});

const STATUS_LABEL_KEY: Readonly<Record<string, string>> = Object.freeze({
    live: 'studio_misc.overview.status_live',
    paused: 'studio_misc.overview.status_paused',
    draft: 'studio_misc.overview.status_draft',
});

/** The trigger kind's label; translated when a `t` is passed, English otherwise. */
export function triggerLabelOf(kind: string, t: TranslateFn | null | undefined) {
    const en = TRIGGER_LABEL[kind];
    return t && TRIGGER_LABEL_KEY[kind] ? t(TRIGGER_LABEL_KEY[kind], en) : en;
}

/** The lifecycle label; translated when a `t` is passed, English otherwise. */
export function statusLabelOf(status: string, t: TranslateFn | null | undefined) {
    const en = STATUS_LABEL[status];
    return t && STATUS_LABEL_KEY[status] ? t(STATUS_LABEL_KEY[status], en) : en;
}

/** The trigger kind the way AutomationRow reads it — column first, definition second. */
export function triggerKindOf(a: AutomationRecord | null | undefined) {
    const kind = a?.triggerType || (a?.definition as AutomationDefinition | null | undefined)?.trigger?.kind || 'manual';
    return TRIGGER_KINDS.includes(kind) ? kind : 'other';
}

/** "meeting-notes" → "Meeting notes"; "meeting.processed" → "meeting processed". */
const words = (s: string) => String(s || '').replace(/[-_.]+/g, ' ').trim();

/** "New email (Gmail)" when the catalogue knows the event, else "Meeting notes: meeting processed". */
function appEventText(ev: { provider: string; event: string }) {
    const known = APP_EVENT_TYPE_LABEL[`${ev.provider}.${ev.event}`];
    if (known) return known;
    const provider = words(ev.provider);
    const event = words(ev.event);
    if (!provider) return event;
    const name = provider.charAt(0).toUpperCase() + provider.slice(1);
    return event ? `${name}: ${event}` : name;
}

/** "Every day at 09:00 · Europe/Amsterdam", "New email (Gmail)", "Started by hand". */
export function triggerTextOf(a: AutomationRecord | null | undefined, t: TranslateFn | null | undefined) {
    const kind = triggerKindOf(a);
    if (kind === 'schedule' && a?.scheduleCron) {
        return `${describeCron(a.scheduleCron)}${a.scheduleTz ? ` · ${a.scheduleTz}` : ''}`;
    }
    if (kind === 'app_event') {
        const ev = (a?.definition as AutomationDefinition | null | undefined)?.trigger?.appEvent;
        return ev?.provider || ev?.event ? appEventText(ev) : triggerLabelOf('app_event', t);
    }
    if (kind === 'manual') return t ? t('studio_misc.overview.trigger_by_hand', 'Started by hand') : 'Started by hand';
    return triggerLabelOf(kind, t);
}

/** How many steps the definition holds; null when the row carries no definition. */
export function stepCountOf(a: AutomationRecord | null | undefined) {
    const steps = (a?.definition as AutomationDefinition | null | undefined)?.steps;
    return Array.isArray(steps) ? steps.length : null;
}

/** What a step is called: its own label, else its type's name. */
function stepNameOf(step: AutomationStep, t: TranslateFn | null) {
    return String(step.label || '').trim() || nodeTypeLabel(step.type, t) || step.type;
}

/** The steps drawn in the strip (and named in the summary): top level only, no notes or other non-step types. */
function visibleStepsOf(a: AutomationRecord | null | undefined) {
    const steps = (a?.definition as AutomationDefinition | null | undefined)?.steps;
    if (!Array.isArray(steps)) return [];
    return steps.filter(s => s && s.type && stepFamily(s.type) && stepFamily(s.type) !== 'trigger');
}

export const STRIP_MAX_STEPS = 5;

/**
 * What the step strip draws: the trigger first, then the first STRIP_MAX_STEPS
 * top-level steps in order, and how many were left out. `empty` is a definition
 * that has no steps at all (the strip says so instead of drawing one chip).
 */
export function stripModelOf(a: unknown, t: TranslateFn | null, max: number = STRIP_MAX_STEPS) {
    const steps = visibleStepsOf(a as AutomationRecord | null);
    const kind = triggerKindOf(a as AutomationRecord | null);
    const trigger = {
        key: 'trigger', type: 'trigger', family: 'trigger', kind,
        provider: ((a as AutomationRecord | null)?.definition as AutomationDefinition | null | undefined)?.trigger?.appEvent?.provider || null,
        label: triggerTextOf(a as AutomationRecord | null, t),
    };
    const chips = steps.slice(0, max).map((s, i) => ({
        key: s.id || `${i}`,
        type: s.type,
        family: stepFamily(s.type),
        icon: s.icon || null,
        app: s.app || null,
        action: s.action || null,
        label: stepNameOf(s, t),
    }));
    return {
        chips: [trigger, ...chips],
        more: Math.max(0, steps.length - chips.length),
        empty: stepCountOf(a as AutomationRecord | null) === 0,
    };
}

/**
 * "New email (Gmail) → AI step → Datatable → +2 more": the one-line answer to
 * "what does this do", for rows without a description. At most three named steps.
 */
export function flowSummaryOf(a: unknown, t: TranslateFn | null, maxNamed: number = 3) {
    const trigger = triggerTextOf(a as AutomationRecord | null, t);
    if (stepCountOf(a as AutomationRecord | null) == null) return trigger;
    const steps = visibleStepsOf(a as AutomationRecord | null);
    if (steps.length === 0) return `${trigger} → ${t ? t('studio_misc.overview.no_steps', 'No steps yet') : 'No steps yet'}`;
    const parts = [trigger, ...steps.slice(0, maxNamed).map(s => stepNameOf(s, t))];
    const rest = steps.length - maxNamed;
    if (rest > 0) parts.push(t ? t('studio_misc.overview.more_steps', '+{n} more', { n: rest }) : `+${rest} more`);
    return parts.join(' → ');
}

/** The server spells a failed run both ways. */
export function isFailing(a: AutomationRecord | null | undefined) {
    return a?.lastStatus === 'error' || a?.lastStatus === 'failed';
}

export function isRunning(a: AutomationRecord | null | undefined, activeRunIds: RunIdSet | null | undefined) {
    return a?.lastStatus === 'running' || !!activeRunIds?.has?.(a?.id);
}

function matchesState(a: AutomationRecord | null, state: string, activeRunIds: RunIdSet | null | undefined) {
    switch (state) {
        case 'all': return true;
        case 'failing': return isFailing(a);
        case 'running': return isRunning(a, activeRunIds);
        default: return lifecycleOf(a) === state;
    }
}

/**
 * Count per state pill, over the rows the OTHER filters let through — so a
 * pill's number is what clicking it will show, not the whole library.
 */
export function countStates(rows: AutomationRecord[], activeRunIds: RunIdSet | null | undefined) {
    const counts = Object.fromEntries(STATE_FILTERS.map(s => [s, 0]));
    for (const a of rows) {
        counts.all += 1;
        counts[lifecycleOf(a)] += 1;
        if (isFailing(a)) counts.failing += 1;
        if (isRunning(a, activeRunIds)) counts.running += 1;
    }
    return counts;
}

export function countTriggers(rows: AutomationRecord[]) {
    const counts: Record<string, number> = { all: rows.length };
    for (const a of rows) {
        const k = triggerKindOf(a);
        counts[k] = (counts[k] || 0) + 1;
    }
    return counts;
}

/** The folder filter's word for "at the top level, outside every folder". */
export const NO_FOLDER = '__none';

/**
 * A folderId pointing at a folder this user cannot see — or one just deleted
 * elsewhere — counts as loose, the same rule FolderedAutomationList groups by and
 * the folder board lanes paint. Without `folders` every folderId is taken at
 * face value.
 */
function matchesFolder(a: AutomationRecord, folder: string, folders: ProjectContextPillProject[] | null) {
    if (folder === 'all') return true;
    const known = folders ? new Set(folders.map(f => f.id)) : null;
    const fid = a.folderId && (!known || known.has(a.folderId)) ? a.folderId : null;
    return folder === NO_FOLDER ? fid === null : fid === folder;
}

export function filterRows(rows: AutomationRecord[], { state = 'all', trigger = 'all', folder = 'all', folders = null, activeRunIds = null }: { state?: string; trigger?: string; folder?: string; folders?: ProjectContextPillProject[] | null; activeRunIds?: RunIdSet | null } = {}) {
    return rows.filter(a =>
        matchesState(a, state, activeRunIds)
        && (trigger === 'all' || triggerKindOf(a) === trigger)
        && matchesFolder(a, folder, folders),
    );
}

/**
 * Count per folder pill, over the rows the OTHER filters let through — the
 * same contract as countStates/countTriggers. Every org folder gets an entry
 * (0 is a real count), so a folder nobody filed into yet stays discoverable.
 */
export function countFolders(rows: AutomationRecord[], folders: ProjectContextPillProject[] = []) {
    const counts: Record<string, number> = { all: rows.length, [NO_FOLDER]: 0 };
    for (const f of folders) counts[f.id] = 0;
    for (const a of rows) {
        const hit = a.folderId && Object.hasOwn(counts, a.folderId);
        if (hit && a.folderId) counts[a.folderId] += 1;
        else counts[NO_FOLDER] += 1;
    }
    return counts;
}

/** A folder's name in the filter: its path ("Finance / Invoices"), so two folders called "2026" can be told apart. */
export { folderPath as folderLabel } from '../../../automation/folderTree';

const ts = (v: DateLike) => {
    if (!v) return null;
    const n = new Date(v).getTime();
    return Number.isNaN(n) ? null : n;
};
const byName = (a: AutomationRecord, b: AutomationRecord) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' });
// Newest first, rows without a value last, ties by name so the order is stable.
const descNullsLast = (get: (a: AutomationRecord) => DateLike) => (a: AutomationRecord, b: AutomationRecord) => {
    const x = ts(get(a)); const y = ts(get(b));
    if (x === y) return byName(a, b);
    if (x == null) return 1;
    if (y == null) return -1;
    return y - x;
};
// Soonest first, rows without a value last.
const ascNullsLast = (get: (a: AutomationRecord) => DateLike) => (a: AutomationRecord, b: AutomationRecord) => {
    const x = ts(get(a)); const y = ts(get(b));
    if (x === y) return byName(a, b);
    if (x == null) return 1;
    if (y == null) return -1;
    return x - y;
};
const STATUS_RANK: Record<string, number> = { live: 0, draft: 1, paused: 2 };

export function sortRows(rows: AutomationRecord[], sort: string = 'updated') {
    const out = rows.slice();
    switch (sort) {
        case 'name': out.sort(byName); break;
        case 'lastRun': out.sort(descNullsLast(a => a.lastRunAt)); break;
        case 'nextRun': out.sort(ascNullsLast(a => a.nextRunAt)); break;
        case 'status':
            out.sort((a, b) => {
                // Failing automations float above the rest of their lane — they
                // are the reason someone sorts by status.
                const fa = isFailing(a) ? -1 : 0; const fb = isFailing(b) ? -1 : 0;
                if (fa !== fb) return fa - fb;
                const d = STATUS_RANK[lifecycleOf(a)] - STATUS_RANK[lifecycleOf(b)];
                return d !== 0 ? d : byName(a, b);
            });
            break;
        case 'updated':
        default: out.sort(descNullsLast(a => a.updatedAt || a.createdAt)); break;
    }
    return out;
}

/**
 * The board's columns. Every column in the vocabulary is returned — an empty
 * "Paused" lane says something ("nothing is switched off"); a lane that only
 * appears once something lands in it does not. Folders are the exception:
 * the lanes are the org's folders plus "No folder", in the order given.
 */
export function groupRows(rows: AutomationRecord[], groupBy: string = 'status', { folders = [], t }: { folders?: ProjectContextPillProject[] | null; t?: TranslateFn | null } = {}) {
    if (groupBy === 'trigger') {
        const lanes: OverviewLane[] = [...TRIGGER_KINDS, 'other'].map(k => ({ id: k, label: triggerLabelOf(k, t), rows: [] }));
        const idx = new Map<string, OverviewLane>(lanes.map(l => [l.id, l]));
        for (const a of rows) idx.get(triggerKindOf(a))?.rows.push(a);
        // "Other" only earns a lane when something is in it — it is a catch-all,
        // not a state anyone plans around.
        return lanes.filter(l => l.id !== 'other' || l.rows.length > 0);
    }
    if (groupBy === 'folder') {
        const known = new Map<string, OverviewLane>((folders || []).map(f => [f.id, { id: f.id, label: f.name || (t ? t('studio_misc.overview.untitled_folder', 'Untitled folder') : 'Untitled folder'), rows: [] }]));
        const loose: OverviewLane = { id: '__none', label: t ? t('studio_misc.overview.no_folder', 'No folder') : 'No folder', rows: [] };
        for (const a of rows) {
            const lane = a.folderId && known.get(a.folderId);
            (lane || loose).rows.push(a);
        }
        return [loose, ...known.values()];
    }
    const lanes: OverviewLane[] = ['live', 'paused', 'draft'].map(s => ({ id: s, label: statusLabelOf(s, t), rows: [] }));
    const idx = new Map<string, OverviewLane>(lanes.map(l => [l.id, l]));
    for (const a of rows) idx.get(lifecycleOf(a))?.rows.push(a);
    return lanes;
}
