/**
 * The Studio routes of a knowledge base: what each call sends, and how each
 * answer is read — sources with their counters, audience on its own route,
 * the bulk delete that keeps what a failed batch did not delete, and the
 * readers that keep "not said" apart from "none".
 */

import { api } from '@/core/api/client';

import { toAskEvent } from './askEndpoint';
import {
    bulkDeleteKbDocuments,
    duplicateKnowledgeBase,
    listKbCategories,
    listKbFavorites,
    listSystemKnowledgeBases,
    MAX_BULK_DELETE,
    publishKnowledgeBase,
    reindexKnowledgeBase,
    setKbFavorite,
    updateKnowledgeBase,
} from './manageEndpoints';
import { readKnowledgeBase } from './readers';
import { createKbSource, ingestKbSitemap, ingestKbWorkflow, listIngestibleWorkflows, listKbSources, listSourceDocuments, refreshKbSource, updateKbSource } from './sourceEndpoints';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const patch = api.patch as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('sources', () => {
    it('reads the sources with their counters and flattens the creator', async () => {
        get.mockResolvedValue({
            sources: [{ id: 's1', kind: 'upload', name: 'Files', documentCount: 3, supportsModes: [], createdBy: { id: 'u', name: 'Ann' } }, { kind: 'x' }],
            totals: { sourceCount: 1 },
        });
        const { sources, totals } = await listKbSources('kb 1');
        expect(get).toHaveBeenCalledWith('/api/kb/kb%201/sources', { signal: undefined });
        expect(sources).toHaveLength(1);
        expect(sources[0]).toMatchObject({ id: 's1', documentCount: 3, supportsModes: ['manual'], refreshMode: 'manual', createdByName: 'Ann' });
        expect(totals).toEqual({ sourceCount: 1, autoRefreshCount: 0, errorSourceCount: 0, documentCount: 0 });
    });

    it('creates, refreshes and reschedules without retrying', async () => {
        post.mockResolvedValueOnce({ source: { id: 'n1', kind: 'webpage' } });
        const created = await createKbSource('kb1', { kind: 'webpage', config: { url: 'https://x' }, refresh: { mode: 'manual' } });
        expect(created?.id).toBe('n1');
        expect(post).toHaveBeenLastCalledWith('/api/kb/kb1/sources', { kind: 'webpage', config: { url: 'https://x' }, refresh: { mode: 'manual' } }, { retry: false });
        await refreshKbSource('kb1', 's1');
        expect(post).toHaveBeenLastCalledWith('/api/kb/kb1/sources/s1/refresh', undefined, { retry: false });
        await updateKbSource('kb1', 's1', { refresh: { mode: 'schedule', cron: '0 6 * * *', tz: 'UTC' } });
        expect(patch).toHaveBeenLastCalledWith('/api/kb/kb1/sources/s1', { refresh: { mode: 'schedule', cron: '0 6 * * *', tz: 'UTC' } });
    });

    it('pages one source’s documents with the chip’s filter and reads their status', async () => {
        get.mockResolvedValueOnce({
            documents: [{ id: 'd1', title: 'a.pdf', status: 'skipped', status_reason: 'Queued for processing', pii_status: 'unscanned' }],
            total: 60,
            limit: 50,
            offset: 50,
        });
        const page = await listSourceDocuments('kb1', 's 1', { filter: 'skipped', q: ' a ', offset: 50 });
        expect(get).toHaveBeenLastCalledWith('/api/kb/kb1/sources/s%201/documents', {
            signal: undefined,
            query: { status: 'skipped,error', q: 'a', limit: 50, offset: 50 },
        });
        expect(page.total).toBe(60);
        expect(page.documents[0]).toMatchObject({ status: 'skipped', status_reason: 'Queued for processing', pii_status: 'unscanned' });
    });

    it('reports a sitemap walk and an n8n ingest', async () => {
        post.mockResolvedValueOnce({ ingested: 4, skipped: '1', errors: 0, totalPages: 9, maxPagesCapped: true });
        expect(await ingestKbSitemap('kb1', 'https://x/sitemap.xml', 50)).toEqual({ ingested: 4, skipped: 1, errors: 0, totalPages: 9, maxPagesCapped: true });
        post.mockResolvedValueOnce({ chunks: 12 });
        expect(await ingestKbWorkflow('kb1', 'wf1', 'definition')).toBe(12);
        expect(post).toHaveBeenLastCalledWith('/api/kb/kb1/ingest/n8n', { workflowId: 'wf1', mode: 'definition' }, { retry: false, timeoutMs: 120_000 });
        get.mockResolvedValueOnce([{ id: 'wf1', name: 'Leads' }, { name: 'no id' }]);
        expect(await listIngestibleWorkflows()).toEqual([{ id: 'wf1', name: 'Leads' }]);
    });
});

describe('managing the base', () => {
    it('saves settings and audience on their own routes', async () => {
        await updateKnowledgeBase('kb1', { usageContexts: ['agent'] });
        expect(patch).toHaveBeenLastCalledWith('/api/kb/kb1', { usageContexts: ['agent'] });
        await publishKnowledgeBase('kb1', { isPublished: true, sharedGroups: ['g1'] });
        expect(patch).toHaveBeenLastCalledWith('/api/kb/kb1/publish', { isPublished: true, sharedGroups: ['g1'] });
    });

    it('copies with or without sources, and reads the re-index report', async () => {
        post.mockResolvedValueOnce({ id: 'copy', name: 'Copy of X' });
        expect((await duplicateKnowledgeBase('kb1', true))?.id).toBe('copy');
        expect(post).toHaveBeenLastCalledWith('/api/kb/kb1/duplicate', undefined, { retry: false, query: { withSources: '1' } });
        post.mockResolvedValueOnce({ reindexed: 5, failed: 1, unattached: 2 });
        expect(await reindexKnowledgeBase('kb1')).toEqual({ reindexed: 5, failed: 1, unattached: 2 });
    });

    it('stars and unstars', async () => {
        await setKbFavorite('kb1', true);
        expect(api.put).toHaveBeenCalledWith('/api/kb/kb1/favorite');
        await setKbFavorite('kb1', false);
        expect(api.delete).toHaveBeenCalledWith('/api/kb/kb1/favorite');
        get.mockResolvedValueOnce(['kb1', 3, '']);
        expect(await listKbFavorites()).toEqual(['kb1']);
    });

    it('reads categories and system bases', async () => {
        get.mockResolvedValueOnce([{ id: 'c1', name: 'Sales' }, { name: 'x' }]);
        expect(await listKbCategories()).toEqual([{ id: 'c1', name: 'Sales', icon: null }]);
        get.mockResolvedValueOnce({ items: [{ id: 's', name: 'Wetten', system_slug: 'nl_law', documentCount: '7', enabledForOrg: true }] });
        expect(await listSystemKnowledgeBases()).toEqual([
            expect.objectContaining({ id: 's', slug: 'nl_law', documentCount: 7, enabledForOrg: true, superAdminBypass: false }),
        ]);
    });

    it('deletes in batches and keeps what a failed batch did not delete', async () => {
        const ids = Array.from({ length: MAX_BULK_DELETE + 5 }, (_, i) => `d${i}`);
        post.mockResolvedValueOnce({ deleted: MAX_BULK_DELETE }).mockRejectedValueOnce(new Error('boom'));
        const result = await bulkDeleteKbDocuments('kb1', ids);
        expect(result.deleted).toHaveLength(MAX_BULK_DELETE);
        expect(result.remaining).toEqual(ids.slice(MAX_BULK_DELETE));
        expect(result.error).toBeInstanceOf(Error);
    });
});

describe('readers', () => {
    it('reads shared_groups from JSON text and leaves usage_contexts unsaid when absent', () => {
        const kb = readKnowledgeBase({ id: 'k', shared_groups: '["g1"]', last_content_at: '2026-09-01' });
        expect(kb.shared_groups).toEqual(['g1']);
        expect(kb.usage_contexts).toBeUndefined();
        expect(readKnowledgeBase({ shared_groups: 'not json' }).shared_groups).toBeUndefined();
    });

    it('turns the ask frames into events', () => {
        expect(toAskEvent('kb_sources', { sources: [{ title: 'T', content: 'S' }] })).toMatchObject({ type: 'sources', sources: [{ title: 'T', snippet: 'S' }] });
        expect(toAskEvent('text', { text: 'Hi' })).toEqual({ type: 'text', text: 'Hi' });
        expect(toAskEvent('text', {})).toBeNull();
        expect(toAskEvent('done', {})).toEqual({ type: 'done' });
        expect(toAskEvent('error', { error: 'no' })).toEqual({ type: 'error', message: 'no' });
        expect(toAskEvent('ping', {})).toBeNull();
    });
});
