/**
 * What the builder may offer this caller (routes/automation/catalog.js).
 *
 * The catalog is computed per request from the caller's grants, and every list
 * in it is pre-filtered by the same authority the runtime uses — the editor
 * never has to ask "may I" about anything it shows. A table, knowledge base or
 * agent list that failed server-side arrives EMPTY (with `agentsError` for the
 * agents), so a failed read is still a renderable catalog.
 */

import { api } from '@/core/api/client';

import { readCatalog, readPickSources } from './catalogReader';
import type { CatalogPickSource, FlowCatalog } from './catalogTypes';
import { readAgentPreview } from './templateReaders';
import type { AgentPreview, AgentPreviewQuery } from './types';
import { columnsPath, readColumnsAnswer, type EditorColumn } from '../formState/tablesRowValues';

export async function getCatalog(signal?: AbortSignal): Promise<FlowCatalog> {
    return readCatalog(await api.get<unknown>('/api/automation/catalog', { signal }));
}

/**
 * Only the `app_pick` sources, for the form editor reached from Studio →
 * Forms, which has no catalog of its own and should not pay for one.
 */
export async function getFormPickSources(signal?: AbortSignal): Promise<CatalogPickSource[]> {
    return readPickSources(await api.get<unknown>('/api/automation/catalog/form-pick-sources', { signal }));
}

/**
 * The columns of one Nextcloud table, for the Tables row editor. `tableId` is
 * an id or a title (the tool resolves a unique title). A 502 means Nextcloud
 * did not answer; the editor falls back to the raw values field.
 */
export async function getTableColumns(tableId: string | number, signal?: AbortSignal): Promise<EditorColumn[]> {
    return readColumnsAnswer(await api.get<unknown>(columnsPath(tableId), { signal }));
}

/**
 * The query string the capsule endpoint reads. `tools` keeps its two states
 * apart on the wire: absent = the author set no allow-list, `tools=` = the
 * author set an EMPTY one (the step then gets no tools at all).
 */
export function agentPreviewQuery(query: AgentPreviewQuery): Record<string, string | undefined> {
    const flag = (v: boolean | undefined) => (v === undefined ? undefined : v ? '1' : '0');
    return {
        startAutomations: flag(query.startAutomations),
        useKnowledge: flag(query.useKnowledge),
        useTools: flag(query.useTools),
        tools: query.tools ? query.tools.join(',') : undefined,
    };
}

/** What this agent would actually bring to the ai_step, and what the run holds back. */
export async function getAgentPreview(agentId: string, query: AgentPreviewQuery, signal?: AbortSignal): Promise<AgentPreview> {
    const res = await api.get<unknown>(`/api/automation/catalog/agent/${encodeURIComponent(agentId)}`, {
        signal,
        query: agentPreviewQuery(query),
    });
    return readAgentPreview(res);
}
