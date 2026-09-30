/**
 * The agent editor's calls — the same routes the web's agent builder uses
 * (agent-hub/src/components/agents/AgentWizard):
 *
 *   GET   /agents/:id?draft=1              the concept, with persona and publish state
 *   POST  /agents                          create (manage_agents)
 *   PUT   /agents/:id                      save the concept; 409 on a stale baseVersion
 *   PATCH /agents/:id/publish              WHO may use it (is_published + shared_groups)
 *   POST  /agents/:id/publish-version      WHAT runs: copy the concept live
 *   POST  /agents/wizard/refine            the AI proposal (manage_agents)
 *   POST  /versions/:id/pre-refine         the undo point, taken before a refine lands
 *   POST  /versions/:id/:versionId/restore undo
 *
 * None of the writes retry: a save that timed out may have landed, and a
 * second refine is a second LLM call on the org's bill.
 */

import { api } from '@/core/api/client';
import { nullable } from '@/core/api/contract';

import {
    readAgentDetail,
    readPublishedVersion,
    readRefineAnswer,
    readVersionRef,
    type RefineAnswer,
} from './editorReaders';
import type { AgentDetail, createPayload, savePayload } from '../model/draft';
import type { buildRefineContext } from '../model/refineMerge';

const agentPath = (id: string) => `/agents/${encodeURIComponent(id)}`;
const NO_RETRY = { retry: false } as const;

/** 404 for an agent out of reach — the same answer as "no such agent". */
export async function getAgentDraft(id: string, signal?: AbortSignal): Promise<AgentDetail | null> {
    return nullable(readAgentDetail)(await api.get<unknown>(agentPath(id), { signal, query: { draft: '1' } }));
}

export async function createAgent(body: ReturnType<typeof createPayload>): Promise<AgentDetail> {
    return readAgentDetail(await api.post<unknown>('/agents', body, NO_RETRY));
}

export async function updateAgent(id: string, body: ReturnType<typeof savePayload>): Promise<AgentDetail> {
    return readAgentDetail(await api.put<unknown>(agentPath(id), body, NO_RETRY));
}

/** `sharedGroups: []` with `isPublished` is the whole organisation. */
export async function setAgentAudience(id: string, body: { isPublished: boolean; sharedGroups: string[] }): Promise<void> {
    await api.patch(`${agentPath(id)}/publish`, body, NO_RETRY);
}

/** The body is refused, so none is sent: the server publishes the concept as it is now. */
export async function publishAgentVersion(id: string): Promise<{ publishedVersion?: number }> {
    return readPublishedVersion(await api.post<unknown>(`${agentPath(id)}/publish-version`, undefined, NO_RETRY));
}

export interface RefineRequest extends ReturnType<typeof buildRefineContext> {
    /** The conversation's first message: what the agent is for. */
    prompt: string;
    refinement: string;
    modelTier: string;
    locale?: string;
}

/** An LLM call: a longer deadline than a plain write. */
export async function refineAgent(body: RefineRequest): Promise<RefineAnswer> {
    return readRefineAnswer(await api.post<unknown>('/agents/wizard/refine', body, { retry: false, timeoutMs: 120_000 }));
}

/**
 * The undo point. A failure is an answer, not an error: the refine goes ahead
 * (the person asked for it) and its Done card says nothing can be undone.
 */
export async function snapshotBeforeRefine(id: string): Promise<string | null> {
    try {
        const { id: versionId } = readVersionRef(await api.post<unknown>(`/versions/${encodeURIComponent(id)}/pre-refine`, undefined, NO_RETRY));
        return versionId || null;
    } catch {
        return null;
    }
}

export async function restoreAgentVersion(id: string, versionId: string): Promise<void> {
    await api.post(`/versions/${encodeURIComponent(id)}/${encodeURIComponent(versionId)}/restore`, undefined, NO_RETRY);
}
