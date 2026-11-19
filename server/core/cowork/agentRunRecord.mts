/**
 * What a Cowork run as its agent (./agentScheduleRun.js) records about itself and says when it ends:
 *
 *   - the conversation it writes into: the item's own when that is a Cowork conversation, else a fresh one;
 *   - what it adds to its history row when it closes (stores/coworkRunClose.mts): its row, what it did (names and
 *     counts, ./runActivity.mts), its conversation, its review, and the run context a follow-up needs to run under
 *     the same policy (tool names, unattended, a mail run's ids: no address);
 *   - its notification, which opens the run in Cowork.
 */

import { createRequire } from 'node:module';
import { summariseActivity, offeredToolNames, skillIdsOf } from './runActivity.mts';
import type { CoworkRunContext } from './runActivity.mts';

const nodeRequire = createRequire(import.meta.url);
const { fallback } = nodeRequire('../../utils/bestEffort.js') as { fallback: <T>(label: string, err: unknown, value: T) => T };

type Task = { id: string; userId: string; title?: string; conversationId?: string | null };
type Agent = { name?: string | null; organization_id?: string | null };
type Trigger = {
    mailSubject?: string | null;
    notification: (info: { agentName: string; task: Task }) => { title: string; message: string };
} | null;
type SkillNames = (ids: string[], orgId: string | null, userId: string) => Promise<Map<string, string>>;

/** A store's answer for the row it opened (null for an unknown schedule). */
export const rowIdOf = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * The names of the skills a run noted, as the item's user may see them (a deleted or hidden one has none and is left
 * out of the activity). Read-only on the skill store.
 */
export async function skillNamesOf(ids: string[], orgId: string | null, userId: string): Promise<Map<string, string>> {
    if (ids.length === 0 || !orgId) return new Map();
    const { getSkillsByIds } = nodeRequire('../../stores/skillStore.js') as {
        getSkillsByIds: (ids: string[], orgId: string, userId: string) => Promise<Array<{ id?: unknown; name?: unknown }> | null>;
    };
    const rows = await getSkillsByIds(ids, orgId, userId);
    const out = new Map<string, string>();
    for (const s of rows || []) if (s && typeof s.id === 'string' && s.name) out.set(s.id, String(s.name));
    return out;
}

/**
 * The conversation a run writes into: the item's own when that is a Cowork conversation, else a fresh one (which
 * turnSetup marks as Cowork's). An item that was pointed at a chat, or whose old conversation a person went on
 * chatting in (the migration cowork-conversation-origin-2026-11 leaves those as chats), writes no run into it.
 */
export async function conversationForRun(task: Task, agentStore: { getConversationOrigin?: (id: string) => Promise<string | null> }): Promise<string | null> {
    if (!task.conversationId) return null;
    if (typeof agentStore.getConversationOrigin !== 'function') return task.conversationId;
    const origin = await agentStore.getConversationOrigin(task.conversationId)
        .catch((e: unknown) => fallback<string | null>('core/cowork/agentRunRecord:conversationForRun', e, null));
    return origin === 'cowork' ? task.conversationId : null;
}

type RunState = { runId: string | null; agent: Agent | null; conversationId: string | null; parts: { extraMetadata?: Record<string, unknown> } | null };

/** What the run adds to its history row when it closes. */
export async function runCloseOf(task: Task, run: RunState, coworkRun: CoworkRunContext, trigger: Trigger, skillNames: SkillNames) {
    const orgId = run.agent?.organization_id || null;
    const names = await skillNames(skillIdsOf(coworkRun), orgId, task.userId)
        .catch((e: unknown) => fallback('core/cowork/agentRunRecord:runCloseOf', e, new Map<string, string>()));
    const extra = run.parts?.extraMetadata || {};
    const mt = extra.mailTrigger as { provider?: string; messageId?: string; threadId?: string | null; mailbox?: string | null; readOutside?: boolean } | undefined;
    return {
        runId: run.runId,
        review: coworkRun.review,
        activity: summariseActivity(coworkRun, names),
        conversationId: run.conversationId,
        mailSubject: trigger?.mailSubject || null,
        runContext: {
            offeredTools: offeredToolNames(coworkRun),
            unattended: extra.unattended === true,
            mail: mt && typeof mt === 'object'
                ? { provider: mt.provider, messageId: mt.messageId, threadId: mt.threadId ?? null, mailbox: mt.mailbox ?? null, readOutside: mt.readOutside === true }
                : null,
        },
    };
}

/**
 * The notification of a finished run. It opens the run in Cowork. An event run says what it did, not what it read
 * (the result may quote the incoming mail), and a run that asks for review says only that: the reason may too.
 */
export function runNotification(
    task: Task, agent: Agent, resultText: string,
    { trigger, review, shape }: { trigger: Trigger; review: { reason: string } | null; shape: { category: string; prefix: string } },
) {
    const agentName = agent.name || 'Agent';
    const { coworkTaskPath } = nodeRequire('../../utils/appPaths.js') as { coworkTaskPath: (id: string) => string };
    const base = { userId: task.userId, taskId: task.id, category: shape.category, link: coworkTaskPath(task.id) };
    if (review) {
        const about = trigger?.mailSubject ? `"${trigger.mailSubject}"` : task.title;
        return { ...base, title: `${agentName} needs your review: ${about}`, message: 'The agent asked you to decide before it goes on. Open it in Cowork to answer or close it.' };
    }
    const say = trigger ? trigger.notification({ agentName, task }) : null;
    return { ...base, title: say ? say.title : `${shape.prefix}${agentName}: ${task.title}`, message: say ? say.message : resultText };
}
