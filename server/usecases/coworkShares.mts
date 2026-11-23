/**
 * Sharing a cowork with a team (routes/coworkShareRoutes.js): the owner names colleagues of their own organisation
 * who may see the item and its runs (viewer), and at most one who also decides its runs' questions (approver: the
 * questions in front of its steps are assigned to them, core/cowork/plan/planIndependence.mts). The item stays the
 * owner's: it runs as the owner, with the owner's connections, and only the owner changes it.
 *
 * A colleague of another organisation is never a share: the same 404 as someone who does not exist.
 */

import { createRequire } from 'node:module';
import type { Share, ShareRole, SharedItem } from '../stores/coworkShares.mts';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };

interface Item { id: string; userId: string; title?: string | null; prompt?: string | null; repeatInterval?: string | null; nextRunAt?: string | null; lastStatus?: string | null; isActive?: boolean | null; triggerKind?: string | null }
interface Person { id: string; organizationId?: string | null; status?: string | null; displayName?: string | null; username?: string | null }
interface Run { id: string; status?: string | null; startedAt?: string | null; result?: string | null; durationMs?: number | null }

export interface ShareDeps {
    getUser: (id: string) => Promise<Person | null>;
    listMembers: (orgId: string) => Promise<Person[]>;
    shares: {
        listShares: (scheduleId: string) => Promise<Share[]>;
        setShares: (scheduleId: string, shares: Share[], addedBy: string) => Promise<void>;
        sharedWith: (userId: string) => Promise<SharedItem[]>;
        roleOf: (scheduleId: string, userId: string) => Promise<ShareRole | null>;
    };
    getSchedule: (id: string) => Promise<Item | null>;
    listRuns: (scheduleId: string, opts: { limit: number }) => Promise<Run[]>;
}

const defaults = (): ShareDeps => {
    const users = () => nodeRequire('../stores/userStore.js') as { getUser: ShareDeps['getUser']; getOrgMembersForDirectory: ShareDeps['listMembers'] };
    const cowork = () => nodeRequire('../stores/coworkStore.js') as Pick<ShareDeps, 'getSchedule' | 'listRuns'>;
    return {
        getUser: (id) => users().getUser(id),
        listMembers: (orgId) => users().getOrgMembersForDirectory(orgId),
        shares: (nodeRequire('../stores/coworkShares.mts') as typeof import('../stores/coworkShares.mts')).coworkShares(),
        getSchedule: (id) => cowork().getSchedule(id),
        listRuns: (id, opts) => cowork().listRuns(id, opts),
    };
};

export const MAX_SHARES = 50;
const nameOf = (p: Person | null | undefined): string => (p?.displayName || p?.username || 'A colleague').trim();
const refuse = (status: number, message: string) => new HttpError(status, 'cowork_share_refused', message);

/** The colleagues of the owner's organisation, by id. */
async function colleaguesOf(ownerId: string, deps: ShareDeps): Promise<Map<string, Person>> {
    const owner = await deps.getUser(ownerId);
    if (!owner?.organizationId) return new Map();
    return new Map((await deps.listMembers(owner.organizationId)).filter((m) => m.id !== ownerId).map((m) => [m.id, m]));
}

/** Who the item is shared with, by name. */
export async function sharesOf(item: Item, deps: ShareDeps = defaults()): Promise<Array<Share & { name: string }>> {
    const [shares, colleagues] = await Promise.all([deps.shares.listShares(item.id), colleaguesOf(item.userId, deps)]);
    return shares.filter((s) => colleagues.has(s.userId)).map((s) => ({ ...s, name: nameOf(colleagues.get(s.userId)) }));
}

/** Set who the item is shared with. Every one a colleague of the owner's organisation; at most one approver. */
export async function setSharesFor({ item, shares }: { item: Item; shares: Share[] }, deps: ShareDeps = defaults()): Promise<Array<Share & { name: string }>> {
    if (shares.length > MAX_SHARES) throw refuse(400, `A cowork is shared with at most ${MAX_SHARES} people.`);
    if (shares.filter((s) => s.role === 'approver').length > 1) throw refuse(400, 'One colleague decides the questions of a cowork; the others can see it.');
    const unique = new Map(shares.map((s) => [s.userId, s]));
    const colleagues = await colleaguesOf(item.userId, deps);
    for (const userId of unique.keys()) {
        if (!colleagues.has(userId)) throw refuse(404, 'That colleague is not in your organisation.');
    }
    await deps.shares.setShares(item.id, [...unique.values()], item.userId);
    return sharesOf(item, deps);
}

/** The items shared with me, with whose they are. */
export async function sharedWithMe(userId: string, deps: ShareDeps = defaults()): Promise<Array<SharedItem & { ownerName: string }>> {
    const items = await deps.shares.sharedWith(userId);
    const owners = new Map<string, string>();
    for (const item of items) if (!owners.has(item.ownerId)) owners.set(item.ownerId, nameOf(await deps.getUser(item.ownerId)));
    return items.map((i) => ({ ...i, ownerName: owners.get(i.ownerId) ?? 'A colleague' }));
}

export interface SharedView {
    role: ShareRole | 'owner';
    item: { id: string; title: string; prompt: string; repeatInterval: string | null; nextRunAt: string | null; lastStatus: string | null; isActive: boolean; triggerKind: string };
    runs: Array<{ id: string; status: string | null; startedAt: string | null; result: string | null; durationMs: number | null }>;
}

/** An item as someone it is shared with sees it (its owner too): read only. Anyone else gets a 404. */
export async function sharedItemOf(userId: string, itemId: string, deps: ShareDeps = defaults()): Promise<SharedView> {
    const item = await deps.getSchedule(itemId);
    const role = item ? (item.userId === userId ? 'owner' : await deps.shares.roleOf(item.id, userId)) : null;
    if (!item || !role) throw refuse(404, 'That cowork does not exist.');
    const runs = await deps.listRuns(item.id, { limit: 10 });
    return {
        role,
        item: {
            id: item.id, title: item.title ?? '', prompt: item.prompt ?? '', repeatInterval: item.repeatInterval ?? null, nextRunAt: item.nextRunAt ?? null,
            lastStatus: item.lastStatus ?? null, isActive: item.isActive !== false, triggerKind: item.triggerKind ?? 'schedule',
        },
        runs: runs.map((r) => ({ id: r.id, status: r.status ?? null, startedAt: r.startedAt ?? null, result: r.result ?? null, durationMs: r.durationMs ?? null })),
    };
}
