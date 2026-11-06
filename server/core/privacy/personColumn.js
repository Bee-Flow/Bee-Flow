// @typecheck strict
/**
 * The "person" column of an org report that lists rows by user (the Quality
 * tab: feedback ratings and early terminations).
 *
 * The stores keep writing `user_id`. What leaves the server is not that id:
 *
 *   - by default every row carries `person: { id, name }`, the pseudonym of
 *     core/privacy/pseudonym.js in the `people` key domain, the SAME label the
 *     Adoption tab shows for that person, so an admin can read "Member · K7Q2"
 *     across tabs without learning who it is;
 *   - with `reveal` the row carries `person: { id: <user id>, name: <display
 *     name>, avatar?, avatarType? }`, and the reveal is recorded in the access
 *     audit log BEFORE any name is looked up. A failed write refuses the whole
 *     answer (503 `audit_unavailable`): names are shown only when the record
 *     of showing them exists (the routes/usageAdoption.js rule);
 *   - a row without a user (an anonymous rating) is `person: null` either way.
 *
 * `user_id` is removed from every row, revealed or not: the id is in `person.id`
 * when revealed and must not travel next to a pseudonym.
 */

'use strict';

const { HttpError } = require('../http/errors');
const log = require('../../telemetry/log');
const { recordReveal, QUALITY_REVEAL_ACTION } = require('../../stores/adoption/audit');

/** An avatar travels inline only when short (a URL or an emoji), the routes/usage.js rule. */
const INLINE_AVATAR_MAX_CHARS = 2048;

/**
 * @typedef {{ id: string, name: string, avatar?: string | null, avatarType?: string | null }} Person
 * @typedef {{ user_id?: string | null }} WithUser
 */

/**
 * @template {WithUser} Row
 * @typedef {Omit<Row, 'user_id'> & { person: Person | null }} WithPerson
 */

/**
 * @typedef {object} PersonColumnDeps
 * @property {{ pseudonymFor: Function, pseudonymId: Function, pseudonymSecret: () => string }} pseudonym
 * @property {{ getUserAvatarsByIds: (ids: string[]) => Promise<any[]> }} userStore
 * @property {{ run: (sql: string, params: unknown[]) => Promise<unknown> }} db
 */

/** @returns {PersonColumnDeps} */
const defaultDeps = () => ({
    pseudonym: require('./pseudonym'),
    userStore: require('../../stores/userStore'),
    db: require('../../db'),
});

/**
 * Write the reveal's audit row; any failure is a 503 and nothing is shown.
 * @param {PersonColumnDeps} d
 * @param {{ orgId: string, actorId: string, startDate?: string, endDate?: string, limit: number }} ctx
 */
async function auditReveal(d, ctx) {
    try {
        await recordReveal(d.db, {
            orgId: ctx.orgId,
            actorId: ctx.actorId,
            action: QUALITY_REVEAL_ACTION,
            details: { startDate: ctx.startDate || 'all', endDate: ctx.endDate || 'all', group: null, limit: ctx.limit },
        });
    } catch (err) {
        // The reason only: no names, no ids of the people asked for.
        log.error('[Quality] reveal audit failed; names withheld:', /** @type {Error} */ (err)?.message || err);
        throw new HttpError(503, 'audit_unavailable', 'The reveal could not be recorded, so names cannot be shown. Try again later.');
    }
}

/**
 * Replace `user_id` on each row by `person`.
 * @template {WithUser} Row
 * @param {Row[]} rows
 * @param {{ orgId: string, actorId: string, reveal: boolean, startDate?: string, endDate?: string }} opts
 * @param {PersonColumnDeps} [deps]
 * @returns {Promise<WithPerson<Row>[]>}
 */
async function withPersonColumn(rows, opts, deps) {
    const d = deps || defaultDeps();
    const { orgId, reveal } = opts;
    /** @type {Map<string, any>} */
    let names = new Map();
    if (reveal) {
        // First, before anything is read: the record must exist for names to be shown.
        await auditReveal(d, { orgId, actorId: opts.actorId, startDate: opts.startDate, endDate: opts.endDate, limit: rows.length });
        const ids = [...new Set(rows.map((r) => r.user_id).filter((id) => !!id))].map(String);
        const found = ids.length ? (await d.userStore.getUserAvatarsByIds(ids)) || [] : [];
        names = new Map(found.map((u) => [String(u.id), u]));
    }
    /** @type {string | null} */
    let secret = null;
    return rows.map((row) => {
        const { user_id: userId, ...rest } = row;
        if (!userId) return /** @type {WithPerson<Row>} */ ({ ...rest, person: null });
        const id = String(userId);
        if (!reveal) {
            secret = secret ?? d.pseudonym.pseudonymSecret();
            return /** @type {WithPerson<Row>} */ ({
                ...rest,
                person: { id: d.pseudonym.pseudonymId(id, orgId, secret), name: d.pseudonym.pseudonymFor(id, orgId, secret) },
            });
        }
        const u = names.get(id);
        /** @type {Person} */
        const person = { id, name: String(u?.displayName || u?.username || id) };
        if (typeof u?.avatar === 'string' && u.avatar.length > 0 && u.avatar.length <= INLINE_AVATAR_MAX_CHARS) person.avatar = u.avatar;
        if (u?.avatarType) person.avatarType = String(u.avatarType);
        return /** @type {WithPerson<Row>} */ ({ ...rest, person });
    });
}

module.exports = { withPersonColumn };
