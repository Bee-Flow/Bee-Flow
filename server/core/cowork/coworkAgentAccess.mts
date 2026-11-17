/**
 * May this person hand a Cowork item to this agent?
 *
 * The same audience as a chat turn (auth/agentAccess.mts `canChatAgent`): the
 * owner always (a draft included, as before), otherwise a published agent in
 * the person's organisation and, when it names shared groups, one of them. A
 * Cowork run is a chat turn the person did not type: it runs with that
 * person's own credentials (automationAuth.buildUserAuth on the item's user),
 * never the owner's, so it can reach nothing the chat could not.
 *
 * Asked twice: when the item is created or changed (routes/cowork.js) and again
 * at every run (agentScheduleRun.js), so an agent that is unpublished, moved or
 * taken out of the person's groups stops running on the next tick.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type AgentRow = { id: string; owner_id?: string | null; [key: string]: unknown };
type ChatRule = { canChatAgent: (agent: AgentRow, userId: string, req: { session: { user: { id: string } } }) => Promise<boolean> };

function defaultRule(): ChatRule {
    return (nodeRequire('../agentRuntime/agentAccess.js') as { defaultAgentAccess: () => ChatRule }).defaultAgentAccess();
}

export async function canRunCoworkAgent(agent: AgentRow | null | undefined, userId: string, rule: ChatRule = defaultRule()): Promise<boolean> {
    if (!agent || !userId) return false;
    if (agent.owner_id === userId) return true;
    // No request at run time: the rule reads organisation and groups fresh from
    // the user row, which is what a session-less request resolves to.
    return rule.canChatAgent(agent, userId, { session: { user: { id: userId } } }).catch(() => false);
}
