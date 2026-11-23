/**
 * Hand a cowork over to a colleague (routes/coworkHandOverRoutes.js). The new owner gets the work, not the old owner's
 * history: a new item with the same brief and schedule, paused, and a copy of the plan in an automation of their own
 * that nobody has approved yet ("Needs you" asks them). The old item goes, with its runs: what those runs read and
 * produced was the old owner's, and it does not change hands.
 *
 *   - only within one organisation, and only to an active colleague;
 *   - an item that starts on a new mail is tied to its owner's mailbox and is not handed over;
 *   - nothing runs as the new owner until they have looked at it: the item is paused and the plan unapproved.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };

interface Item {
    id: string; userId: string; title?: string | null; prompt?: string | null; repeatInterval?: string | null; nextRunAt?: string | null;
    modelTier?: string | null; timezone?: string | null; toolsEnabled?: unknown; agentId?: string | null; daysOfWeek?: unknown;
    timeOfDay?: string | null; enabledApps?: unknown; triggerKind?: string | null; planAutomationId?: string | null;
}
interface Person { id: string; organizationId?: string | null; status?: string | null; displayName?: string | null; username?: string | null }

export interface HandOverDeps {
    getUser: (id: string) => Promise<Person | null>;
    listMembers: (orgId: string) => Promise<Array<{ id: string; displayName?: string | null; username?: string | null }>>;
    store: {
        createSchedule: (fields: Record<string, unknown>) => Promise<{ id: string } | null>;
        updateSchedule: (id: string, updates: Record<string, unknown>) => Promise<unknown>;
        deleteSchedule: (id: string) => Promise<unknown>;
        getApprovedPlan: (scheduleId: string) => Promise<{ definition: unknown } | null>;
        attachPlanAutomation: (scheduleId: string, automationId: string) => Promise<unknown>;
    };
    getAutomation: (id: string) => Promise<{ userId?: string; definition?: unknown } | null>;
    createAutomation: (input: { userId: string; organizationId: string | null; title: string; definition: unknown; triggerType: string }) => Promise<{ id: string }>;
    notify: (n: { userId: string; category: string; title: string; message: string; link: string }) => Promise<unknown>;
}

const defaults = (): HandOverDeps => {
    const users = () => nodeRequire('../stores/userStore.js') as { getUser: HandOverDeps['getUser']; getOrgMembersForDirectory: HandOverDeps['listMembers'] };
    const automations = () => nodeRequire('../stores/automationStore') as Pick<HandOverDeps, 'getAutomation' | 'createAutomation'>;
    return {
        getUser: (id) => users().getUser(id),
        listMembers: (orgId) => users().getOrgMembersForDirectory(orgId),
        store: nodeRequire('../stores/coworkStore.js') as HandOverDeps['store'],
        getAutomation: (id) => automations().getAutomation(id),
        createAutomation: (input) => automations().createAutomation(input),
        notify: (n) => (nodeRequire('../stores/notificationStore') as { createNotification: HandOverDeps['notify'] }).createNotification(n),
    };
};

const nameOf = (p: { displayName?: string | null; username?: string | null } | null): string => (p?.displayName || p?.username || 'A colleague').trim();

/** The colleagues this item can go to: the owner's organisation, without the owner. Id and name only. */
export async function colleaguesOf(item: Item, deps: HandOverDeps = defaults()): Promise<Array<{ id: string; name: string }>> {
    const owner = await deps.getUser(item.userId);
    if (!owner?.organizationId) return [];
    return (await deps.listMembers(owner.organizationId)).filter((m) => m.id !== item.userId).map((m) => ({ id: m.id, name: nameOf(m) }));
}

/** The plan the new owner gets to approve: the approved one, else the old owner's own draft; null without a plan. */
async function planToCopy(item: Item, deps: HandOverDeps): Promise<unknown> {
    const approved = await deps.store.getApprovedPlan(item.id);
    if (approved) return approved.definition;
    if (!item.planAutomationId) return null;
    const draft = await deps.getAutomation(item.planAutomationId);
    return draft && draft.userId === item.userId ? draft.definition ?? null : null;
}

/** The colleague the item goes to: active, in the owner's organisation, not the owner. Refuses anyone else. */
async function receiverOf(item: Item, toUserId: string, deps: HandOverDeps): Promise<{ from: Person | null; to: Person }> {
    const [from, to] = await Promise.all([deps.getUser(item.userId), deps.getUser(toUserId)]);
    const sameOrg = !!from?.organizationId && from.organizationId === to?.organizationId;
    const active = !to?.status || to.status === 'active';
    if (!to || toUserId === item.userId || !sameOrg || !active) {
        throw new HttpError(404, 'cowork_hand_over_refused', 'That colleague is not in your organisation.');
    }
    return { from, to };
}

/** The new owner's item: the same brief and schedule, paused, with the plan in an automation of their own. */
async function newItemFor(item: Item, to: Person, definition: unknown, deps: HandOverDeps): Promise<string> {
    const created = await deps.store.createSchedule({
        userId: to.id, title: item.title, prompt: item.prompt, repeatInterval: item.repeatInterval, nextRunAt: item.nextRunAt,
        modelTier: item.modelTier, timezone: item.timezone, toolsEnabled: item.toolsEnabled, agentId: item.agentId,
        daysOfWeek: item.daysOfWeek, timeOfDay: item.timeOfDay, enabledApps: item.enabledApps, triggerKind: 'schedule',
    });
    if (!created) throw new Error('The new item could not be created.');
    // Paused until the new owner has looked at it.
    await deps.store.updateSchedule(created.id, { isActive: false });
    if (definition) {
        const automation = await deps.createAutomation({ userId: to.id, organizationId: to.organizationId ?? null, title: item.title || 'Cowork plan', definition, triggerType: 'manual' });
        await deps.store.attachPlanAutomation(created.id, automation.id);
    }
    return created.id;
}

/** Hand the item to `toUserId`. Answers the new item's id. */
export async function handOver({ item, toUserId }: { item: Item; toUserId: string }, deps: HandOverDeps = defaults()): Promise<{ itemId: string }> {
    if (item.triggerKind === 'app_event') throw new HttpError(409, 'cowork_hand_over_refused', 'An item that starts on a new mail is tied to your mailbox, so it cannot be handed over.');
    const { from, to } = await receiverOf(item, toUserId, deps);
    const definition = await planToCopy(item, deps);
    const itemId = await newItemFor(item, to, definition, deps);
    await deps.store.deleteSchedule(item.id);
    await deps.notify({
        userId: to.id, category: 'cowork', title: 'A cowork was handed to you',
        message: `${nameOf(from)} handed you "${item.title ?? ''}". It is paused until you look at it${definition ? ' and approve its plan' : ''}.`,
        link: `/app/cowork/${itemId}`,
    }).catch(() => undefined);
    return { itemId };
}
