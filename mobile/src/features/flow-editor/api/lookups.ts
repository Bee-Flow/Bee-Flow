/**
 * The lists a step editor picks from that the catalog does not carry:
 *
 *   - the knowledge bases an AI step may ground in (GET /api/kb?context=ai_step,
 *     K5: only the bases their owner made available to routines, plus any that
 *     never said — missing means everywhere);
 *   - the approver directory (GET /api/automation/approvals/directory,
 *     member-readable: picking an approver is an authoring act);
 *   - a routine's people and groups (GET /api/automation/:id/principals), the
 *     notification recipients' picker: scoped to the routine and readable by
 *     anyone who may see it, where the approver directory sits behind the
 *     approvals licence;
 *   - the HTTP credentials a request step may use, own and lent
 *     (GET /api/integrations/connections?provider=http&includeShared=1) —
 *     names and kinds only, the secret never leaves the vault.
 */

import { api } from '@/core/api/client';
import { field, pick, shapeOf } from '@/core/api/contract';

import { flowPath } from './definition';

export interface NamedRow {
    id: string;
    name: string;
}

export interface ApprovalDirectory {
    members: NamedRow[];
    groups: NamedRow[];
}

export interface HttpConnection {
    id: string;
    label: string;
    kind: string;
    /** 'own' | 'lent' — a credential lent to this caller says so. */
    access: string;
}

const readKb = shapeOf({ id: field.str(''), name: field.str('') });
const readNamed = shapeOf({ id: field.str(''), name: field.str('') });
const readConnection = shapeOf({ id: field.str(''), label: field.str(''), kind: field.str(''), access: field.str('own') });

/** The bare list, or `{ knowledge_bases }` / `{ kbs }` from an older server. */
export function readKnowledgeBaseList(raw: unknown): NamedRow[] {
    const list = Array.isArray(raw) ? raw : (pick(raw, 'knowledge_bases') ?? pick(raw, 'kbs'));
    return field.list(readKb)(list).filter((kb) => kb.id !== '').map((kb) => ({ id: kb.id, name: kb.name || kb.id }));
}

export function readApprovalDirectory(raw: unknown): ApprovalDirectory {
    const rows = (key: string) => field.list(readNamed)(pick(raw, key)).filter((r) => r.id !== '');
    return { members: rows('members'), groups: rows('groups') };
}

export function readHttpConnections(raw: unknown): HttpConnection[] {
    return field.list(readConnection)(pick(raw, 'connections')).filter((c) => c.id !== '');
}

export async function getAiStepKnowledgeBases(signal?: AbortSignal): Promise<NamedRow[]> {
    return readKnowledgeBaseList(await api.get<unknown>('/api/kb', { signal, query: { context: 'ai_step' } }));
}

export async function getApprovalDirectory(signal?: AbortSignal): Promise<ApprovalDirectory> {
    return readApprovalDirectory(await api.get<unknown>('/api/automation/approvals/directory', { signal }));
}

/** The routine's people (`users`) and groups, read into the directory shape the pickers share. */
export function readPrincipals(raw: unknown): ApprovalDirectory {
    const rows = (key: string) => field.list(readNamed)(pick(raw, key)).filter((r) => r.id !== '');
    return { members: rows('users'), groups: rows('groups') };
}

export async function getPrincipals(id: string, signal?: AbortSignal): Promise<ApprovalDirectory> {
    return readPrincipals(await api.get<unknown>(`${flowPath(id)}/principals`, { signal }));
}

export async function listHttpConnections(signal?: AbortSignal): Promise<HttpConnection[]> {
    return readHttpConnections(await api.get<unknown>('/api/integrations/connections', { signal, query: { provider: 'http', includeShared: '1' } }));
}

/** Their React Query keys: the caller's, not a routine's — under the 'automate' prefix the tab has always used. */
export const lookupKeys = {
    aiStepKnowledgeBases: ['automate', 'flow-lookups', 'kb', 'ai_step'] as const,
    approvalDirectory: ['automate', 'flow-lookups', 'approval-directory'] as const,
    httpConnections: ['automate', 'flow-lookups', 'http-connections'] as const,
    principals: (id: string) => ['automate', 'flow-lookups', 'principals', id] as const,
};
