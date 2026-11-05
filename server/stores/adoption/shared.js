// @typecheck strict
/**
 * The pieces every part of the Adoption read model shares: the lazy
 * dependencies, the period and its ISO weeks, the members of an organisation,
 * a member's status, and the WHERE of a ledger read.
 *
 * Organisation-wide by construction: every function takes the organisation id
 * the route read from the session, and every query filters on it first. Nothing
 * here reads a query parameter.
 */

'use strict';

const { buildFilters } = require('../usage/filters');
const { SOURCES, AREAS, areaOf } = require('../../shared/usageAreas');
const { PLATFORM_OPERATOR_ID } = require('../../auth/platformOperator');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** A member not seen for this long is dormant. */
const DORMANT_AFTER_MS = 30 * DAY_MS;
/**
 * The timeline answers at most this many weeks (half a year). A longer period
 * keeps its LAST 27 weeks rather than folding into months: the chart is a
 * weekly chart, and its totals elsewhere in the report still cover the whole
 * period. The answer is not partial for it; the clamp is the definition.
 */
const MAX_WEEKS = 27;

/**
 * @typedef {{ startDate: string, endDate: string, days: number | null, relative: boolean }} Period
 * @typedef {{ orgId: string, period: Period, groupId?: string | null, now: number }} Scope
 * @typedef {{ week: string, start: string, end: string, complete: boolean }} IsoWeek
 * @typedef {{
 *   id: string, username?: string | null, displayName?: string | null, groups?: unknown,
 *   organizationId?: string | null, orgRole?: string | null, role?: string | null,
 *   status?: string | null, isSystem?: boolean, createdAt?: string | null,
 *   lastSeenAt?: string | Date | null, last_seen_at?: string | Date | null,
 *   avatarType?: string | null,
 * }} UserRow
 * @typedef {{ id: string, name?: string | null, organizationId?: string | null, source?: string | null, azureGroupId?: string | null }} GroupRow
 * @typedef {{ member: UserRow, groupIds: string[] }} Member
 */

/**
 * A dependency object whose modules are required on first touch (the
 * routes/studio/shared.js makeLazyDeps shape, here so a store does not reach
 * up into routes/).
 * @template {Record<string, () => any>} L
 * @param {L} loaders
 * @returns {{ [K in keyof L]: ReturnType<L[K]> }}
 */
function makeLazyDeps(loaders) {
    /** @type {Record<string, any>} */
    const memo = {};
    const deps = {};
    for (const [name, load] of Object.entries(loaders)) {
        Object.defineProperty(deps, name, {
            enumerable: true,
            get() { if (!(name in memo)) memo[name] = load(); return memo[name]; },
        });
    }
    return /** @type {{ [K in keyof L]: ReturnType<L[K]> }} */ (deps);
}

const DEFAULT_LOADERS = {
    db: () => require('../../db'),
    userStore: () => require('../userStore'),
    seats: () => require('../../license/seats'),
    isPlatformOperator: () => require('../../auth/platformOperator').isPlatformOperator,
};

/** @typedef {ReturnType<typeof defaultDeps>} AdoptionDeps */
function defaultDeps() {
    return makeLazyDeps(DEFAULT_LOADERS);
}

// ── Period ────────────────────────────────────────────────────────────────

/**
 * The period of a request: the window the usage scope built (startDate and
 * endDate are always set by routes/usageScope.js), and whether it came from
 * `days` (relative) or an explicit window.
 * @param {{ startDate?: string, endDate?: string }} filters
 * @param {{ days?: unknown, startDate?: unknown, endDate?: unknown }} query
 * @param {number} now
 * @returns {Period}
 */
function periodOf(filters, query, now) {
    const relative = !(query.startDate && query.endDate);
    const days = relative ? (Number(query.days) || 30) : null;
    const endDate = filters.endDate || new Date(now).toISOString();
    const startDate = filters.startDate || new Date(now - (days || 30) * DAY_MS).toISOString();
    return { startDate: new Date(startDate).toISOString(), endDate: new Date(endDate).toISOString(), days, relative };
}

/**
 * The period of the same length immediately before.
 * @param {Period} period
 * @returns {Period}
 */
function previousPeriod(period) {
    const start = Date.parse(period.startDate);
    const end = Date.parse(period.endDate);
    const len = Math.max(0, end - start);
    return { startDate: new Date(start - len).toISOString(), endDate: new Date(start).toISOString(), days: period.days, relative: period.relative };
}

/**
 * Midnight UTC of the Monday of the week holding `ms`.
 * @param {number} ms
 */
function mondayOf(ms) {
    const d = new Date(ms);
    const day = d.getUTCDay() || 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - (day - 1) * DAY_MS;
}

/**
 * The ISO week label of the week starting on `mondayMs`: "2026-W41".
 * @param {number} mondayMs
 */
function isoWeekLabel(mondayMs) {
    const thursday = new Date(mondayMs + 3 * DAY_MS);
    const year = thursday.getUTCFullYear();
    const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / WEEK_MS) + 1;
    return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * The ISO weeks (Monday start, UTC) that cover [start, end], oldest first,
 * clamped to the last MAX_WEEKS. `complete` is true for a week that ended by `now`.
 * @param {string} start
 * @param {string} end
 * @param {number} now
 * @returns {IsoWeek[]}
 */
function isoWeeksOf(start, end, now) {
    const endMs = Date.parse(end);
    /** @type {IsoWeek[]} */
    const weeks = [];
    for (let at = mondayOf(Date.parse(start)); at <= endMs; at += WEEK_MS) {
        weeks.push({
            week: isoWeekLabel(at),
            start: new Date(at).toISOString(),
            end: new Date(at + WEEK_MS).toISOString(),
            complete: at + WEEK_MS <= now,
        });
    }
    return weeks.slice(-MAX_WEEKS);
}

/**
 * The SQL that buckets a timestamp column by its ISO week, as the date of the
 * Monday ("2026-10-05"): match it with `weekKey`.
 * @param {string} column
 */
function weekBucketSql(column) {
    return `to_char(date_trunc('week', ${column} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
}

/** @param {IsoWeek} w */
function weekKey(w) {
    return w.start.slice(0, 10);
}

// ── Members ───────────────────────────────────────────────────────────────

/**
 * @param {unknown} groups
 * @returns {string[]}
 */
function groupIdsOf(groups) {
    if (Array.isArray(groups)) return groups.map(String);
    if (typeof groups !== 'string' || groups === '') return [];
    try {
        const parsed = JSON.parse(groups);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
}

/**
 * The members of an organisation, by the rule learning/orgOverview.js
 * orgMembers applies: the organisation's own users plus the users in one of
 * its groups, without system rows, the platform operator, pending invitations
 * and guest accounts. With `groupId`, only the members of that group of THIS
 * organisation: a group of another organisation narrows to nobody.
 * @param {AdoptionDeps} d
 * @param {string} orgId
 * @param {string | null} [groupId]
 * @returns {Promise<{ members: Member[], groups: GroupRow[] }>}
 */
async function resolveMembers(d, orgId, groupId = null) {
    const [users, allGroups] = await Promise.all([d.userStore.getAllUsers(), d.userStore.getAllGroups()]);
    /** @type {GroupRow[]} */
    const groups = (allGroups || []).filter((/** @type {GroupRow} */ g) => g && g.organizationId === orgId);
    const orgGroupIds = new Set(groups.map((g) => String(g.id)));
    /** @type {Member[]} */
    const members = [];
    for (const u of /** @type {UserRow[]} */ (users || [])) {
        if (!u || !u.id || u.isSystem || d.isPlatformOperator(u)) continue;
        if (u.status === 'pending' || String(u.id).startsWith('guest_')) continue;
        const groupIds = groupIdsOf(u.groups).filter((gid) => orgGroupIds.has(gid));
        if (u.organizationId !== orgId && groupIds.length === 0) continue;
        members.push({ member: u, groupIds });
    }
    if (!groupId) return { members, groups };
    if (!orgGroupIds.has(String(groupId))) return { members: [], groups: [] };
    return {
        members: members.filter((m) => m.groupIds.includes(String(groupId))),
        groups: groups.filter((g) => String(g.id) === String(groupId)),
    };
}

/**
 * @param {string | Date | null | undefined} value
 * @returns {number | null}
 */
function timeOf(value) {
    if (value == null || value === '') return null;
    const t = value instanceof Date ? value.getTime() : Date.parse(String(value));
    return Number.isFinite(t) ? t : null;
}

/** @param {UserRow} u */
function lastSeenOf(u) {
    return timeOf(u.lastSeenAt ?? u.last_seen_at ?? null);
}

/**
 * A member's status in the period: AI-active (a ledger row as the actor), and
 * for a relative period, seen only, dormant or never from last_seen_at. An
 * absolute window cannot be read from a "last seen" clock, so it answers
 * 'unknown' for everyone who is not AI-active.
 * @param {UserRow} u
 * @param {boolean} aiActive
 * @param {Period} period
 * @param {number} now
 * @returns {'ai_active' | 'seen_only' | 'dormant' | 'never' | 'unknown'}
 */
function memberStatus(u, aiActive, period, now) {
    if (aiActive) return 'ai_active';
    if (!period.relative) return 'unknown';
    const seen = lastSeenOf(u);
    const created = timeOf(u.createdAt);
    if (seen != null && seen >= Date.parse(period.startDate)) return 'seen_only';
    if (seen != null) return seen < now - DORMANT_AFTER_MS ? 'dormant' : 'unknown';
    if (created != null && created >= now - DORMANT_AFTER_MS) return 'never';
    return 'dormant';
}

/**
 * @param {UserRow} u
 * @param {Period} period
 */
function joinedInPeriod(u, period) {
    const created = timeOf(u.createdAt);
    return created != null && created >= dayStartOf(Date.parse(period.startDate)) && created <= Date.parse(period.endDate);
}

/**
 * Midnight UTC of the day holding `ms` (createdAt is a date without a time).
 * @param {number} ms
 */
function dayStartOf(ms) {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// ── The ledger ────────────────────────────────────────────────────────────

/** The person behind a ledger row: who caused it, else whose account paid. */
const ACTOR_SQL = 'COALESCE(actor_user_id, user_id)';

/**
 * The WHERE of an organisation's ledger rows in a period: buildFilters for the
 * period and organisation (tool rows out, so a call is counted once), guest
 * rows out, and with `actors` only the rows caused by those people (a group).
 * @param {{ orgId: string, startDate: string, endDate: string, actors?: string[] | null }} opts
 * @param {number} [startIdx]
 * @returns {{ where: string, params: unknown[], nextIdx: number }}
 */
function ledgerWhere({ orgId, startDate, endDate, actors = null }, startIdx = 1) {
    const base = buildFilters({ startDate, endDate, organizationId: orgId }, startIdx, true);
    const params = [...base.params, PLATFORM_OPERATOR_ID];
    let idx = base.nextIdx + 1;
    const conditions = [
        base.where.replace(/^WHERE /, ''),
        // The platform operator is nobody's member (learning/orgOverview.js).
        `${ACTOR_SQL} IS DISTINCT FROM $${base.nextIdx}`,
        `COALESCE(${ACTOR_SQL}, '') NOT LIKE 'guest\\_%'`,
    ];
    if (actors) {
        conditions.push(`${ACTOR_SQL} = ANY($${idx++}::text[])`);
        params.push(actors);
    }
    return { where: `WHERE ${conditions.join(' AND ')}`, params, nextIdx: idx };
}

/**
 * The source → area table as two parallel arrays, for a `unnest` join.
 * @returns {[string[], string[]]}
 */
function areaMapArrays() {
    const sources = Object.keys(SOURCES);
    return [sources, sources.map((s) => areaOf(s))];
}

/**
 * The sources whose area is `areaId`.
 * @param {string} areaId
 */
function sourcesOfArea(areaId) {
    return Object.keys(SOURCES).filter((s) => areaOf(s) === areaId);
}

/**
 * The area whose spend belongs to a Studio kind, or null.
 * @param {string} kind
 */
function areaOfKind(kind) {
    return AREAS.find((a) => a.kind === kind)?.id || null;
}

/** @param {unknown} v */
function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/**
 * The member ids a scope narrows the ledger to: null without a group (every
 * row of the organisation), the group's members with one.
 * @param {Scope} scope
 * @param {Member[]} members
 */
function actorsFor(scope, members) {
    return scope.groupId ? members.map((m) => String(m.member.id)) : null;
}

/**
 * @param {number} part
 * @param {number} whole
 */
function percent(part, whole) {
    return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

/**
 * Change against the previous figure in percent, null when there is nothing to compare.
 * @param {number} now
 * @param {number | null | undefined} before
 */
function deltaPct(now, before) {
    if (before == null || !(before > 0)) return null;
    return Math.round(((now - before) / before) * 1000) / 10;
}

module.exports = {
    DAY_MS, MAX_WEEKS, DORMANT_AFTER_MS, ACTOR_SQL,
    makeLazyDeps, defaultDeps, DEFAULT_LOADERS,
    periodOf, previousPeriod, isoWeeksOf, isoWeekLabel, mondayOf, weekBucketSql, weekKey,
    groupIdsOf, resolveMembers, memberStatus, joinedInPeriod, lastSeenOf, timeOf,
    ledgerWhere, areaMapArrays, sourcesOfArea, areaOfKind, actorsFor, num, percent, deltaPct,
};
