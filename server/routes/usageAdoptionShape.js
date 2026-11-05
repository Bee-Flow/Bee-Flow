// @typecheck strict
/**
 * What leaves the server from the Adoption report (routes/usageAdoption.js):
 * the store's answers seen through the caller's cost lens (routes/usageRedact.js
 * costLens: raw cost and calls, or marked-up cost and no calls), and people
 * as their pseudonym unless the request revealed them.
 *
 * Every person-facing field is built from an explicit list here, so a column
 * the store adds later does not reach the client by being spread along.
 */

'use strict';

const INLINE_AVATAR_MAX_CHARS = 2048;

/**
 * @typedef {import('./usageRedact').CostLens} CostLens
 * @typedef {Awaited<ReturnType<typeof import('../stores/adoption/summary').getSummary>>} Summary
 * @typedef {Awaited<ReturnType<import('../stores/adoptionStore').AdoptionStore['areas']>>} Areas
 * @typedef {Awaited<ReturnType<typeof import('../stores/adoption/studio').getStudioOverview>>} Studio
 * @typedef {NonNullable<Awaited<ReturnType<typeof import('../stores/adoption/studioItems').getStudioItems>>>} Items
 * @typedef {Awaited<ReturnType<typeof import('../stores/adoption/groups').getGroups>>} Groups
 * @typedef {import('../stores/adoption/people').PersonRow} PersonRow
 * @typedef {{ id: string, avatarType?: string | null, avatar?: string | null }} AvatarRow
 * @typedef {{
 *   lens: CostLens, reveal: boolean, pseudonym: (userId: string) => string,
 *   groupNames: Map<string, string>, avatars: Map<string, AvatarRow>,
 * }} PersonContext
 */

/**
 * The avatar a row may carry inline: a short URL or an emoji, never an inline
 * image (the routes/usage.js rule, same limit).
 * @param {unknown} avatar
 */
function inlineAvatar(avatar) {
    return typeof avatar === 'string' && avatar.length > 0 && avatar.length <= INLINE_AVATAR_MAX_CHARS ? avatar : null;
}

/**
 * @param {CostLens} lens
 * @param {{ calls?: number, cost: number | null }} row
 */
function figures(lens, row) {
    return { calls: lens.calls(row.calls), cost: lens.cost(row.cost) };
}

/**
 * @param {Summary} s
 * @param {CostLens} lens
 */
function shapeSummary(s, lens) {
    return {
        ...s,
        spend: { ...figures(lens, s.spend), people: s.spend.people, perActiveMember: lens.cost(s.spend.perActiveMember) },
        prev: s.prev ? { aiActive: s.prev.aiActive, adoptionRate: s.prev.adoptionRate, ...figures(lens, s.prev) } : null,
    };
}

/**
 * @param {Areas} a
 * @param {CostLens} lens
 */
function shapeAreas(a, lens) {
    return {
        areas: a.areas.map((r) => ({
            ...r, ...figures(lens, r),
            sources: r.sources.map((s) => ({ source: s.source, ...figures(lens, s) })),
        })),
        timeline: {
            weeks: a.timeline.weeks.map((w) => ({
                ...w,
                total: lens.cost(w.total),
                byArea: Object.fromEntries(Object.entries(w.byArea).map(([k, v]) => [k, lens.cost(v)])),
            })),
        },
        partial: a.partial,
    };
}

/**
 * @param {Studio} s
 * @param {CostLens} lens
 */
function shapeStudio(s, lens) {
    return {
        kinds: s.kinds.map((k) => ({
            ...k,
            cost: lens.cost(k.cost),
            // Without a usage signal the trend is the area's cost per week.
            trend: k.usage ? k.trend : k.trend.map((v) => lens.cost(v) ?? 0),
        })),
        partial: s.partial,
    };
}

/**
 * @param {Items} out
 * @param {CostLens} lens
 * @param {(userId: string) => string} pseudonym
 */
function shapeItems(out, lens, pseudonym) {
    return {
        kind: out.kind,
        items: out.items.map((i) => ({
            id: i.id, name: i.name, ownerId: i.ownerId, ownerName: i.ownerName, audience: i.audience,
            createdAt: i.createdAt, lastUsedAt: i.lastUsedAt, people: i.people, uses: i.uses, cost: lens.cost(i.cost),
        })),
        // The people who use a kind most: always pseudonymous.
        topPeople: out.topPeople.map((p) => ({ person: pseudonym(p.person), uses: p.uses, cost: lens.cost(p.cost) })),
        unused: out.unused,
        total: out.total,
    };
}

/**
 * @param {Groups} g
 * @param {CostLens} lens
 */
function shapeGroups(g, lens) {
    return {
        groups: g.groups.map((r) => ({ ...r, cost: lens.cost(r.cost) })),
        folded: g.folded ? { ...g.folded, cost: lens.cost(g.folded.cost) } : null,
        partial: g.partial,
    };
}

/**
 * Who a row is: the pseudonym, or after a reveal the id, name and avatar.
 * @param {PersonRow} row
 * @param {PersonContext} ctx
 */
function identityOf(row, ctx) {
    if (!ctx.reveal) {
        const label = ctx.pseudonym(row.id);
        return { id: label, name: label, avatarType: null, avatar: null };
    }
    const u = row.member;
    const avatar = ctx.avatars.get(row.id);
    return {
        id: row.id,
        name: String(u.displayName || u.username || row.id),
        avatarType: avatar?.avatarType || u.avatarType || null,
        avatar: inlineAvatar(avatar?.avatar),
    };
}

/**
 * One person as the report shows them.
 * @param {PersonRow} row
 * @param {PersonContext} ctx
 */
function shapePerson(row, ctx) {
    const u = row.member;
    const lastSeen = u.lastSeenAt ?? u.last_seen_at ?? null;
    return {
        ...identityOf(row, ctx),
        role: String(u.orgRole || 'member'),
        groups: row.groupIds.map((gid) => ctx.groupNames.get(gid) || gid),
        lastSeenAt: lastSeen ? new Date(lastSeen).toISOString() : null,
        status: row.status,
        ...figures(ctx.lens, row),
        areas: row.areas,
        built: row.built,
        firstAiUseAt: row.firstAiUseAt,
    };
}

module.exports = { inlineAvatar, shapeSummary, shapeAreas, shapeStudio, shapeItems, shapeGroups, shapePerson };
