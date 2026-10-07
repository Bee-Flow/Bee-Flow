/**
 * Chat signals, the one module that knows its wire calls (port of the web's
 * data/useChatMonitoring.ts):
 *   GET    /api/compliance/chat-monitoring            configuration, resolver view, catalogue (no-store)
 *   PUT    /api/compliance/chat-monitoring            a full replacement (422 lists missing codes)
 *   GET    /api/compliance/chat-monitoring/summary    suppressed figures; EVERY read is in the access log
 *   DELETE /api/compliance/chat-monitoring/counts     delete the collected counts
 *   POST   /api/compliance/dpia/chat_monitoring       record the org-wide DPIA as an attestation
 *   GET    /api/compliance/ropa                       only the chat-signals activity
 */
import { api, ApiError } from '@/core/api/client';

import {
    readChatSignalsConfig,
    readChatSignalsRopa,
    readChatSignalsSummary,
    readDeletedCount,
    readMissingCodes,
    type ChatSignalsConfig,
    type ChatSignalsRopa,
    type ChatSignalsSummary,
} from './chatSignalsReaders';
import type { PutBody, RiskLevel } from '../model/chatSignals/form';
import { COMPLIANCE } from '../model/paths';

const BASE = `${COMPLIANCE}/chat-monitoring`;
const NO_STORE = { 'Cache-Control': 'no-store' };

export const chatSignalsKeys = {
    all: ['compliance', 'chat-signals'] as const,
    config: () => ['compliance', 'chat-signals', 'config'] as const,
    summary: (days: 30 | 90) => ['compliance', 'chat-signals', 'summary', days] as const,
    activity: () => ['compliance', 'chat-signals', 'ropa'] as const,
};

/** A refused save: the 422's missing codes, and whether only an org admin may widen (403). */
export class ChatSignalsSaveError extends Error {
    readonly status: number | null;
    readonly code: string | null;
    readonly missing: string[];
    readonly forbidden: boolean;

    constructor(cause: ApiError) {
        super(cause.message);
        this.name = 'ChatSignalsSaveError';
        this.status = cause.status ?? null;
        this.code = cause.code ?? null;
        this.missing = cause.status === 422 ? readMissingCodes(cause.body) : [];
        this.forbidden = cause.status === 403 && cause.code === 'chat_monitoring_widen_forbidden';
    }
}

/** The configuration, or null on a 404 (a server without chat signals: the card hides). */
export async function getChatSignalsConfig(signal?: AbortSignal): Promise<ChatSignalsConfig | null> {
    try {
        return readChatSignalsConfig(await api.get<unknown>(BASE, { signal, headers: NO_STORE }));
    } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
    }
}

export async function saveChatSignals(body: PutBody): Promise<ChatSignalsConfig> {
    try {
        return readChatSignalsConfig(await api.put<unknown>(BASE, body));
    } catch (err) {
        if (err instanceof ApiError && (err.status === 422 || err.status === 403)) throw new ChatSignalsSaveError(err);
        throw err;
    }
}

/** Writes an access-audit row on the server: call only after the person asked to see the figures. */
export async function getChatSignalsSummary(days: 30 | 90, signal?: AbortSignal): Promise<ChatSignalsSummary> {
    return readChatSignalsSummary(await api.get<unknown>(`${BASE}/summary`, { signal, query: { days }, headers: NO_STORE }));
}

export async function deleteChatSignalCounts(): Promise<number> {
    return readDeletedCount(await api.delete<unknown>(`${BASE}/counts`));
}

export interface ChatSignalsDpiaInput {
    risk_level: RiskLevel;
    expires_at: string | null;
    mitigations: string[];
}

export async function recordChatSignalsDpia(input: ChatSignalsDpiaInput): Promise<void> {
    await api.post<unknown>(`${COMPLIANCE}/dpia/chat_monitoring`, {
        mode: 'attestation',
        risk_level: input.risk_level,
        expires_at: input.expires_at,
        mitigations: input.mitigations,
    });
}

export async function getChatSignalsActivity(signal?: AbortSignal): Promise<ChatSignalsRopa> {
    return readChatSignalsRopa(await api.get<unknown>(`${COMPLIANCE}/ropa`, { signal }));
}
