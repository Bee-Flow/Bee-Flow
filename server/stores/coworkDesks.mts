/**
 * Desks (usecases/coworkDesks.mts): a small team of coworks of different owners in one organisation, that hand work
 * to each other. Four tables:
 *
 *   cowork_desks         the desk: its organisation, the person who made it, its name;
 *   cowork_desk_members  the coworks on it. An item joins only when ITS owner accepts (`accepted_at`, `accepted_by`):
 *                        it counts as accepted while the person who accepted is still its owner, so an item handed to
 *                        a colleague waits for the new owner. The owner's per-item setting `desk_role` names the role
 *                        that decides its questions. One desk per item;
 *   cowork_desk_roles    who holds a role (`holder_id`), who stands in (`stand_in_id`), and until when the holder is
 *                        away (`away_until`);
 *   cowork_desk_follows  the hand-offs across owners that the LEADING item's owner allowed: the follower `follower_id`
 *                        (owned by `follower_owner` when it was allowed) may receive the result of `leader_id`. It counts
 *                        while the person who allowed it (`allowed_by`) still owns the leader and the follower has the
 *                        same owner: a cowork handed to a colleague, on either side, is asked again. Until then, and once
 *                        withdrawn (the row goes), a follower of another owner receives nothing. Following one's own
 *                        cowork needs no row. The rows go with either item (foreign keys to cowork_schedules).
 *
 * Every read counts a person only while they are an ACTIVE member of the desk's organisation, the rule of
 * stores/coworkShares.mts LIVE_SHARES: an owner who left, moved to another organisation or was switched off keeps the
 * row until someone changes it, but their coworks no longer hand work on or receive it, and they hold no role.
 */

import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type Client = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }> };
type Db = {
    getAll: (sql: string, params?: unknown[]) => Promise<Row[]>;
    getOne: (sql: string, params?: unknown[]) => Promise<Row | null>;
    run: (sql: string, params?: unknown[]) => Promise<unknown>;
    withTransaction: <T>(fn: (client: Client) => Promise<T>) => Promise<T>;
};
type Rows = typeof import('./coworkRows.js');
const { rowToSchedule } = nodeRequire('./coworkRows.js') as Rows;
export type CoworkItem = NonNullable<ReturnType<Rows['rowToSchedule']>>;

export const COWORK_DESKS_DDL: readonly string[] = Object.freeze([
    `CREATE TABLE IF NOT EXISTS cowork_desks (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    'CREATE INDEX IF NOT EXISTS idx_cowork_desks_org ON cowork_desks (organization_id)',
    `CREATE TABLE IF NOT EXISTS cowork_desk_members (
        desk_id TEXT NOT NULL REFERENCES cowork_desks(id) ON DELETE CASCADE,
        schedule_id TEXT NOT NULL REFERENCES cowork_schedules(id) ON DELETE CASCADE,
        added_by TEXT,
        accepted_at TIMESTAMPTZ,
        accepted_by TEXT,
        desk_role TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (desk_id, schedule_id)
    )`,
    // One desk per item: its questions and its hand-offs have one place.
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_cowork_desk_members_item ON cowork_desk_members (schedule_id)',
    `CREATE TABLE IF NOT EXISTS cowork_desk_roles (
        desk_id TEXT NOT NULL REFERENCES cowork_desks(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        holder_id TEXT NOT NULL,
        stand_in_id TEXT,
        away_until TIMESTAMPTZ,
        PRIMARY KEY (desk_id, role)
    )`,
    `CREATE TABLE IF NOT EXISTS cowork_desk_follows (
        desk_id TEXT NOT NULL REFERENCES cowork_desks(id) ON DELETE CASCADE,
        leader_id TEXT NOT NULL REFERENCES cowork_schedules(id) ON DELETE CASCADE,
        follower_id TEXT NOT NULL REFERENCES cowork_schedules(id) ON DELETE CASCADE,
        follower_owner TEXT NOT NULL,
        allowed_by TEXT NOT NULL,
        allowed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (desk_id, leader_id, follower_id)
    )`,
]);

/** A person `u` who counts on desk `d`: an active member of its organisation now. */
const LIVE = (u: string) => `${u}."organizationId" = d.organization_id AND COALESCE(${u}.status, 'active') = 'active'`;
/** The members of desk `d` whose item `s` is owned by someone who counts. */
const LIVE_MEMBERS = `cowork_desk_members m
    JOIN cowork_desks d ON d.id = m.desk_id AND d.organization_id <> ''
    JOIN cowork_schedules s ON s.id = m.schedule_id
    JOIN users o ON o.id = s.user_id AND ${LIVE('o')}`;
/** Member `m` of item `s` is accepted by the item's owner of now. */
const ACCEPTED = (m: string, s: string) => `${m}.accepted_at IS NOT NULL AND ${m}.accepted_by = ${s}.user_id`;
const AFTER = `CASE WHEN s.trigger_kind = 'after_cowork' THEN s.trigger_json::jsonb ->> 'scheduleId' END`;
/**
 * Follower `s` on desk `d` may receive the result of leader `l`: the same owner, or a hand-off the leader's owner of
 * now allowed for the follower's owner of now.
 */
const MAY_FOLLOW = (d: string, l: string, s: string) => `(${s}.user_id = ${l}.user_id OR EXISTS (SELECT 1 FROM cowork_desk_follows f
    WHERE f.desk_id = ${d}.id AND f.leader_id = ${l}.id AND f.follower_id = ${s}.id AND f.allowed_by = ${l}.user_id AND f.follower_owner = ${s}.user_id))`;

export interface Desk { id: string; organizationId: string; ownerId: string; name: string; createdAt: string | null }
export interface DeskMember {
    scheduleId: string; ownerId: string; title: string; accepted: boolean; addedBy: string | null; deskRole: string | null;
    /** The item it starts after, when it starts after another cowork. */
    afterId: string | null;
    /** That item is on the same desk and may hand it its result: the same owner, or allowed by that item's owner. */
    afterAllowed: boolean;
    lastStatus: string | null; lastRunAt: string | null; isActive: boolean;
}
export interface DeskRole { role: string; holderId: string | null; standInId: string | null; awayUntil: string | null }
export interface RoleInput { role: string; holderId: string; standInId?: string | null; awayUntil?: string | null }
export interface Membership { deskId: string; deskName: string; deskOwnerId: string; organizationId: string; accepted: boolean; deskRole: string | null; addedBy: string | null }
/** The role an item's questions go to, with who holds it now. */
export interface QuestionRole { deskId: string; role: string; holderId: string | null; standInId: string | null; awayUntil: string | null }

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const deskOf = (r: Row): Desk => ({ id: String(r.id), organizationId: String(r.organization_id), ownerId: String(r.owner_id), name: String(r.name ?? ''), createdAt: iso(r.created_at) });
const memberOf = (r: Row): DeskMember => ({
    scheduleId: String(r.schedule_id), ownerId: String(r.user_id), title: String(r.title ?? ''), accepted: r.accepted === true, addedBy: str(r.added_by),
    deskRole: str(r.desk_role), afterId: str(r.after_id), afterAllowed: r.after_allowed === true, lastStatus: str(r.last_status), lastRunAt: iso(r.last_run_at), isActive: r.is_active === true,
});
const roleOf = (r: Row): DeskRole => ({ role: String(r.role), holderId: str(r.holder_id), standInId: str(r.stand_in_id), awayUntil: iso(r.away_until) });

/** The roles of desk `d` (in the FROM), the holder and the stand-in named only while they count. */
const LIVE_ROLES = `SELECT r.desk_id, r.role, r.away_until,
        CASE WHEN h.id IS NOT NULL THEN r.holder_id END AS holder_id,
        CASE WHEN si.id IS NOT NULL THEN r.stand_in_id END AS stand_in_id
   FROM cowork_desk_roles r
   JOIN cowork_desks d ON d.id = r.desk_id AND d.organization_id <> ''
   LEFT JOIN users h ON h.id = r.holder_id AND ${LIVE('h')}
   LEFT JOIN users si ON si.id = r.stand_in_id AND ${LIVE('si')}`;

type Part = { db: Db; ready: () => Promise<unknown> };

/** The desks themselves: make, read, remove, and the desks a person sees. */
function deskRows({ db, ready }: Part) {
    async function createDesk({ organizationId, ownerId, name }: { organizationId: string; ownerId: string; name: string }): Promise<Desk> {
        await ready();
        const id = crypto.randomUUID();
        await db.run('INSERT INTO cowork_desks (id, organization_id, owner_id, name) VALUES ($1, $2, $3, $4)', [id, organizationId, ownerId, name]);
        return deskOf((await db.getOne('SELECT * FROM cowork_desks WHERE id = $1', [id])) as Row);
    }

    async function getDesk(id: string): Promise<Desk | null> {
        await ready();
        const r = await db.getOne('SELECT * FROM cowork_desks WHERE id = $1', [id]);
        return r ? deskOf(r) : null;
    }

    async function deleteDesk(id: string): Promise<void> {
        await ready();
        await db.run('DELETE FROM cowork_desks WHERE id = $1', [id]);
    }

    /**
     * The desks this person sees, while they count in the desk's organisation: the ones they made, the ones an item
     * of theirs is on or invited to, and the ones they hold a role on or stand in for. With `deskId`, only that one.
     */
    async function desksOf(userId: string, deskId: string | null = null): Promise<Desk[]> {
        await ready();
        const rows = await db.getAll(
            `SELECT d.* FROM cowork_desks d
               JOIN users u ON u.id = $1 AND ${LIVE('u')}
              WHERE d.organization_id <> '' AND ($2::text IS NULL OR d.id = $2)
                AND (d.owner_id = $1
                     OR EXISTS (SELECT 1 FROM cowork_desk_members m JOIN cowork_schedules s ON s.id = m.schedule_id WHERE m.desk_id = d.id AND s.user_id = $1)
                     OR EXISTS (SELECT 1 FROM cowork_desk_roles r WHERE r.desk_id = d.id AND (r.holder_id = $1 OR r.stand_in_id = $1)))
              ORDER BY d.name, d.id`,
            [userId, deskId],
        );
        return rows.map(deskOf);
    }
    return { createDesk, getDesk, deleteDesk, desksOf };
}

/** The coworks on a desk: invite, accept, leave, and the role that decides an item's questions. */
function memberRows({ db, ready }: Part) {
    /** The coworks on the desk whose owner counts, accepted or invited. */
    async function listMembers(deskId: string): Promise<DeskMember[]> {
        await ready();
        const rows = await db.getAll(
            `SELECT m.schedule_id, m.added_by, (${ACCEPTED('m', 's')}) AS accepted, m.desk_role, s.user_id, s.title, s.last_status, s.last_run_at, s.is_active, ${AFTER} AS after_id,
                    EXISTS (SELECT 1 FROM cowork_schedules l WHERE l.id = ${AFTER} AND ${MAY_FOLLOW('d', 'l', 's')}) AS after_allowed
               FROM ${LIVE_MEMBERS}
              WHERE m.desk_id = $1 ORDER BY m.created_at, m.schedule_id`,
            [deskId],
        );
        return rows.map(memberOf);
    }

    /** The desk an item is on or invited to, whoever counts (its owner reads it). */
    async function membershipOf(scheduleId: string): Promise<Membership | null> {
        await ready();
        const r = await db.getOne(
            `SELECT m.desk_id, (${ACCEPTED('m', 's')}) AS accepted, m.desk_role, m.added_by, d.name, d.owner_id, d.organization_id
               FROM cowork_desk_members m JOIN cowork_desks d ON d.id = m.desk_id JOIN cowork_schedules s ON s.id = m.schedule_id
              WHERE m.schedule_id = $1`,
            [scheduleId],
        );
        if (!r) return null;
        return {
            deskId: String(r.desk_id), deskName: String(r.name ?? ''), deskOwnerId: String(r.owner_id), organizationId: String(r.organization_id),
            accepted: r.accepted === true, deskRole: str(r.desk_role), addedBy: str(r.added_by),
        };
    }

    /** Put an item on a desk, accepted or as an invitation. False when the item is on a desk already. */
    async function addMember({ deskId, scheduleId, addedBy, accepted }: { deskId: string; scheduleId: string; addedBy: string; accepted: boolean }): Promise<boolean> {
        await ready();
        const rows = await db.getAll(
            `INSERT INTO cowork_desk_members (desk_id, schedule_id, added_by, accepted_at, accepted_by) VALUES ($1, $2, $3, ${accepted ? 'NOW(), $3' : 'NULL, NULL'})
             ON CONFLICT DO NOTHING RETURNING schedule_id`,
            [deskId, scheduleId, addedBy],
        );
        return rows.length > 0;
    }

    /** The item's owner accepts it on the desk. */
    async function acceptMember(deskId: string, scheduleId: string, ownerId: string): Promise<boolean> {
        await ready();
        const rows = await db.getAll(
            `UPDATE cowork_desk_members m SET accepted_at = NOW(), accepted_by = $3 FROM cowork_schedules s
              WHERE m.desk_id = $1 AND m.schedule_id = $2 AND s.id = m.schedule_id AND s.user_id = $3 RETURNING m.schedule_id`,
            [deskId, scheduleId, ownerId],
        );
        return rows.length > 0;
    }

    /** Take an item off the desk, with the hand-offs allowed to it or from it there: put back, it is asked again. */
    async function removeMember(deskId: string, scheduleId: string): Promise<boolean> {
        await ready();
        return db.withTransaction(async (client) => {
            await client.query('DELETE FROM cowork_desk_follows WHERE desk_id = $1 AND (leader_id = $2 OR follower_id = $2)', [deskId, scheduleId]);
            const { rows } = await client.query('DELETE FROM cowork_desk_members WHERE desk_id = $1 AND schedule_id = $2 RETURNING schedule_id', [deskId, scheduleId]);
            return rows.length > 0;
        });
    }

    /** The owner's per-item setting: the role that decides the item's questions, or none. */
    async function setDeskRole(deskId: string, scheduleId: string, role: string | null): Promise<void> {
        await ready();
        await db.run('UPDATE cowork_desk_members SET desk_role = $3 WHERE desk_id = $1 AND schedule_id = $2', [deskId, scheduleId, role]);
    }
    return { listMembers, membershipOf, addMember, acceptMember, removeMember, setDeskRole };
}

/** The hand-offs across owners that the leading item's owner allows (and withdraws). */
function followRows({ db, ready }: Part) {
    /** The leader's owner `allowedBy` lets `followerId` (owned by `followerOwner`) receive the result of `leaderId`. */
    async function allowFollow({ deskId, leaderId, followerId, followerOwner, allowedBy }: { deskId: string; leaderId: string; followerId: string; followerOwner: string; allowedBy: string }): Promise<void> {
        await ready();
        await db.run(
            `INSERT INTO cowork_desk_follows (desk_id, leader_id, follower_id, follower_owner, allowed_by) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (desk_id, leader_id, follower_id) DO UPDATE SET follower_owner = EXCLUDED.follower_owner, allowed_by = EXCLUDED.allowed_by, allowed_at = NOW()`,
            [deskId, leaderId, followerId, followerOwner, allowedBy],
        );
    }

    /** Withdraw it: the follower receives nothing of the leader any more. False when nothing was allowed. */
    async function withdrawFollow(deskId: string, leaderId: string, followerId: string): Promise<boolean> {
        await ready();
        const rows = await db.getAll('DELETE FROM cowork_desk_follows WHERE desk_id = $1 AND leader_id = $2 AND follower_id = $3 RETURNING follower_id', [deskId, leaderId, followerId]);
        return rows.length > 0;
    }

    /** May `followerId` receive the result of `leaderId` on the desk they are on (the same owner, or allowed)? */
    async function followAllowed(leaderId: string, followerId: string): Promise<boolean> {
        await ready();
        const r = await db.getOne(
            `SELECT 1 AS ok FROM cowork_desk_members lm JOIN cowork_desks d ON d.id = lm.desk_id
               JOIN cowork_schedules l ON l.id = lm.schedule_id
               JOIN cowork_desk_members m ON m.desk_id = d.id AND m.schedule_id = $2
               JOIN cowork_schedules s ON s.id = m.schedule_id
              WHERE lm.schedule_id = $1 AND ${MAY_FOLLOW('d', 'l', 's')}`,
            [leaderId, followerId],
        );
        return !!r;
    }
    return { allowFollow, withdrawFollow, followAllowed };
}

/** The roles of a desk, and what the runs read: who follows whom across owners, who decides a question. */
function flowRows({ db, ready }: Part) {
    /** Replace the desk's roles, in one go. */
    async function setRoles(deskId: string, roles: RoleInput[]): Promise<void> {
        await ready();
        await db.withTransaction(async (client) => {
            await client.query('DELETE FROM cowork_desk_roles WHERE desk_id = $1', [deskId]);
            for (const r of roles) {
                await client.query(
                    'INSERT INTO cowork_desk_roles (desk_id, role, holder_id, stand_in_id, away_until) VALUES ($1, $2, $3, $4, $5)',
                    [deskId, r.role, r.holderId, r.standInId ?? null, r.awayUntil ?? null],
                );
            }
        });
    }

    async function listRoles(deskId: string): Promise<DeskRole[]> {
        await ready();
        return (await db.getAll(`${LIVE_ROLES} WHERE r.desk_id = $1 ORDER BY r.role`, [deskId])).map(roleOf);
    }

    /**
     * The coworks that start when `scheduleId` ended well, across owners: accepted members of the same desk that start
     * after it, both owners counting in the desk's organisation, the follower switched on, and, for a follower of
     * another owner, allowed by the owner of `scheduleId` (cowork_desk_follows): one person's results never go to
     * another without that person's yes.
     */
    async function deskFollowers(scheduleId: string): Promise<CoworkItem[]> {
        await ready();
        const rows = await db.getAll(
            `SELECT s.* FROM cowork_desk_members lm
               JOIN cowork_desks d ON d.id = lm.desk_id AND d.organization_id <> ''
               JOIN cowork_schedules l ON l.id = lm.schedule_id
               JOIN users lo ON lo.id = l.user_id AND ${LIVE('lo')}
               JOIN cowork_desk_members m ON m.desk_id = d.id AND m.schedule_id <> lm.schedule_id
               JOIN cowork_schedules s ON s.id = m.schedule_id AND s.is_active = TRUE AND ${ACCEPTED('m', 's')}
               JOIN users o ON o.id = s.user_id AND ${LIVE('o')}
              WHERE lm.schedule_id = $1 AND ${ACCEPTED('lm', 'l')} AND ${AFTER} = $1 AND ${MAY_FOLLOW('d', 'l', 's')}
              ORDER BY s.id`,
            [scheduleId],
        );
        return rows.map((r) => rowToSchedule(r as unknown as Parameters<Rows['rowToSchedule']>[0])).filter((x): x is CoworkItem => !!x);
    }

    /** Are both items accepted on one desk, both owners counting? */
    async function sameDesk(a: string, b: string): Promise<boolean> {
        await ready();
        const r = await db.getOne(
            `SELECT COUNT(*)::int AS n FROM ${LIVE_MEMBERS} WHERE ${ACCEPTED('m', 's')} AND m.schedule_id = ANY($1::text[])
              GROUP BY m.desk_id ORDER BY n DESC LIMIT 1`,
            [[a, b]],
        );
        return Number(r?.n) === 2;
    }

    /** The role that decides an accepted item's questions, with its holder and stand-in as they count now. */
    async function questionRoleOf(scheduleId: string): Promise<QuestionRole | null> {
        await ready();
        const r = await db.getOne(
            `SELECT lr.* FROM ${LIVE_MEMBERS}
               JOIN (${LIVE_ROLES}) lr ON lr.desk_id = m.desk_id AND lr.role = m.desk_role
              WHERE m.schedule_id = $1 AND ${ACCEPTED('m', 's')}`,
            [scheduleId],
        );
        return r ? { deskId: String(r.desk_id), ...roleOf(r) } : null;
    }
    return { setRoles, listRoles, deskFollowers, sameDesk, questionRoleOf };
}

export function makeCoworkDesks({ db = nodeRequire('../db.js') as Db, ready = async () => {} }: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    const part = { db, ready };
    return { ...deskRows(part), ...memberRows(part), ...followRows(part), ...flowRows(part) };
}

export type CoworkDesks = ReturnType<typeof makeCoworkDesks>;
type StoreInit = { makeStoreInit: (tag: string, fn: () => Promise<void>) => () => Promise<void> };

/** The schema init (ledgered, memoised), after the Cowork schema it refers to; storeModules.js starts it at boot. */
export const initDB: () => Promise<void> = (nodeRequire('./lib/storeInit.js') as StoreInit).makeStoreInit('CoworkDesksStore', async () => {
    await (nodeRequire('./coworkStore.js') as { initDB: () => Promise<unknown> }).initDB();
    const db = nodeRequire('../db.js') as { exec: (sql: string) => Promise<unknown> };
    for (const sql of COWORK_DESKS_DDL) await db.exec(sql);
});

let defaultStore: CoworkDesks | null = null;

/** The store on the server's pool. */
export function coworkDesks(): CoworkDesks {
    if (!defaultStore) defaultStore = makeCoworkDesks({ ready: initDB });
    return defaultStore;
}
