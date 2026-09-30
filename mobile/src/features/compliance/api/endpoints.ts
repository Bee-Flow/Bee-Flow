/**
 * Every server call the Compliance Center makes, each answer read through a
 * contract reader.
 *
 * Mounts (server/index.js): /api/compliance behind requireModule('compliance')
 * + requireCapability('compliance_hub_gdpr'), /api/dsr behind
 * requireModule('compliance'); every admin route behind admin_compliance.
 * Verified against server/routes/compliance/*.js and routes/dsr.js — the
 * registers' own calls are the WriteRequests their registry entries build
 * (model/records*.ts), sent through `sendWrite`.
 */

import { api } from '@/core/api/client';
import { shareServerFile } from '@/core/api/shareFile';

import {
    readAttention,
    readCheckHistory,
    readChecks,
    readCounts,
    readDeadlines,
    readEvidence,
    readFrameworks,
    readOrgUsers,
    readRunResult,
} from './readers';
import { readAccessAudit, readAuditActions, readConnections, readPortability, readRopa, readSettings } from './readersPages';
import { COMPLIANCE, seg } from '../model/paths';
import type { Choice, Download, Rec, RecordSet, RecordType, WriteRequest } from '../model/types';

const get = (path: string, signal?: AbortSignal, query?: Record<string, string | number | undefined>) =>
    api.get<unknown>(path, { signal, query });

export const getCounts = async (signal?: AbortSignal) => readCounts(await get(`${COMPLIANCE}/counts`, signal));
export const getAttention = async (signal?: AbortSignal) => readAttention(await get(`${COMPLIANCE}/attention`, signal, { limit: 5 }));
export const getDeadlines = async (signal?: AbortSignal) => readDeadlines(await get(`${COMPLIANCE}/deadlines`, signal));
export const getFrameworks = async (signal?: AbortSignal) => readFrameworks(await get(`${COMPLIANCE}/frameworks`, signal));
export const getOrgUsers = async (signal?: AbortSignal) => readOrgUsers(await get(`${COMPLIANCE}/org-users`, signal));

/** GET /checks[?framework=<id>] — every check of the org's active frameworks. */
export async function getChecks(framework: string | null, signal?: AbortSignal) {
    return readChecks(await get(`${COMPLIANCE}/checks`, signal, framework ? { framework } : undefined));
}

export const getCheckHistory = async (checkId: string, signal?: AbortSignal) =>
    readCheckHistory(await get(`${COMPLIANCE}/checks/${seg(checkId)}/history`, signal));
export const getCheckEvidence = async (checkId: string, signal?: AbortSignal) =>
    readEvidence(await get(`${COMPLIANCE}/evidence/${seg(checkId)}`, signal));

/** POST /checks/run — runs every check; answers `{ ran, score: { score }, scores }`. */
export async function runAllChecks() {
    return readRunResult(await api.post<unknown>(`${COMPLIANCE}/checks/run`));
}

export async function rerunCheck(checkId: string): Promise<void> {
    await api.post(`${COMPLIANCE}/checks/${seg(checkId)}/run`);
}

export async function autoFixCheck(checkId: string): Promise<void> {
    await api.post(`${COMPLIANCE}/checks/${seg(checkId)}/auto-fix`, {});
}

/** POST /frameworks/:id/enable | disable — NoBody (`.strict()`), so `{}`. */
export async function setFrameworkEnabled(id: string, enabled: boolean): Promise<void> {
    await api.post(`${COMPLIANCE}/frameworks/${seg(id)}/${enabled ? 'enable' : 'disable'}`, {});
}

/** POST /frameworks/:id/relevance — `{ relevance }`, one of relevant | not_relevant | unknown. */
export async function setFrameworkRelevance(id: string, relevance: string): Promise<void> {
    await api.post(`${COMPLIANCE}/frameworks/${seg(id)}/relevance`, { relevance });
}

export const getSettings = async (signal?: AbortSignal) => readSettings(await get(`${COMPLIANCE}/settings`, signal));

/** PUT /settings — a patch the server sanitises and merges (complianceStore.sanitizeSettingsPatch). */
export async function saveSettings(patch: Record<string, unknown>): Promise<void> {
    await api.put(`${COMPLIANCE}/settings`, patch);
}

/** POST /settings/onboarded — saves the patch and stamps the setup as finished. */
export async function finishSetup(patch: Record<string, unknown>): Promise<void> {
    await api.post(`${COMPLIANCE}/settings/onboarded`, patch);
}

export const getRopa = async (signal?: AbortSignal) => readRopa(await get(`${COMPLIANCE}/ropa`, signal));

export async function reviewRopa(): Promise<void> {
    await api.post(`${COMPLIANCE}/ropa/review`, {});
}

/** POST /settings/scc — `{ operator, confirmed }`, the per-operator SCC attestation. */
export async function setScc(operator: string, confirmed: boolean): Promise<void> {
    await api.post(`${COMPLIANCE}/settings/scc`, { operator, confirmed });
}

export const getPortability = async (signal?: AbortSignal) => readPortability(await get(`${COMPLIANCE}/portability`, signal));

export interface AuditFilter {
    action?: string;
}

/** GET /access-audit — server-side filter and paging (the export uses the same query). */
export async function getAccessAudit(filter: AuditFilter, offset: number, signal?: AbortSignal) {
    return readAccessAudit(await get(`${COMPLIANCE}/access-audit`, signal, { action: filter.action, offset, limit: 50 }));
}

export async function getAccessAuditActions(signal?: AbortSignal): Promise<string[]> {
    return readAuditActions(await get(`${COMPLIANCE}/access-audit/actions`, signal));
}

/** The query string the access-log export is built from — exactly what the screen shows. */
export function accessAuditExportPath(filter: AuditFilter): string {
    return `${COMPLIANCE}/access-audit/export${filter.action ? `?action=${encodeURIComponent(filter.action)}` : ''}`;
}

/** A register's rows: every path it reads, handed to its registry select. */
export async function fetchRecords(type: RecordType, signal?: AbortSignal): Promise<RecordSet> {
    const payloads = await Promise.all(type.list.paths.map((path) => api.get<unknown>(path, { signal })));
    return type.list.select(payloads);
}

/** The richer read of one record, when its register has one. */
export async function fetchRecordDetail(type: RecordType, id: string, signal?: AbortSignal): Promise<Rec | null> {
    if (!type.detail) return null;
    return type.detail.select(await api.get<unknown>(type.detail.path(id), { signal }));
}

/** A history or attestation list, read raw for the registry's own select. */
export async function fetchRaw(path: string, signal?: AbortSignal): Promise<unknown> {
    return api.get<unknown>(path, { signal });
}

/** Options a server lists for one field (the vault connections of a connector). */
export async function fetchChoices(path: string, signal?: AbortSignal): Promise<Choice[]> {
    return readConnections(await api.get<unknown>(path, { signal })).map((c) => ({ value: c.id, label: c.label ?? c.id }));
}

/** Send one register write. Writes never retry (a timed-out write may have landed). */
export async function sendWrite(request: WriteRequest): Promise<unknown> {
    switch (request.method) {
        case 'POST':
            return api.post<unknown>(request.path, request.body);
        case 'PUT':
            return api.put<unknown>(request.path, request.body);
        case 'PATCH':
            return api.patch<unknown>(request.path, request.body);
        default:
            return api.delete<unknown>(request.path);
    }
}

/** Download a report or dossier and hand it to the share sheet. */
export async function shareDownload(download: Download): Promise<void> {
    await shareServerFile(download.path, download.fileName, download.mimeType);
}
