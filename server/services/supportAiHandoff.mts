/**
 * How the support AI responder (./supportAiResponder.js) hands a thread to
 * staff: an escalation after the AI tried, the hand-off when AI replies are
 * switched off for the company inbox, the audit row, and the round-robin
 * assignment. Every function here is best effort and never throws: a failed
 * write is logged and the next step still runs.
 *
 * The store comes in through `makeHandoff`, so the responder and its tests
 * share one store without reaching into the module system.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../telemetry/log');
const { fallback } = nodeRequire('../utils/bestEffort');

/** `ai_escalated_reason` of a company-inbox thread that went to staff because AI replies are off. */
export const AI_OFF_REASON = 'ai_off';

/** The notice in a thread whose inbox has AI replies switched off. */
export const AI_OFF_NOTICE = 'AI replies are off for this inbox. A member of staff will reply.';

interface HandoffThread {
    id: string;
    status?: string | null;
    ai_escalated_reason?: string | null;
    assignee_user_id?: string | null;
    inbox_id?: string | null;
    organization_id?: string | null;
}

/** The part of stores/supportStore the hand-off writes through. */
export interface HandoffStore {
    appendMessage(message: { threadId: string; authorKind: string; body: string }): Promise<unknown>;
    updateThread(threadId: string, patch: Record<string, unknown>): Promise<unknown>;
    getThread(threadId: string): Promise<HandoffThread | null | undefined>;
    recordThreadEvent?(event: Record<string, unknown>): Promise<unknown>;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The hand-off steps, writing through the store `getStore` returns at call time. */
export function makeHandoff(getStore: () => HandoffStore) {
    async function recordEvent(payload: Record<string, unknown>) {
        const store = getStore();
        try {
            if (typeof store.recordThreadEvent === 'function') await store.recordThreadEvent(payload);
        } catch (e) {
            log.warn('[SupportAI] recordThreadEvent failed:', messageOf(e));
        }
    }

    /**
     * Assign an unassigned escalated thread to the next staff member via the
     * round-robin cursor. No-op if already assigned or no eligible staff.
     */
    async function maybeAutoAssign(threadId: string) {
        const store = getStore();
        const thread = await store.getThread(threadId);
        if (!thread || thread.assignee_user_id) return;
        // Respect per-inbox group access when picking an assignee.
        let sharedGroups: unknown[] = [];
        if (thread.inbox_id) {
            try {
                const inbox = await nodeRequire('../stores/supportInboxStore').getInbox(thread.inbox_id);
                sharedGroups = Array.isArray(inbox?.shared_groups) ? inbox.shared_groups : [];
            } catch (err) { fallback('services/supportAiHandoff:maybeAutoAssign', err); /* default open */ }
        }
        const { pickNextAssignee } = nodeRequire('../core/support/supportAutoAssigner');
        const next = await pickNextAssignee(thread.organization_id || null, { sharedGroups, tenantInbox: !!thread.inbox_id });
        if (!next) return;
        await store.updateThread(threadId, { assignee_user_id: next, auto_assigned: true });
        await recordEvent({
            threadId, actorUserId: null, actorKind: 'system',
            action: 'auto_assigned', payload: { assignee_user_id: next },
        });
    }

    async function assignQuietly(threadId: string) {
        try {
            await maybeAutoAssign(threadId);
        } catch (e) {
            log.warn('[SupportAI] auto-assign failed:', messageOf(e));
        }
    }

    /**
     * Escalate the thread to staff. Idempotent: caller may invoke this from any
     * failure path. Appends a system message + updates status + records an audit
     * event.
     */
    async function escalate(threadId: string, reason: string, { systemMessage }: { systemMessage?: string } = {}) {
        const store = getStore();
        try {
            await store.appendMessage({
                threadId,
                authorKind: 'system',
                body: systemMessage || `AI handed off to a human agent (${reason}).`,
            });
        } catch (e) {
            log.warn('[SupportAI] escalate appendMessage failed:', messageOf(e));
        }
        try {
            await store.updateThread(threadId, { status: 'awaiting_agent', ai_handled: true, ai_escalated_reason: reason });
        } catch (e) {
            log.warn('[SupportAI] escalate updateThread failed:', messageOf(e));
        }
        await recordEvent({ threadId, actorUserId: null, actorKind: 'ai', action: 'ai_escalated', payload: { reason } });
        await assignQuietly(threadId);
    }

    /**
     * The company inbox has AI replies switched off: hand the thread to staff
     * without any model call. `ai_handled` stays false, so a follow-up from the
     * requester does not ask the AI again; a second message on a thread that was
     * already handed off this way adds no second notice.
     */
    async function handOffAiOff(thread: HandoffThread) {
        const store = getStore();
        const alreadyHandedOff = thread.ai_escalated_reason === AI_OFF_REASON && thread.status === 'awaiting_agent';
        if (!alreadyHandedOff) {
            try {
                await store.appendMessage({ threadId: thread.id, authorKind: 'system', body: AI_OFF_NOTICE });
            } catch (e) {
                log.warn('[SupportAI] ai-off appendMessage failed:', messageOf(e));
            }
        }
        try {
            await store.updateThread(thread.id, { status: 'awaiting_agent', ai_handled: false, ai_escalated_reason: AI_OFF_REASON });
        } catch (e) {
            log.warn('[SupportAI] ai-off updateThread failed:', messageOf(e));
        }
        if (!alreadyHandedOff) {
            await recordEvent({ threadId: thread.id, actorUserId: null, actorKind: 'system', action: 'ai_off', payload: { reason: AI_OFF_REASON } });
        }
        await assignQuietly(thread.id);
    }

    return { recordEvent, maybeAutoAssign, escalate, handOffAiOff };
}
