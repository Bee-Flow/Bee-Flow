/**
 * Pure model behind AutomationsOverview — which rows show, in what order, in
 * which column. React-free so the views can be tested as data.
 *
 * The three vocabularies this leans on already exist elsewhere and are NOT
 * redefined here:
 *   - live / paused / draft   is `shared/statusOf.automation` (the Studio's
 *                             "is this thing on?" word, painted by the pill)
 *   - success / error / …     is `shared/statusTokens` (what the LAST RUN did)
 *   - the trigger kinds       are what RoutineRow already draws an icon for
 *
 * A row's "state" filter mixes the first two on purpose: someone opening an
 * overview asks "what is on, what is off, what is broken" — and broken is a
 * run outcome on a routine that is otherwise live.
 */
import { describeCron } from '../../../automation/Builder/flow/scheduleBuilderUtils';
import { automation as lifecycleOf } from '../../../shared/statusOf';

export const VIEWS = Object.freeze(['list', 'cards', 'board']);
export const SORTS = Object.freeze(['updated', 'name', 'lastRun', 'nextRun', 'status']);
export const GROUPS = Object.freeze(['status', 'trigger', 'folder']);
export const STATE_FILTERS = Object.freeze(['all', 'live', 'paused', 'draft', 'failing', 'running']);
export const TRIGGER_KINDS = Object.freeze(['schedule', 'manual', 'webhook', 'app_event']);

export const TRIGGER_LABEL = Object.freeze({
    schedule: 'Schedule',
    manual: 'Manual',
    webhook: 'Webhook',
    app_event: 'App event',
    other: 'Other',
});

export const STATUS_LABEL = Object.freeze({
    live: 'Live',
    paused: 'Paused',
    draft: 'Draft',
});

/** The trigger kind the way RoutineRow reads it — column first, definition second. */
export function triggerKindOf(a) {
    const kind = a?.triggerType || a?.definition?.trigger?.kind || 'manual';
    return TRIGGER_KINDS.includes(kind) ? kind : 'other';
}

/** "Every day at 09:00 · Europe/Amsterdam" — or the plain kind word. */
export function triggerTextOf(a) {
    const kind = triggerKindOf(a);
    if (kind === 'schedule' && a.scheduleCron) {
        return `${describeCron(a.scheduleCron)}${a.scheduleTz ? ` · ${a.scheduleTz}` : ''}`;
    }
    if (kind === 'app_event') {
        const ev = a.definition?.trigger?.appEvent;
        return ev ? `${ev.provider}.${ev.event}` : TRIGGER_LABEL.app_event;
    }
    return TRIGGER_LABEL[kind];
}

/** How many steps the definition holds; null when the row carries no definition. */
export function stepCountOf(a) {
    const steps = a?.definition?.steps;
    return Array.isArray(steps) ? steps.length : null;
}

/** The server spells a failed run both ways. */
export function isFailing(a) {
    return a?.lastStatus === 'error' || a?.lastStatus === 'failed';
}

export function isRunning(a, activeRunIds) {
    return a?.lastStatus === 'running' || !!activeRunIds?.has?.(a?.id);
}

function matchesState(a, state, activeRunIds) {
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
export function countStates(rows, activeRunIds) {
    const counts = Object.fromEntries(STATE_FILTERS.map(s => [s, 0]));
    for (const a of rows) {
        counts.all += 1;
        counts[lifecycleOf(a)] += 1;
        if (isFailing(a)) counts.failing += 1;
        if (isRunning(a, activeRunIds)) counts.running += 1;
    }
    return counts;
}

export function countTriggers(rows) {
    const counts = { all: rows.length };
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
 * elsewhere — counts as loose, the same rule FolderedRoutineList groups by and
 * the folder board lanes paint. Without `folders` every folderId is taken at
 * face value.
 */
function matchesFolder(a, folder, folders) {
    if (folder === 'all') return true;
    const known = folders ? new Set(folders.map(f => f.id)) : null;
    const fid = a.folderId && (!known || known.has(a.folderId)) ? a.folderId : null;
    return folder === NO_FOLDER ? fid === null : fid === folder;
}

export function filterRows(rows, { state = 'all', trigger = 'all', folder = 'all', folders = null, activeRunIds = null } = {}) {
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
export function countFolders(rows, folders = []) {
    const counts = { all: rows.length, [NO_FOLDER]: 0 };
    for (const f of folders) counts[f.id] = 0;
    for (const a of rows) {
        const hit = a.folderId && Object.hasOwn(counts, a.folderId);
        if (hit) counts[a.folderId] += 1;
        else counts[NO_FOLDER] += 1;
    }
    return counts;
}

const ts = (v) => {
    if (!v) return null;
    const n = new Date(v).getTime();
    return Number.isNaN(n) ? null : n;
};
const byName = (a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' });
// Newest first, rows without a value last, ties by name so the order is stable.
const descNullsLast = (get) => (a, b) => {
    const x = ts(get(a)); const y = ts(get(b));
    if (x === y) return byName(a, b);
    if (x == null) return 1;
    if (y == null) return -1;
    return y - x;
};
// Soonest first, rows without a value last.
const ascNullsLast = (get) => (a, b) => {
    const x = ts(get(a)); const y = ts(get(b));
    if (x === y) return byName(a, b);
    if (x == null) return 1;
    if (y == null) return -1;
    return x - y;
};
const STATUS_RANK = { live: 0, draft: 1, paused: 2 };

export function sortRows(rows, sort = 'updated') {
    const out = rows.slice();
    switch (sort) {
        case 'name': out.sort(byName); break;
        case 'lastRun': out.sort(descNullsLast(a => a.lastRunAt)); break;
        case 'nextRun': out.sort(ascNullsLast(a => a.nextRunAt)); break;
        case 'status':
            out.sort((a, b) => {
                // Failing routines float above the rest of their lane — they
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
export function groupRows(rows, groupBy = 'status', { folders = [] } = {}) {
    if (groupBy === 'trigger') {
        const lanes = [...TRIGGER_KINDS, 'other'].map(k => ({ id: k, label: TRIGGER_LABEL[k], rows: [] }));
        const idx = new Map(lanes.map(l => [l.id, l]));
        for (const a of rows) idx.get(triggerKindOf(a)).rows.push(a);
        // "Other" only earns a lane when something is in it — it is a catch-all,
        // not a state anyone plans around.
        return lanes.filter(l => l.id !== 'other' || l.rows.length > 0);
    }
    if (groupBy === 'folder') {
        const known = new Map((folders || []).map(f => [f.id, { id: f.id, label: f.name || 'Untitled folder', rows: [] }]));
        const loose = { id: '__none', label: 'No folder', rows: [] };
        for (const a of rows) {
            const lane = a.folderId && known.get(a.folderId);
            (lane || loose).rows.push(a);
        }
        return [loose, ...known.values()];
    }
    const lanes = ['live', 'paused', 'draft'].map(s => ({ id: s, label: STATUS_LABEL[s], rows: [] }));
    const idx = new Map(lanes.map(l => [l.id, l]));
    for (const a of rows) idx.get(lifecycleOf(a)).rows.push(a);
    return lanes;
}
