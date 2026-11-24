/**
 * How an item starts, for its owner (routes/coworkStartRoutes.js): the clock, or one of the events of version 2.1
 * (core/cowork/startKinds.mts). A new mail is chosen in the item's edit form, as before.
 *
 *   - an event start needs an agent or a plan: a prompt on its own cannot act on what an event brings;
 *   - after another cowork: one of the owner's own items, or an item of another owner accepted on the same desk
 *     (stores/coworkDesks.mts), never itself, never one that (through others) follows this one. Across owners the
 *     start is saved, but the follower receives the other item's result only once that item's owner allowed it on the
 *     desk (usecases/coworkDesks.mts allowHandOff); that owner is told that it is asked;
 *   - a webhook: a new secret token each time it is chosen, sent as `Authorization: Bearer <token>` to POST
 *     /api/cowork/hooks; the token is shown once and only its hash is kept;
 *   - a table: one the owner can read through its own sharing;
 *   - a folder: a Nextcloud path, polled for the owner.
 *
 * Choosing a start takes the plan's approval away: the plan is checked again for what the new start brings
 * (an event's data is outside text) and approved again.
 */

import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { ownerCanRead } from '../core/cowork/tableStart.mts';

const nodeRequire = createRequire(import.meta.url);
const { fallback } = nodeRequire('../utils/bestEffort.js') as { fallback: <T>(label: string, err: unknown, value: T) => T };
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };

interface Item {
    id: string; userId: string; title?: string | null; triggerKind?: string | null; trigger?: Record<string, unknown> | null;
    agentId?: string | null; planAutomationId?: string | null; nextRunAt?: string | null; isActive?: boolean | null;
}

export type StartChoice =
    | { kind: 'schedule' }
    | { kind: 'after_cowork'; scheduleId: string }
    | { kind: 'webhook' }
    | { kind: 'row'; datatableId: string }
    | { kind: 'file'; inFolder: string };

export interface StartDeps {
    getSchedule: (id: string) => Promise<Item | null>;
    setStart: (scheduleId: string, kind: string, trigger: Record<string, unknown> | null) => Promise<void>;
    syncSubscription: (item: Item) => Promise<unknown>;
    canReadTable: (userId: string, datatableId: string) => Promise<boolean>;
    clientHost: () => string;
    /** Are both items accepted on one desk (stores/coworkDesks.mts)? Without it, only the owner's own items. */
    sameDesk?: (a: string, b: string) => Promise<boolean>;
    /** Tell the owner of `leader` that `item`, of another owner, asks for its result (unless that was allowed already). */
    askLeader?: (item: Item, leader: Item) => Promise<unknown>;
}

/** The default `askLeader`: a Cowork notice to the leader's owner, with the colleague's name and both titles. */
async function askLeaderOwner(item: Item, leader: Item): Promise<void> {
    const desks = (nodeRequire('../stores/coworkDesks.mts') as typeof import('../stores/coworkDesks.mts')).coworkDesks();
    if (await desks.followAllowed(leader.id, item.id)) return;
    const owner = await (nodeRequire('../stores/userStore.js') as { getUser: (id: string) => Promise<{ displayName?: string | null; username?: string | null } | null> }).getUser(item.userId);
    const name = (owner?.displayName || owner?.username || 'A colleague').trim();
    await (nodeRequire('../stores/notificationStore.js') as { createNotification: (n: Record<string, unknown>) => Promise<unknown> }).createNotification({
        userId: leader.userId, category: 'cowork', title: 'A colleague\'s cowork asks for your results',
        message: `${name}'s "${item.title || 'Untitled work'}" wants to start after your "${leader.title || 'Untitled work'}" and receive its result. It receives nothing until you allow it on the desk.`,
        link: `/app/cowork/${leader.id}`,
    });
}

const defaults = (): StartDeps => ({
    getSchedule: (id) => (nodeRequire('../stores/coworkStore.js') as { getSchedule: StartDeps['getSchedule'] }).getSchedule(id),
    setStart: (id, kind, trigger) => (nodeRequire('../stores/coworkStarts.mts') as typeof import('../stores/coworkStarts.mts')).coworkStarts().setStart(id, kind, trigger),
    syncSubscription: (item) => (nodeRequire('../automation/subscriptionSync.js') as { syncCoworkMailTrigger: (s: Item) => Promise<unknown> }).syncCoworkMailTrigger(item),
    canReadTable: ownerCanRead,
    clientHost: () => (nodeRequire('../utils/appPaths.js') as { clientHost: () => string }).clientHost(),
    sameDesk: (a, b) => (nodeRequire('../stores/coworkDesks.mts') as typeof import('../stores/coworkDesks.mts')).coworkDesks().sameDesk(a, b),
    askLeader: askLeaderOwner,
});

/** May the item start after `target`: one of its owner's own, or one on the same desk. */
const mayStartAfter = async (item: Item, target: Item, deps: StartDeps): Promise<boolean> => target.userId === item.userId || (!!deps.sameDesk && await deps.sameDesk(item.id, target.id));

export interface StartState {
    kind: string;
    /** after_cowork: the item it starts after. */
    after: { id: string; title: string } | null;
    datatableId: string | null;
    inFolder: string | null;
    /** webhook: it has an address (the address itself is shown once, when it is made). */
    hasAddress: boolean;
}

const refuse = (status: number, message: string) => new HttpError(status, 'cowork_start_refused', message);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** How the item starts now. */
export async function startOf(item: Item, deps: StartDeps = defaults()): Promise<StartState> {
    const kind = item.triggerKind || 'schedule';
    const t = item.trigger ?? {};
    const afterId = kind === 'after_cowork' ? str(t.scheduleId) : null;
    const after = afterId ? await deps.getSchedule(afterId) : null;
    return {
        kind,
        after: after && await mayStartAfter(item, after, deps) ? { id: after.id, title: after.title || 'Untitled work' } : null,
        datatableId: kind === 'row' ? str(t.datatableId) : null,
        inFolder: kind === 'file' ? str(t.inFolder) : null,
        hasAddress: kind === 'webhook' && !!str(t.tokenHash),
    };
}

/** Would `itemId` start after itself, through the chain that `target` starts after? */
async function closesALoop(itemId: string, target: Item, deps: StartDeps): Promise<boolean> {
    let at: Item | null = target;
    for (let hops = 0; at && hops < 20; hops += 1) {
        if (at.id === itemId) return true;
        const next: string | null = at.triggerKind === 'after_cowork' ? str(at.trigger?.scheduleId) : null;
        if (next === itemId) return true;
        at = next ? await deps.getSchedule(next) : null;
    }
    return false;
}

/** The trigger to store for a choice; for a webhook also the address, shown once. */
/** A webhook's address: where to send, and the token to send as `Authorization: Bearer <token>` (shown once). */
export interface HookAddress { url: string; token: string }

async function triggerFor(item: Item, choice: StartChoice, deps: StartDeps): Promise<{ trigger: Record<string, unknown> | null; address: HookAddress | null; leader?: Item }> {
    switch (choice.kind) {
        case 'schedule':
            if (!item.nextRunAt) throw refuse(409, 'Set when it runs first, in the edit form.');
            return { trigger: null, address: null };
        case 'after_cowork': {
            const target = await deps.getSchedule(choice.scheduleId);
            if (target?.id === item.id) throw refuse(409, 'A cowork cannot start after itself.');
            if (!target || !(await mayStartAfter(item, target, deps))) throw refuse(404, 'That cowork does not exist.');
            if (await closesALoop(item.id, target, deps)) throw refuse(409, 'That would make the two run each other in a circle.');
            return { trigger: { scheduleId: target.id }, address: null, leader: target };
        }
        case 'webhook': {
            const token = crypto.randomBytes(24).toString('base64url');
            return { trigger: { tokenHash: crypto.createHash('sha256').update(token).digest('hex') }, address: { url: `${deps.clientHost()}/api/cowork/hooks`, token } };
        }
        case 'row':
            if (!(await deps.canReadTable(item.userId, choice.datatableId))) throw refuse(404, 'That table does not exist, or you cannot read it.');
            return { trigger: { datatableId: choice.datatableId }, address: null };
        case 'file':
            return { trigger: { inFolder: choice.inFolder }, address: null };
    }
}

/** Choose how the item starts. Answers the new start, and for a webhook its address (only now). */
export async function chooseStart({ item, choice }: { item: Item; choice: StartChoice }, deps: StartDeps = defaults()): Promise<StartState & { address: HookAddress | null }> {
    if (choice.kind !== 'schedule' && !item.agentId && !item.planAutomationId) {
        throw refuse(409, 'Give it an agent or a plan first: a prompt on its own cannot act on what an event brings.');
    }
    const { trigger, address, leader } = await triggerFor(item, choice, deps);
    await deps.setStart(item.id, choice.kind, trigger);
    // Across owners the other owner decides whether their result goes along; a notice that does not go out changes nothing.
    if (leader && leader.userId !== item.userId && deps.askLeader) await deps.askLeader(item, leader).catch((e: unknown) => fallback('usecases/coworkStart:askLeader', e, null));
    const updated: Item = { ...item, triggerKind: choice.kind, trigger };
    // The subscription follows the start: a new mail or a folder has one, anything else none.
    await deps.syncSubscription(updated);
    return { ...(await startOf(updated, deps)), address };
}
