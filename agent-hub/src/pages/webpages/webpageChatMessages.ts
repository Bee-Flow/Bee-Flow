import type { ChatMessage } from '../../hooks/useChatEngine/types';

/** The plan card an assistant turn may carry (`message.webpagePlan`). */
interface WebpagePlan {
    planId?: string;
    status?: string;
    [key: string]: unknown;
}

/** One diff card under an assistant reply (`message.webpageEdits[]`). */
export interface WebpageEdit {
    file: string;
    title: string;
    diff: unknown;
}

const planOf = (m: ChatMessage): WebpagePlan | undefined => m.webpagePlan as WebpagePlan | undefined;

/** Set the status of the plan card with `planId`. */
export function setPlanStatus(messages: ChatMessage[], planId: string, status: string): ChatMessage[] {
    return messages.map(m => {
        const plan = planOf(m);
        return plan && plan.planId === planId ? { ...m, webpagePlan: { ...plan, status } } : m;
    });
}

/**
 * Flip every plan card in "approved" state to "executed" (after the build
 * round-trip). Returns the same array when nothing changed, so a state update
 * with it is a no-op.
 */
export function markApprovedPlansExecuted(messages: ChatMessage[]): ChatMessage[] {
    let changed = false;
    const next = messages.map(m => {
        const plan = planOf(m);
        if (plan && plan.status === 'approved') {
            changed = true;
            return { ...m, webpagePlan: { ...plan, status: 'executed' } };
        }
        return m;
    });
    return changed ? next : messages;
}

/** Attach a diff card to the most recent assistant message. */
export function appendEditToLatestAssistant(messages: ChatMessage[], edit: WebpageEdit): ChatMessage[] {
    if (!messages || messages.length === 0) return messages;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') {
            const msg = messages[i];
            const edits = Array.isArray(msg.webpageEdits) ? msg.webpageEdits : [];
            return [
                ...messages.slice(0, i),
                { ...msg, webpageEdits: [...edits, edit] },
                ...messages.slice(i + 1),
            ];
        }
    }
    return messages;
}

/** Id of the latest assistant message, or null. */
export function latestAssistantId(messages: ChatMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') return messages[i].id;
    }
    return null;
}
