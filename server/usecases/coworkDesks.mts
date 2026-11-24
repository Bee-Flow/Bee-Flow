/**
 * Desks (routes/coworkDeskRoutes.js): a small team of coworks, each with its own owner and its own permissions, that
 * hand work to each other ("Supplier radar → Invoice intake → Payment check → Friday report"), with roles that decide
 * questions and a stand-in while someone is away. Kept in stores/coworkDesks.mts; the hand-offs run in
 * core/cowork/afterCowork.mts, the questions in core/cowork/deskQuestions.mts.
 *
 *   - a desk belongs to an organisation: only its active members make one, see one, or are on one;
 *   - an owner puts their own cowork on a desk; the desk's maker may invite a cowork of someone else that they can
 *     see (it is shared with them), and it joins only when its owner accepts;
 *   - the desk's maker sets the roles (holder, stand-in, away until); each owner chooses, per item, which role decides
 *     its questions, and is told (title and role name only) when the holder or stand-in of that role changes;
 *   - a cowork that starts after a colleague's cowork on the desk receives that cowork's result only once the
 *     colleague (the owner of the cowork it follows) allowed it, once; they can withdraw that again. Following one's
 *     own cowork needs nothing;
 *   - the desk view shows the coworks in the order work moves along them, each with its owner's name and its last
 *     status, never what another owner's runs read or produced. An invitation is shown to the desk's maker and the
 *     invited owner only.
 *
 * A hand-off carries data, never access: being on a desk adds no permission to anybody's cowork.
 */

import { createRequire } from 'node:module';
import type { CoworkDesks, Desk, DeskMember, DeskRole, RoleInput } from '../stores/coworkDesks.mts';

const nodeRequire = createRequire(import.meta.url);
const { fallback } = nodeRequire('../utils/bestEffort.js') as { fallback: <T>(label: string, err: unknown, value: T) => T };
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };

interface Person { id: string; organizationId?: string | null; status?: string | null; displayName?: string | null; username?: string | null }
interface Item { id: string; userId: string; title?: string | null }

export interface DeskDeps {
    desks: Pick<CoworkDesks, 'createDesk' | 'deleteDesk' | 'desksOf' | 'listMembers' | 'membershipOf' | 'addMember' | 'acceptMember' | 'removeMember' | 'setDeskRole' | 'setRoles' | 'listRoles' | 'allowFollow' | 'withdrawFollow'>;
    getUser: (id: string) => Promise<Person | null>;
    listMembers: (orgId: string) => Promise<Person[]>;
    getSchedule: (id: string) => Promise<Item | null>;
    /** May this person see this item through a share (stores/coworkShares.mts roleOf)? */
    sharedWith: (scheduleId: string, userId: string) => Promise<boolean>;
    /** A Cowork notice in the person's notifications (stores/notificationStore.js). */
    notify: (n: { userId: string; category: string; title: string; message: string; link: string }) => Promise<unknown>;
}

const defaults = (): DeskDeps => {
    const users = () => nodeRequire('../stores/userStore.js') as { getUser: DeskDeps['getUser']; getOrgMembersForDirectory: DeskDeps['listMembers'] };
    const shares = () => (nodeRequire('../stores/coworkShares.mts') as typeof import('../stores/coworkShares.mts')).coworkShares();
    return {
        desks: (nodeRequire('../stores/coworkDesks.mts') as typeof import('../stores/coworkDesks.mts')).coworkDesks(),
        getUser: (id) => users().getUser(id),
        listMembers: (orgId) => users().getOrgMembersForDirectory(orgId),
        getSchedule: (id) => (nodeRequire('../stores/coworkStore.js') as { getSchedule: DeskDeps['getSchedule'] }).getSchedule(id),
        sharedWith: async (id, userId) => (await shares().roleOf(id, userId)) !== null,
        notify: (n) => (nodeRequire('../stores/notificationStore.js') as { createNotification: DeskDeps['notify'] }).createNotification(n),
    };
};

export const MAX_ROLES = 20;
const refuse = (status: number, message: string) => new HttpError(status, 'cowork_desk_refused', message);
const notFound = () => refuse(404, 'That desk does not exist.');
const nameOf = (p: Person | null | undefined): string => (p?.displayName || p?.username || 'A colleague').trim();
const counts = (p: Person | null | undefined, orgId: string): boolean => !!p && !!orgId && p.organizationId === orgId && (p.status ?? 'active') === 'active';

export interface DeskSummary { id: string; name: string; isOwner: boolean }
export interface DeskView {
    desk: { id: string; name: string; isOwner: boolean; ownerName: string };
    /** In the order work moves along them. */
    members: Array<{
        scheduleId: string; title: string; ownerName: string; mine: boolean; accepted: boolean; after: string | null; lastStatus: string | null; lastRunAt: string | null; deskRole: string | null;
        /**
         * It starts after a colleague's cowork on the desk: 'allowed' once that cowork's owner said yes, 'waiting' until
         * then (it receives nothing). Null when it starts after none, or after a cowork of its own owner.
         */
        handOff: 'allowed' | 'waiting' | null;
        /** The reader owns the cowork it starts after, so the reader allows the hand-off or withdraws it. */
        decidesHandOff: boolean;
    }>;
    roles: Array<DeskRole & { holderName: string | null; standInName: string | null; away: boolean }>;
    /** For the desk's maker: the people of the organisation who can hold a role. */
    colleagues: Array<{ id: string; name: string }>;
    /** TODO(deskGoal): the desk's goal comes with Cowork goals (cowork_goals), built elsewhere; null until then. */
    deskGoal: null;
}

/** The desk as this person sees it, or a 404. */
async function visibleDesk(userId: string, deskId: string, deps: DeskDeps): Promise<Desk> {
    const [desk] = await deps.desks.desksOf(userId, deskId);
    if (!desk) throw notFound();
    return desk;
}

/** The members in the order work moves along them: first those that start after no member, then who follows whom. */
export function handOffOrder<T extends { scheduleId: string; after: string | null }>(members: T[]): T[] {
    const ids = new Set(members.map((m) => m.scheduleId));
    const out: T[] = [];
    const queue = members.filter((m) => !m.after || !ids.has(m.after));
    while (queue.length) {
        const next = queue.shift() as T;
        if (out.includes(next)) continue;
        out.push(next);
        queue.push(...members.filter((m) => m.after === next.scheduleId));
    }
    return [...out, ...members.filter((m) => !out.includes(m))];
}

/** Names of people, looked up once each. */
function namer(deps: DeskDeps) {
    const cache = new Map<string, Promise<string>>();
    return (id: string | null): Promise<string | null> => {
        if (!id) return Promise.resolve(null);
        if (!cache.has(id)) cache.set(id, deps.getUser(id).then(nameOf));
        return cache.get(id) as Promise<string>;
    };
}

/** The accepted member of another owner that accepted member `m` starts after, on the same desk; else undefined. */
const crossOwnerLeader = (m: DeskMember, members: DeskMember[]): DeskMember | undefined => (m.accepted && m.afterId
    ? members.find((l) => l.scheduleId === m.afterId && l.accepted && l.ownerId !== m.ownerId)
    : undefined);

/** An invitation is seen by the desk's maker and the invited owner; an accepted member by everyone on the desk. */
const seenBy = (userId: string, desk: Desk) => (m: DeskMember): boolean => m.accepted || m.ownerId === userId || desk.ownerId === userId;

async function viewOf(userId: string, desk: Desk, deps: DeskDeps): Promise<DeskView> {
    const name = namer(deps);
    const isOwner = desk.ownerId === userId;
    const [members, roles] = await Promise.all([deps.desks.listMembers(desk.id), deps.desks.listRoles(desk.id)]);
    const now = Date.now();
    const shown = await Promise.all(members.filter(seenBy(userId, desk)).map(async (m) => {
        const leader = crossOwnerLeader(m, members);
        return {
            scheduleId: m.scheduleId, title: m.title || 'Untitled work', ownerName: (await name(m.ownerId)) ?? 'A colleague', mine: m.ownerId === userId,
            accepted: m.accepted, after: m.afterId, lastStatus: m.lastStatus, lastRunAt: m.lastRunAt, deskRole: m.deskRole,
            handOff: leader ? (m.afterAllowed ? 'allowed' as const : 'waiting' as const) : null, decidesHandOff: leader?.ownerId === userId,
        };
    }));
    const inDesk = new Set(shown.map((m) => m.scheduleId));
    return {
        desk: { id: desk.id, name: desk.name, isOwner, ownerName: (await name(desk.ownerId)) ?? 'A colleague' },
        members: handOffOrder(shown.map((m) => ({ ...m, after: m.after && inDesk.has(m.after) ? m.after : null }))),
        roles: await Promise.all(roles.map(async (r) => ({
            ...r, holderName: await name(r.holderId), standInName: await name(r.standInId), away: !!r.awayUntil && Date.parse(r.awayUntil) > now,
        }))),
        colleagues: isOwner ? (await deps.listMembers(desk.organizationId)).map((p) => ({ id: p.id, name: nameOf(p) })) : [],
        deskGoal: null,
    };
}

/** Make a desk in the caller's organisation. */
export async function createDesk({ userId, name }: { userId: string; name: string }, deps: DeskDeps = defaults()): Promise<DeskView> {
    const me = await deps.getUser(userId);
    if (!me?.organizationId || !counts(me, me.organizationId)) throw refuse(403, 'Desks are for members of an organisation.');
    const desk = await deps.desks.createDesk({ organizationId: me.organizationId, ownerId: userId, name: name.trim() });
    return viewOf(userId, desk, deps);
}

/** The desks I am on, made, hold a role on, or am invited to. */
export async function myDesks(userId: string, deps: DeskDeps = defaults()): Promise<DeskSummary[]> {
    return (await deps.desks.desksOf(userId)).map((d) => ({ id: d.id, name: d.name, isOwner: d.ownerId === userId }));
}

export async function deskView(userId: string, deskId: string, deps: DeskDeps = defaults()): Promise<DeskView> {
    return viewOf(userId, await visibleDesk(userId, deskId, deps), deps);
}

/**
 * Put a cowork on a desk. Its owner's own: on it now. Someone else's: only the desk's maker invites, only a cowork
 * shared with them, of an owner in the desk's organisation; it joins when its owner accepts.
 */
export async function addToDesk({ userId, deskId, scheduleId }: { userId: string; deskId: string; scheduleId: string }, deps: DeskDeps = defaults()): Promise<DeskView> {
    const desk = await visibleDesk(userId, deskId, deps);
    const item = await deps.getSchedule(scheduleId);
    const mine = item?.userId === userId;
    const mayInvite = !!item && !mine && desk.ownerId === userId && await deps.sharedWith(item.id, userId) && counts(await deps.getUser(item.userId), desk.organizationId);
    if (!item || (!mine && !mayInvite)) throw refuse(404, 'That cowork does not exist.');
    if (!(await deps.desks.addMember({ deskId, scheduleId, addedBy: userId, accepted: mine }))) throw refuse(409, 'That cowork is on a desk already.');
    return viewOf(userId, desk, deps);
}

/** The owner of an invited cowork accepts it on the desk. */
export async function acceptOnDesk({ userId, deskId, scheduleId }: { userId: string; deskId: string; scheduleId: string }, deps: DeskDeps = defaults()): Promise<DeskView> {
    const desk = await visibleDesk(userId, deskId, deps);
    const membership = await deps.desks.membershipOf(scheduleId);
    if (membership?.deskId !== deskId || !(await deps.desks.acceptMember(deskId, scheduleId, userId))) throw refuse(404, 'There is no invitation for that cowork.');
    return viewOf(userId, desk, deps);
}

/** Take a cowork off a desk: its owner (leave, or decline an invitation) or the desk's maker (remove). */
export async function leaveDesk({ userId, deskId, scheduleId }: { userId: string; deskId: string; scheduleId: string }, deps: DeskDeps = defaults()): Promise<{ removed: true }> {
    const desk = await visibleDesk(userId, deskId, deps);
    const item = await deps.getSchedule(scheduleId);
    const allowed = !!item && (item.userId === userId || desk.ownerId === userId);
    if (!allowed || !(await deps.desks.removeMember(deskId, scheduleId))) throw refuse(404, 'That cowork is not on this desk.');
    return { removed: true };
}

/** The owner's per-item setting: which role of the desk decides this cowork's questions (null: as before). */
export async function setItemRole({ userId, deskId, scheduleId, deskRole }: { userId: string; deskId: string; scheduleId: string; deskRole: string | null }, deps: DeskDeps = defaults()): Promise<DeskView> {
    const desk = await visibleDesk(userId, deskId, deps);
    const [item, membership] = await Promise.all([deps.getSchedule(scheduleId), deps.desks.membershipOf(scheduleId)]);
    if (item?.userId !== userId || membership?.deskId !== deskId) throw refuse(404, 'That cowork is not on this desk.');
    if (deskRole && !(await deps.desks.listRoles(deskId)).some((r) => r.role === deskRole)) throw refuse(404, 'That role does not exist on this desk.');
    await deps.desks.setDeskRole(deskId, scheduleId, deskRole || null);
    return viewOf(userId, desk, deps);
}

/** The roles as the desk's maker sets them: each holder and stand-in a member of the organisation, a stand-in no holder. */
function checkedRoles(roles: RoleInput[], colleagues: Set<string>): RoleInput[] {
    if (roles.length > MAX_ROLES) throw refuse(400, `A desk has at most ${MAX_ROLES} roles.`);
    const seen = new Set<string>();
    return roles.map((r) => {
        const role = r.role.trim();
        if (!role || seen.has(role)) throw refuse(400, 'Every role has a name of its own.');
        seen.add(role);
        if (!colleagues.has(r.holderId) || (r.standInId && !colleagues.has(r.standInId))) throw refuse(404, 'That colleague is not in your organisation.');
        if (r.standInId === r.holderId) throw refuse(400, 'A stand-in is someone else than the holder.');
        return { role, holderId: r.holderId, standInId: r.standInId || null, awayUntil: r.awayUntil || null };
    });
}

/** The roles kept under their name whose holder or stand-in is someone else now. */
function changedHolders(before: DeskRole[], after: RoleInput[]): Set<string> {
    const was = new Map(before.map((r) => [r.role, r]));
    return new Set(after.filter((r) => {
        const old = was.get(r.role);
        return !!old && (old.holderId !== r.holderId || (old.standInId ?? null) !== (r.standInId ?? null));
    }).map((r) => r.role));
}

/**
 * Tell the owners whose coworks chose a role whose holder or stand-in changed: their questions go to someone else
 * now. The item's title and the role's name only; never the maker's own coworks. A notice that does not go out
 * does not undo the roles.
 */
async function tellRoleChanges(desk: Desk, userId: string, changed: Set<string>, deps: DeskDeps): Promise<void> {
    if (changed.size === 0) return;
    const users = (await deps.desks.listMembers(desk.id)).filter((m) => m.accepted && !!m.deskRole && changed.has(m.deskRole) && m.ownerId !== userId);
    await Promise.all(users.map((m) => deps.notify({
        userId: m.ownerId, category: 'cowork', title: 'A desk role changed',
        message: `The role "${m.deskRole}" that decides the questions of "${m.title || 'Untitled work'}" has another holder or stand-in now. Its next questions go to them.`,
        link: `/app/cowork/${m.scheduleId}`,
    }).catch((e: unknown) => fallback('usecases/coworkDesks:tellRoleChange', e, null))));
}

/** Set the desk's roles (the desk's maker only), in one go. Owners whose coworks use a role that changed hands are told. */
export async function setDeskRoles({ userId, deskId, roles }: { userId: string; deskId: string; roles: RoleInput[] }, deps: DeskDeps = defaults()): Promise<DeskView> {
    const desk = await visibleDesk(userId, deskId, deps);
    if (desk.ownerId !== userId) throw refuse(403, 'Only the person who made the desk sets its roles.');
    const colleagues = new Set((await deps.listMembers(desk.organizationId)).map((p) => p.id));
    const next = checkedRoles(roles, colleagues);
    const before = await deps.desks.listRoles(deskId);
    await deps.desks.setRoles(deskId, next);
    await tellRoleChanges(desk, userId, changedHolders(before, next), deps);
    return viewOf(userId, desk, deps);
}

/** The hand-off to `followerId` on the desk that the reader decides: it starts after a cowork of the reader's. */
async function handOffOf(desk: Desk, followerId: string, userId: string, deps: DeskDeps): Promise<{ leader: DeskMember; follower: DeskMember }> {
    const members = await deps.desks.listMembers(desk.id);
    const follower = members.find((m) => m.scheduleId === followerId);
    const leader = follower ? crossOwnerLeader(follower, members) : undefined;
    if (!follower || !leader || leader.ownerId !== userId) throw refuse(404, 'No colleague\'s cowork on this desk starts after one of yours.');
    return { leader, follower };
}

/**
 * The owner of a cowork lets a colleague's cowork that starts after it on the desk receive its result: once, for that
 * cowork and its owner of now. Until then it receives nothing.
 */
export async function allowHandOff({ userId, deskId, scheduleId }: { userId: string; deskId: string; scheduleId: string }, deps: DeskDeps = defaults()): Promise<DeskView> {
    const desk = await visibleDesk(userId, deskId, deps);
    const { leader, follower } = await handOffOf(desk, scheduleId, userId, deps);
    await deps.desks.allowFollow({ deskId, leaderId: leader.scheduleId, followerId: follower.scheduleId, followerOwner: follower.ownerId, allowedBy: userId });
    return viewOf(userId, desk, deps);
}

/** Withdraw that again: from the next run on, the colleague's cowork receives nothing of the reader's. */
export async function withdrawHandOff({ userId, deskId, scheduleId }: { userId: string; deskId: string; scheduleId: string }, deps: DeskDeps = defaults()): Promise<DeskView> {
    const desk = await visibleDesk(userId, deskId, deps);
    const { leader, follower } = await handOffOf(desk, scheduleId, userId, deps);
    await deps.desks.withdrawFollow(deskId, leader.scheduleId, follower.scheduleId);
    return viewOf(userId, desk, deps);
}

/** Remove the desk (its maker only). The coworks on it stay their owners', and stop handing work to each other. */
export async function deleteDesk({ userId, deskId }: { userId: string; deskId: string }, deps: DeskDeps = defaults()): Promise<{ removed: true }> {
    const desk = await visibleDesk(userId, deskId, deps);
    if (desk.ownerId !== userId) throw refuse(403, 'Only the person who made the desk removes it.');
    await deps.desks.deleteDesk(deskId);
    return { removed: true };
}

export interface ItemDesk { desk: { id: string; name: string; accepted: boolean; deskRole: string | null; invitedBy: string | null } | null }

/** The desk one of my coworks is on or invited to (its Settings tab). */
export async function itemDesk(item: Item, deps: DeskDeps = defaults()): Promise<ItemDesk> {
    const membership = await deps.desks.membershipOf(item.id);
    if (!membership) return { desk: null };
    const invitedBy = !membership.accepted && membership.addedBy && membership.addedBy !== item.userId ? nameOf(await deps.getUser(membership.addedBy)) : null;
    return { desk: { id: membership.deskId, name: membership.deskName, accepted: membership.accepted, deskRole: membership.deskRole, invitedBy } };
}
