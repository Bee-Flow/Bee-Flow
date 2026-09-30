/**
 * Sources of a knowledge base (server/routes/knowledgeBases/sources.js) and
 * the two connector ingests that are not sources yet: a sitemap
 * (sitemapIngest.js) and an n8n workflow (n8n.js).
 *
 * The route refuses what it cannot do with a code the sheet turns into words:
 * `kind_not_available` (a kind whose track has not landed — a Nextcloud
 * folder is one), `source_limit_reached` (the plan's max_kb_sources, with the
 * `limit`), `url_rejected`, `text_too_long`. A refresh answers 202 and the
 * work happens on the server's schedule, so the list is re-read, not trusted.
 */

import { api } from '@/core/api/client';
import { asCount, pick } from '@/core/api/contract';

import { readKbDocumentsPage } from './readers';
import { readCreatedSource, readSources, readWorkflows } from './sourceReaders';
import { SOURCE_DOC_PAGE, sourceDocParams, type SourceDocFilter } from '../model/sourceDocuments';
import type { IngestibleWorkflow, KbDocumentsResponse, KbSource, KbSourceTotals, RefreshRule } from '../model/types';

const kbPath = (id: string) => `/api/kb/${encodeURIComponent(id)}`;
const sourcePath = (kbId: string, sid: string) => `${kbPath(kbId)}/sources/${encodeURIComponent(sid)}`;

export async function listKbSources(kbId: string, signal?: AbortSignal): Promise<{ sources: KbSource[]; totals: KbSourceTotals }> {
    return readSources(await api.get<unknown>(`${kbPath(kbId)}/sources`, { signal }));
}

/** A web page (optionally the whole site, up to `maxPages`) or pasted text, with an optional refresh rule. */
export interface NewSource {
    kind: 'webpage' | 'text';
    name?: string;
    config: Record<string, unknown>;
    refresh?: RefreshRule;
}

export async function createKbSource(kbId: string, source: NewSource): Promise<KbSource | null> {
    return readCreatedSource(await api.post<unknown>(`${kbPath(kbId)}/sources`, source, { retry: false }));
}

export async function updateKbSource(kbId: string, sid: string, patch: { name?: string; refresh?: RefreshRule }): Promise<void> {
    await api.patch(sourcePath(kbId, sid), patch);
}

export async function deleteKbSource(kbId: string, sid: string): Promise<void> {
    await api.delete(sourcePath(kbId, sid));
}

/** 202 `{ queued: true }` — sets the next refresh to now; the server does the work. */
export async function refreshKbSource(kbId: string, sid: string): Promise<void> {
    await api.post(`${sourcePath(kbId, sid)}/refresh`, undefined, { retry: false });
}

/**
 * One page of a source's documents (GET /:id/sources/:sid/documents): the
 * same projected rows as the base-wide list — never a document's body —
 * filtered by status / personal data / title.
 */
export async function listSourceDocuments(
    kbId: string,
    sid: string,
    opts: { filter: SourceDocFilter; q: string; offset: number },
    signal?: AbortSignal,
): Promise<KbDocumentsResponse> {
    const query = { ...sourceDocParams(opts.filter, opts.q), limit: SOURCE_DOC_PAGE, offset: opts.offset };
    return readKbDocumentsPage(await api.get<unknown>(`${sourcePath(kbId, sid)}/documents`, { signal, query }));
}

export interface SitemapResult {
    ingested: number;
    skipped: number;
    errors: number;
    totalPages: number;
    maxPagesCapped: boolean;
}

/** Walks a sitemap synchronously on the server — a long request, never retried. */
export async function ingestKbSitemap(kbId: string, url: string, maxPages: number): Promise<SitemapResult> {
    const res = await api.post<unknown>(`${kbPath(kbId)}/ingest/sitemap`, { url, maxPages }, { retry: false, timeoutMs: 300_000 });
    const num = (key: string) => asCount(pick(res, key)) ?? 0;
    return {
        ingested: num('ingested'),
        skipped: num('skipped'),
        errors: num('errors'),
        totalPages: num('totalPages'),
        maxPagesCapped: pick(res, 'maxPagesCapped') === true,
    };
}

/** The org's n8n workflows an administrator allowed into knowledge bases. `[]` without an org. */
export async function listIngestibleWorkflows(signal?: AbortSignal): Promise<IngestibleWorkflow[]> {
    return readWorkflows(await api.get<unknown>('/api/kb/n8n/ingestible', { signal }));
}

/** `data` runs the workflow and keeps its output; `definition` keeps the workflow itself as Markdown. */
export async function ingestKbWorkflow(kbId: string, workflowId: string, mode: 'data' | 'definition'): Promise<number> {
    const res = await api.post<unknown>(`${kbPath(kbId)}/ingest/n8n`, { workflowId, mode }, { retry: false, timeoutMs: 120_000 });
    return asCount(pick(res, 'chunks')) ?? 0;
}
