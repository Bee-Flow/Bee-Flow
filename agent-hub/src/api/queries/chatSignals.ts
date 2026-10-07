// Chat signals in the chat: the ONLY place that knows the wire contracts of
//   GET/PUT /api/privacy/chat-signals/preference   the caller's own "count me" choice
//   GET /agents/:id → complianceCounting            whether this agent's chat is counted for the caller
//   GET /agents/:id/embed → complianceNotice        what the embed tells a website visitor
// (the status itself rides on /api/privacy/shield-status, see shieldStatus.ts).
//
// Every reader is an allow-list: a state from the enum, a 'YYYY-MM-DD' date,
// the exact version timestamp, known signal ids and an https link. Anything
// else reads as off, which shows no notice and sends no marker.
//
// The preference is self-scoped: no id travels in either direction. It is
// per person, so it lives in the React Query cache that logout clears, and
// sessionCaches.ts drops it by name as well.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    CHAT_MONITORING_VERSION_RE,
    httpsUrlOrNull,
    type ChatMonitoringState,
    type ChatSignal,
} from './shieldStatus';
import { API_BASE, authFetch } from '../../utils/helpers';
import { queryClient } from '../queryClient';

export interface ChatSignalsPreference {
    counted: boolean;
}

export interface AgentCountingGate {
    state: ChatMonitoringState;
    from: string | null;
}

export interface EmbedComplianceNotice {
    state: ChatMonitoringState;
    from: string | null;
    version: string | null;
    signals: ChatSignal[];
    privacyNoticeUrl: string | null;
}

export const EMBED_NOTICE_OFF: EmbedComplianceNotice = Object.freeze({
    state: 'off', from: null, version: null, signals: Object.freeze([]) as unknown as ChatSignal[], privacyNoticeUrl: null,
});

const AGENT_GATE_OFF: AgentCountingGate = Object.freeze({ state: 'off', from: null });
const STATES = new Set<string>(['off', 'scheduled', 'on']);
const SIGNALS: readonly ChatSignal[] = ['outcomes', 'kinds'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const chatSignalsKeys = {
    all: ['chat-signals'] as const,
    preference: ['chat-signals', 'preference'] as const,
    agentGate: (agentId: string) => ['chat-signals', 'agent-gate', agentId] as const,
};

const PREFERENCE_URL = () => `${API_BASE}/api/privacy/chat-signals/preference`;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stateOf(value: unknown): ChatMonitoringState {
    return typeof value === 'string' && STATES.has(value) ? value as ChatMonitoringState : 'off';
}

function dayOf(value: unknown): string | null {
    return typeof value === 'string' && DAY_RE.test(value) ? value : null;
}

/** `GET /agents/:id` → only `complianceCounting`; the rest of the agent is not this module's business. */
export function parseAgentGate(body: unknown): AgentCountingGate {
    const gate = asRecord(asRecord(body)?.complianceCounting);
    if (!gate) return AGENT_GATE_OFF;
    const state = stateOf(gate.state);
    return state === 'off' ? AGENT_GATE_OFF : { state, from: dayOf(gate.from) };
}

/**
 * `GET /agents/:id/embed` → `complianceNotice`. A state without a version is
 * off: the embed could show the notice but not send a matching marker.
 */
export function parseComplianceNotice(body: unknown): EmbedComplianceNotice {
    const raw = asRecord(asRecord(body)?.complianceNotice);
    if (!raw) return EMBED_NOTICE_OFF;
    const state = stateOf(raw.state);
    const version = typeof raw.version === 'string' && CHAT_MONITORING_VERSION_RE.test(raw.version) ? raw.version : null;
    if (state === 'off' || !version) return EMBED_NOTICE_OFF;
    const given = new Set(Array.isArray(raw.signals) ? raw.signals : []);
    return {
        state,
        from: dayOf(raw.from),
        version,
        signals: SIGNALS.filter((s) => given.has(s)),
        privacyNoticeUrl: httpsUrlOrNull(raw.privacyNoticeUrl),
    };
}

/** The visitor's marker for this notice, or null when the embed announces nothing. */
export function embedMarker(notice: EmbedComplianceNotice): string | null {
    return notice.state !== 'off' && notice.version ? `agent_public@${notice.version}` : null;
}

async function readJson(url: string, init?: RequestInit): Promise<unknown> {
    const res = await authFetch(url, init);
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
}

function parsePreference(body: unknown): ChatSignalsPreference {
    // Only an explicit `false` is an objection; junk reads as counted, and
    // the server applies the stored choice to every turn whatever this says.
    return { counted: asRecord(body)?.counted !== false };
}

export function useChatSignalsPreference({ enabled }: { enabled: boolean }) {
    return useQuery<ChatSignalsPreference>({
        queryKey: chatSignalsKeys.preference,
        queryFn: async ({ signal }) => parsePreference(await readJson(PREFERENCE_URL(), { signal })),
        enabled,
        staleTime: 60_000,
        retry: false,
    });
}

export function useSetChatSignalsPreference() {
    const qc = useQueryClient();
    return useMutation<ChatSignalsPreference, Error, ChatSignalsPreference>({
        mutationFn: async ({ counted }) => parsePreference(await readJson(PREFERENCE_URL(), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ counted: counted === true }),
        })),
        onSuccess: (saved) => {
            qc.setQueryData(chatSignalsKeys.preference, saved);
            void qc.invalidateQueries({ queryKey: chatSignalsKeys.preference });
        },
    });
}

export function useAgentChatSignalsGate(agentId: string | null | undefined, { enabled }: { enabled: boolean }) {
    return useQuery<AgentCountingGate>({
        queryKey: chatSignalsKeys.agentGate(agentId || ''),
        queryFn: async ({ signal }) => parseAgentGate(
            await readJson(`${API_BASE}/agents/${encodeURIComponent(String(agentId))}`, { signal }),
        ),
        enabled: enabled && !!agentId,
        staleTime: 60_000,
        retry: false,
    });
}

/** Drop every chat-signals answer: logout, so the next person never sees the last one's choice. */
export function invalidateChatSignals(): void {
    queryClient.removeQueries({ queryKey: chatSignalsKeys.all });
}
