/**
 * The builder chat's transcript, as the phone holds it and as the server
 * stores it.
 *
 * The stored rows are the WEB's messages (useChatEngine's `{ id, role,
 * content, timestamp, webpagePlan, … }`), saved whole by PUT /:id/chat. Both
 * clients write the same row, so the phone keeps every row it read as it was
 * (`raw`) and only overwrites the fields it owns. A field the web adds next
 * year then survives a turn sent from the phone.
 */

import type { ChatMessage } from '@/features/chat';
import { readPlan, type WebpagePlan, type WebpageTurn } from '@/shared/stream';

export type PlanStatus = 'pending' | 'approved' | 'rejected' | 'executed';

export interface PlanState {
    plan: WebpagePlan;
    status: PlanStatus;
}

export interface ChatEntry {
    message: ChatMessage;
    /** A plan the builder proposed in this answer (ask/plan mode). */
    plan: PlanState | null;
    /** The row as stored; fields the phone does not own ride along untouched. */
    raw: Record<string, unknown>;
    /** A message the web sent without showing it (an approval nudge). */
    hidden: boolean;
}

/** How the builder edits: the web's two segments. A stored 'plan' reads as 'ask'. */
export type ChatMode = 'auto' | 'ask';

const PLAN_STATUSES: readonly PlanStatus[] = ['pending', 'approved', 'rejected', 'executed'];

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function readPlanState(raw: unknown): PlanState | null {
    if (!raw || typeof raw !== 'object') return null;
    const row = raw as Record<string, unknown>;
    const plan = readPlan(row);
    if (!plan) return null;
    const status = PLAN_STATUSES.includes(row.status as PlanStatus) ? (row.status as PlanStatus) : 'pending';
    return { plan, status };
}

/** One stored row. A row without a role the transcript draws is kept, hidden. */
export function readEntry(raw: Record<string, unknown>, index: number): ChatEntry {
    const role = raw.role === 'user' || raw.role === 'assistant' ? raw.role : null;
    const id = text(raw.id) || `stored-${index}`;
    const createdAt = text(raw.timestamp) || text(raw.createdAt) || undefined;
    return {
        message: { id, role: role ?? 'system', content: text(raw.content), createdAt },
        plan: readPlanState(raw.webpagePlan),
        raw,
        hidden: role === null || raw.isHidden === true,
    };
}

export function readStoredChat(rows: readonly Record<string, unknown>[]): ChatEntry[] {
    return rows.map(readEntry);
}

/** The row to store: the one read, with the fields the phone owns written over it. */
export function toStored(entry: ChatEntry): Record<string, unknown> {
    const { message, plan } = entry;
    const row: Record<string, unknown> = {
        ...entry.raw,
        id: message.id,
        role: message.role,
        content: message.content,
        timestamp: message.createdAt ?? entry.raw.timestamp ?? new Date().toISOString(),
    };
    if (plan) {
        const { planId, ...body } = plan.plan;
        row.webpagePlan = { planId, plan: body, status: plan.status };
    }
    if (message.error) row.error = message.error;
    return row;
}

/** A new entry, as the phone writes one. */
export function newEntry(message: ChatMessage): ChatEntry {
    return { message, plan: null, raw: {}, hidden: false };
}

/**
 * What the model is told came before. The server reads `history` and never
 * the stored transcript, and keeps only user and assistant turns with text.
 */
export function historyOf(entries: readonly ChatEntry[]): { role: 'user' | 'assistant'; content: string }[] {
    const out: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const { message } of entries) {
        if ((message.role === 'user' || message.role === 'assistant') && message.content.trim()) {
            out.push({ role: message.role, content: message.content });
        }
    }
    return out;
}

/** The streaming placeholder, settled with what the turn produced. */
export function settleEntry(entry: ChatEntry, turn: WebpageTurn): ChatEntry {
    if (!entry.message.streaming) return entry;
    const interrupted = !turn.error && !turn.text && !turn.plan;
    return {
        ...entry,
        plan: turn.plan ? { plan: turn.plan, status: 'pending' } : entry.plan,
        message: {
            ...entry.message,
            streaming: false,
            content: turn.text || entry.message.content,
            tools: turn.tools,
            sources: turn.sources,
            error: turn.error ?? undefined,
            interrupted: interrupted ? true : undefined,
        },
    };
}

export function setPlanStatus(entries: readonly ChatEntry[], planId: string, status: PlanStatus): ChatEntry[] {
    return entries.map((e) => (e.plan?.plan.planId === planId ? { ...e, plan: { ...e.plan, status } } : e));
}

/** After an approved plan's build turn: every approved plan is now built. */
export function markExecuted(entries: readonly ChatEntry[]): ChatEntry[] {
    return entries.map((e) => (e.plan?.status === 'approved' ? { ...e, plan: { ...e.plan, status: 'executed' } } : e));
}

/** The plan waiting for an answer: the latest answer's, while it is pending. */
export function pendingPlan(entries: readonly ChatEntry[]): WebpagePlan | null {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i] as ChatEntry;
        if (entry.message.role !== 'assistant') continue;
        return entry.plan?.status === 'pending' ? entry.plan.plan : null;
    }
    return null;
}

/** The transcript to draw, newest first (the list is inverted). */
export function visibleMessages(entries: readonly ChatEntry[]): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i] as ChatEntry;
        if (!entry.hidden) out.push(entry.message);
    }
    return out;
}
