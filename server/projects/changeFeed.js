// @typecheck
/**
 * What changed in a project: the writer every content path calls, and the
 * reader behind GET /api/projects/:id/changes.
 *
 *   recordContentChange({ projectId, itemType, itemId, contributors, stats, versionId, source })
 *   recordItemCreated / recordItemRenamed / recordItemMoved({ projectId, itemType, itemId, actorId, ... })
 *   recordProjectChange(projectId, actorId, action, details)   the audit row + its event, one transaction
 *   summarizeChanges(rows, { state, reads, groupBy })          rows → groups (pure)
 *   changeWindow(since, state, now)                            where "since your last visit" starts (pure)
 *
 * ── Quiet by design ─────────────────────────────────────────────────────────
 *
 * - One row per item per person per editing session (stores/projectChanges.js
 *   folds the saves); a folded edit tells the members again only every
 *   EMIT_EVERY_MS, never per autosave.
 * - The AI's edit made for somebody is folded into that person's row and
 *   flagged (`aiAssisted`): "Anna, with AI". AI work nobody asked for in
 *   particular has its own row (actor kind 'ai').
 * - Edits of a few words are flagged `minor`, so a reader can keep them folded.
 * - The reader never sees their own changes here.
 *
 * ── Counts only ─────────────────────────────────────────────────────────────
 *
 * Rows and events carry ids, counts and flags. Titles are resolved when READ,
 * with the reader's access (projects/changeTitles.js), and never stored.
 *
 * ── Best effort ─────────────────────────────────────────────────────────────
 *
 * The recorders never throw: a change that saved correctly has not failed
 * because the feed could not note it. Failures are logged with ids only.
 */

'use strict';

const { mergeContributors } = require('../core/versioning/contributors');
const { addStats, cleanStats, isMinorChange } = require('../core/versioning/stats');

/** A pause longer than this between two edits of one person starts a new session. */
const SESSION_GAP_MS = 10 * 60 * 1000;
/** A session being folded into re-announces itself at most this often. */
const EMIT_EVERY_MS = 2 * 60 * 1000;
/** A new visit starts after this long without one. */
const VISIT_GAP_MS = 30 * 60 * 1000;
/** How far back unread marks and explicit windows look. */
const UNREAD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_GROUPS = 50;
const MAX_AGENT_IDS = 5;

/** The item kinds content changes are recorded for. */
const ITEM_TYPES = Object.freeze(['notebook', 'document', 'meeting']);

/** Version sources that are an edit of the content. */
const EDIT_SOURCES = new Set(['checkpoint', 'autosave', 'ai']);
/**
 * Sources that are not a change anybody made: the first state (the item's
 * creation is reported when it is created or filed), a snapshot taken before
 * a restore (the restore itself is reported), a conflict copy (the current
 * content did not change), content seeded from an older store.
 */
const QUIET_SOURCES = new Set(['created', 'pre_restore', 'conflict', 'import', 'legacy']);

/** What kind of change an activity action is, as the reader's groups name it. */
const KIND_OF_ACTION = Object.freeze({
    'content.edited': 'edited',
    'content.created': 'added',
    'content.moved_in': 'added',
    resource_added: 'added',
    'content.moved_out': 'removed',
    resource_removed: 'removed',
    'content.renamed': 'renamed',
    'content.restored': 'restored',
    'content.version_named': 'named',
});

const idOf = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const isItemType = (t) => ITEM_TYPES.includes(String(t));

/**
 * The rows one content change becomes: one per person (the AI acting for a
 * person folds into theirs), one for AI work nobody asked for in particular,
 * and a 'system' row when nobody is known at all.
 */
function actorsOf(contributors) {
    const actors = new Map();
    for (const c of mergeContributors(contributors)) {
        const key = c.userId ? `user:${c.userId}` : 'ai';
        const actor = actors.get(key) || {
            actorKind: c.userId ? 'user' : 'ai',
            actorId: c.userId || null,
            ai: false,
            agentIds: [],
        };
        if (c.kind === 'ai') {
            actor.ai = true;
            if (c.agentId && !actor.agentIds.includes(c.agentId)) actor.agentIds.push(c.agentId);
        }
        actors.set(key, actor);
    }
    if (!actors.size) actors.set('system', { actorKind: 'system', actorId: null, ai: false, agentIds: [] });
    return [...actors.values()];
}

/** `stats` shared across `n` rows so that summing the rows gives the whole again. */
function shareOf(stats, n, index) {
    const s = cleanStats(stats || {});
    const part = (v) => Math.floor(v / n) + (index < v % n ? 1 : 0);
    return { wordsAdded: part(s.wordsAdded), wordsRemoved: part(s.wordsRemoved), blocksChanged: part(s.blocksChanged) };
}

/** Were word counts given for this edit? Unknown is not zero: it never reads as a small edit. */
const countsKnown = (stats) => !!stats && typeof stats === 'object'
    && ['wordsAdded', 'wordsRemoved', 'blocksChanged'].some((k) => Number.isFinite(Number(stats[k])) && stats[k] !== null);

/** Fold one more edit into a session's details (or start them). */
function mergeSessionDetails(previous, { itemType, itemId, stats, actor, source }) {
    const prev = previous && typeof previous === 'object' ? previous : null;
    const total = addStats(prev ? prev.stats : null, stats);
    const unknownCounts = !!prev?.unknownCounts || !countsKnown(stats);
    const agentIds = [...new Set([...(Array.isArray(prev?.agentIds) ? prev.agentIds : []), ...actor.agentIds])].slice(0, MAX_AGENT_IDS);
    return {
        itemType,
        itemId,
        targetType: itemType,
        targetId: itemId,
        changes: (Number(prev?.changes) || 0) + 1,
        stats: total,
        aiAssisted: !!prev?.aiAssisted || actor.ai,
        agentIds,
        minor: !unknownCounts && isMinorChange(total),
        ...(unknownCounts ? { unknownCounts: true } : {}),
        source,
    };
}

function sessionPayload(details, activityId, versionId) {
    return {
        itemType: details.itemType,
        itemId: details.itemId,
        activityId,
        versionId: versionId || null,
        changes: details.changes,
        wordsAdded: details.stats.wordsAdded,
        wordsRemoved: details.stats.wordsRemoved,
        blocksChanged: details.stats.blocksChanged,
        aiAssisted: details.aiAssisted,
        minor: details.minor,
    };
}

/**
 * @param {object} [deps]
 * @param {object} [deps.store]    projectStore surface (recordContentSession, recordActivityEvent)
 * @param {(projectId: string, event: object) => Promise<void>} [deps.publish]  the doorbell
 * @param {object} [deps.log]
 */
function makeChangeFeed(deps = {}) {
    const store = () => deps.store || require('../stores/projectStore');
    const log = deps.log || require('../telemetry/log');
    const publish = async (projectId, event) => {
        if (!event) return;
        try {
            await (deps.publish || require('../core/projectEventBus').publishProjectEvent)(projectId, event);
        } catch (err) {
            log.warn('[ChangeFeed] publish failed:', err.message);
        }
    };

    /** One audit row + event, then the doorbell. Resolves to the stored event or null. */
    async function recordOne(projectId, entry) {
        const out = await store().recordActivityEvent(projectId, entry);
        if (out && out.event) await publish(projectId, out.event);
        return out;
    }

    /**
     * A version (or checkpoint) of a notebook or document in a project was
     * written. See the header; `source` is the version's source.
     *
     * @param {{ projectId?: string|null, itemType: string, itemId: string, contributors?: unknown[],
     *   stats?: object|null, versionId?: string|null, source?: string }} change
     * @returns {Promise<{ recorded: number }>}
     */
    async function recordContentChange(change) {
        const c = change || /** @type {any} */ ({});
        const projectId = idOf(c.projectId);
        const itemId = idOf(c.itemId);
        const source = typeof c.source === 'string' ? c.source : 'checkpoint';
        if (!projectId || !itemId || !isItemType(c.itemType) || QUIET_SOURCES.has(source)) return { recorded: 0 };
        const versionId = idOf(c.versionId);
        try {
            const actors = actorsOf(c.contributors);
            if (source === 'restore' || source === 'named') {
                if (source === 'named' && !versionId) return { recorded: 0 };
                // One entry, for whoever did it: a restore or a name is a
                // deliberate act, not a session to fold.
                const actor = actors[0];
                const details = {
                    itemType: c.itemType, itemId, targetType: c.itemType, targetId: itemId,
                    ...(source === 'restore' ? { stats: cleanStats(c.stats || {}) } : {}),
                };
                const out = await recordOne(projectId, {
                    action: source === 'restore' ? 'content.restored' : 'content.version_named',
                    actorId: actor.actorId,
                    actorKind: actor.actorKind,
                    targetType: c.itemType,
                    targetId: itemId,
                    itemType: c.itemType,
                    itemId,
                    versionId,
                    details,
                    payload: { ...details, versionId },
                });
                return { recorded: out ? 1 : 0 };
            }
            if (!EDIT_SOURCES.has(source)) return { recorded: 0 };
            let recorded = 0;
            for (const [index, actor] of actors.entries()) {
                // Unknown counts stay unknown (null): never read as zero, never as a small edit.
                const stats = countsKnown(c.stats) ? shareOf(c.stats, actors.length, index) : null;
                const out = await store().recordContentSession(projectId, {
                    itemType: c.itemType,
                    itemId,
                    actorId: actor.actorId,
                    actorKind: actor.actorKind,
                    versionId,
                    sessionGapMs: SESSION_GAP_MS,
                    emitEveryMs: EMIT_EVERY_MS,
                    merge: (previous) => mergeSessionDetails(previous, { itemType: c.itemType, itemId, stats, actor, source }),
                    eventOf: (details, activityId) => ({ kind: 'content.edited', payload: sessionPayload(details, activityId, versionId) }),
                });
                if (!out) continue;
                recorded += 1;
                await publish(projectId, out.event);
            }
            return { recorded };
        } catch (err) {
            log.warn(`[ChangeFeed] content change not recorded (project ${projectId}, ${c.itemType} ${itemId}):`, err.message);
            return { recorded: 0 };
        }
    }

    /** A one-off item event (created, renamed, moved) — never folded. */
    async function recordItemEvent(action, { projectId, itemType, itemId, actorId = null, actorKind, agentId } = /** @type {any} */ ({})) {
        const pid = idOf(projectId);
        const id = idOf(itemId);
        if (!pid || !id || !isItemType(itemType)) return { recorded: 0 };
        const kind = actorKind === 'ai' || actorKind === 'system' ? actorKind : (actorId ? 'user' : 'system');
        const details = { itemType, itemId: id, targetType: itemType, targetId: id, ...(idOf(agentId) ? { agentIds: [idOf(agentId)] } : {}) };
        try {
            const out = await recordOne(pid, {
                action, actorId: idOf(actorId), actorKind: kind, targetType: itemType, targetId: id, itemType, itemId: id, details,
            });
            return { recorded: out ? 1 : 0 };
        } catch (err) {
            log.warn(`[ChangeFeed] ${action} not recorded (project ${pid}, ${itemType} ${id}):`, err.message);
            return { recorded: 0 };
        }
    }

    return {
        recordContentChange,
        /** An item was created inside the project (use instead of, not next to, a resource_added row). */
        recordItemCreated: (e) => recordItemEvent('content.created', e),
        /** An item's title changed. The title itself is never recorded. */
        recordItemRenamed: (e) => recordItemEvent('content.renamed', e),
        /** An item was filed into (`direction: 'in'`) or taken out of the project. */
        recordItemMoved: (e) => recordItemEvent(e && e.direction === 'out' ? 'content.moved_out' : 'content.moved_in', e),
        /**
         * The audit row and the live event of any project action, in ONE
         * transaction, then the doorbell: the transactional form of the
         * routes' `logAndEmit`. `details` must hold ids and counts only.
         */
        async recordProjectChange(projectId, actorId, action, details = {}) {
            if (!idOf(projectId) || !action) return null;
            try {
                return await recordOne(projectId, {
                    action,
                    actorId: idOf(actorId),
                    actorKind: actorId ? 'user' : 'system',
                    targetType: details.targetType || null,
                    targetId: details.targetId || null,
                    details,
                });
            } catch (err) {
                log.warn(`[ChangeFeed] ${action} not recorded (project ${projectId}):`, err.message);
                return null;
            }
        },
    };
}

// ── Reading ───────────────────────────────────────────────────────────────

const timeOf = (v) => {
    let n = NaN;
    if (v instanceof Date) n = v.getTime();
    else if (typeof v === 'number') n = v;
    else if (typeof v === 'string' && v) n = Date.parse(v);
    return Number.isFinite(n) ? n : NaN;
};
const latest = (...values) => {
    const times = values.map(timeOf).filter(Number.isFinite);
    return times.length ? Math.max(...times) : NaN;
};

/**
 * Where a window starts, as a Date, or null when there is nothing to show yet.
 *
 *   'visit'   since the previous visit, or since "mark everything as seen" if
 *             that came later. A first visit has no previous one: nothing.
 *   'unread'  since the member's watermark (first visit, or everything marked
 *             seen), at most UNREAD_WINDOW_MS back. No state: nothing.
 *   ISO time  since then, at most MAX_WINDOW_MS back.
 *
 * @param {string} since
 * @param {{ prevVisitAt?: string|null, seenAt?: string|null, firstVisitAt?: string|null } | null} state
 * @param {number} [now]
 * @returns {Date|null}
 */
function changeWindow(since, state, now = Date.now()) {
    if (since === 'visit') {
        if (!state || !state.prevVisitAt) return null;
        const at = latest(state.prevVisitAt, state.seenAt);
        return Number.isFinite(at) ? new Date(at) : null;
    }
    if (since === 'unread') {
        if (!state) return null;
        const at = latest(state.seenAt, state.firstVisitAt, now - UNREAD_WINDOW_MS);
        return new Date(at);
    }
    const at = timeOf(since);
    if (!Number.isFinite(at)) return null;
    return new Date(Math.max(at, now - MAX_WINDOW_MS));
}

/** The reader's watermark for one item: the latest of "seen it", "seen everything" and "first came". */
function watermarkOf(state, read) {
    if (!state) return NaN;
    return latest(read && read.seenAt, state.seenAt, state.firstVisitAt);
}

function contributorsOfRow(row) {
    const d = row.details || {};
    if (row.actorKind === 'user' && row.actorId) {
        return d.aiAssisted
            ? [{ userId: row.actorId, kind: 'user' }, { userId: row.actorId, kind: 'ai' }]
            : [{ userId: row.actorId, kind: 'user' }];
    }
    if (row.actorKind === 'ai') return [{ userId: null, kind: 'ai' }];
    return [];
}

/**
 * Change rows (newest first, the reader's own already left out) as groups.
 *
 * @param {Array<object>} rows   stores/projectChanges.listChangeRows
 * @param {{ state?: object|null, reads?: Map<string, {seenAt: string|null, seenVersionId: string|null}>,
 *   groupBy?: 'item'|'person', onlyUnread?: boolean }} [opts]
 */
function summarizeChanges(rows, { state = null, reads = new Map(), groupBy = 'item', onlyUnread = false } = {}) {
    const byItem = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        const type = row.itemType || row.targetType;
        const id = row.itemId || row.targetId;
        const kind = KIND_OF_ACTION[row.action];
        if (!type || !id || !kind || !isItemType(type)) continue;
        const key = `${type}:${id}`;
        const at = timeOf(row.updatedAt || row.createdAt);
        let g = byItem.get(key);
        if (!g) {
            g = {
                item: { type, id },
                lastAt: at,
                changeCount: 0,
                contributors: [],
                stats: cleanStats({}),
                latestVersionId: null,
                kinds: new Set(),
                aiAssisted: false,
                minor: true,
                rows: [],
            };
            byItem.set(key, g);
        }
        const d = row.details || {};
        g.lastAt = Number.isFinite(g.lastAt) ? Math.max(g.lastAt, at || 0) : at;
        g.changeCount += Number(d.changes) > 0 ? Number(d.changes) : 1;
        g.contributors = mergeContributors(g.contributors, contributorsOfRow(row));
        if (d.stats) g.stats = addStats(g.stats, d.stats);
        if (!g.latestVersionId && row.versionId) g.latestVersionId = row.versionId;
        g.kinds.add(kind);
        g.aiAssisted = g.aiAssisted || !!d.aiAssisted || row.actorKind === 'ai';
        g.minor = g.minor && row.action === 'content.edited' && !!d.minor;
        g.rows.push(row);
    }

    const groups = [...byItem.values()].map((g) => {
        const key = `${g.item.type}:${g.item.id}`;
        const read = reads.get(key) || null;
        const mark = watermarkOf(state, read);
        return {
            item: g.item,
            lastChangedAt: Number.isFinite(g.lastAt) ? new Date(g.lastAt).toISOString() : null,
            changeCount: g.changeCount,
            contributors: g.contributors,
            stats: g.stats,
            latestVersionId: g.latestVersionId,
            seenVersionId: read ? read.seenVersionId : null,
            // When they saw it: should that version no longer be kept, the
            // history compares from the state of this moment instead.
            seenAt: read ? read.seenAt : null,
            kinds: [...g.kinds],
            aiAssisted: g.aiAssisted,
            minor: g.minor,
            unread: Number.isFinite(mark) && Number.isFinite(g.lastAt) && g.lastAt > mark,
            rows: g.rows,
        };
    })
        .filter((g) => !onlyUnread || g.unread)
        .sort((a, b) => timeOf(b.lastChangedAt) - timeOf(a.lastChangedAt));

    if (groupBy !== 'person') return groups.slice(0, MAX_GROUPS).map(({ rows: _r, ...g }) => g);

    // By person: every contributor of a group gets the item under their name.
    const byPerson = new Map();
    for (const g of groups) {
        for (const row of g.rows) {
            for (const c of contributorsOfRow(row)) {
                if (c.kind === 'ai' && c.userId) continue; // folded into the person
                const key = `${c.kind}:${c.userId || ''}`;
                const p = byPerson.get(key) || {
                    person: { userId: c.userId, kind: c.kind },
                    lastAt: NaN, changeCount: 0, stats: cleanStats({}), items: [], unread: false, aiAssisted: false,
                };
                const d = row.details || {};
                p.lastAt = latest(p.lastAt, row.updatedAt || row.createdAt);
                p.changeCount += Number(d.changes) > 0 ? Number(d.changes) : 1;
                if (d.stats) p.stats = addStats(p.stats, d.stats);
                if (!p.items.some((i) => i.type === g.item.type && i.id === g.item.id)) p.items.push(g.item);
                p.unread = p.unread || g.unread;
                p.aiAssisted = p.aiAssisted || !!d.aiAssisted;
                byPerson.set(key, p);
            }
        }
    }
    return [...byPerson.values()]
        .sort((a, b) => b.lastAt - a.lastAt)
        .slice(0, MAX_GROUPS)
        .map(({ lastAt, ...p }) => ({ ...p, lastChangedAt: Number.isFinite(lastAt) ? new Date(lastAt).toISOString() : null }));
}

const feed = makeChangeFeed();

module.exports = {
    makeChangeFeed,
    recordContentChange: feed.recordContentChange,
    recordItemCreated: feed.recordItemCreated,
    recordItemRenamed: feed.recordItemRenamed,
    recordItemMoved: feed.recordItemMoved,
    recordProjectChange: feed.recordProjectChange,
    summarizeChanges,
    changeWindow,
    ITEM_TYPES,
    SESSION_GAP_MS,
    EMIT_EVERY_MS,
    VISIT_GAP_MS,
};
