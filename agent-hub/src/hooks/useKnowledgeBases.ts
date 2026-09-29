// Shared Knowledge Base management hook — consolidates the KB list/CRUD +
// document + ingestion logic that was copy-pasted across three components:
//   - components/KnowledgePanel.jsx            (agent designer knowledge tab)
//   - the since-removed KnowledgeBasesSection (standalone admin)
//   - components/ProjectDetailPage.jsx         (project knowledge tab)
// Each of those reimplemented fetchKBs/createKB/deleteKB/fetchKBDocs/deleteDoc/
// reindexKB against /api/kb plus the ingest handlers (text/URL/sitemap/file/
// n8n/Google-Drive). This hook owns that data layer; each consumer keeps its
// own JSX and consumes these values + handlers (plus the KBIngestPanel /
// CreateKBModal shared panels).
//
// Intentional per-consumer differences are parameterized via options:
//   - listContext:   'agent' → list with ?context=agent (agent picker only).
//   - onKBCreated / onKBDeleted: link/unlink callbacks so the agent + project
//     consumers can sync their knowledgeBaseIds when a KB is added/removed.
//   - deleteKBConfirm / deleteDocConfirm: confirmation copy (admin is stronger).
//   - paginateDocs:  enables the KnowledgePanel doc pager (limit/offset/append)
//     + email filters + bulk select/delete. Simple consumers leave it off and
//     get a plain full-list fetch.
//   - enableDrive / enableAzureInfo: opt-in side-effect fetches (gdrive status,
//     Azure doc-processing flag) so consumers that don't surface them don't
//     make the extra request.
//
// Sources (2026-09, plan K1b/K2): the hook also carries a KB's SOURCES —
// `kbSources`, `kbSourceTotals`, `kbSourcesError`, `fetchKBSources` — loaded
// alongside the documents whenever `selectedKB` changes. The HTTP for them
// comes from KnowledgeStudio/knowledgeApi rather than being written a second
// time here; see the comment at the state below.
//
// Bug fix folded in (was an accidental divergence between the copies):
// ingestDriveFiles surfaces per-file failures everywhere now (logs each failure
// + alerts on partial success) — the admin copy used to silently swallow them.
// The ingest handlers also use the safer guarded `res.json().catch(() => ({}))`
// body parse and report failures inline via kbIngestStatus.

import { useCallback, useEffect, useEffectEvent, useState, type ChangeEvent } from 'react';
import { knowledgeApi } from '../components/admin/Studio/KnowledgeStudio/knowledgeApi';
import { toast } from '../components/shared/Toast';
import useConfirm from '../components/shared/useConfirm';
import { API_BASE, authFetch } from '../utils/helpers';

/** A knowledge base row. Consumers render more of it than this hook reads. */
export interface KnowledgeBase {
    id: string;
    name: string;
    description?: string;
    [key: string]: unknown;
}

export interface KbDocument {
    id: string;
    [key: string]: unknown;
}

/** Where a KB's documents came from, and whether that source refreshes. */
export interface KbSource {
    id: string;
    [key: string]: unknown;
}

export interface KbDocFilters {
    sender: string;
    threadId: string;
    hasAttachment: boolean;
    dateFrom: string;
    dateTo: string;
}

/** One file the Drive picker handed back, already exported to text. */
export interface DriveFile {
    name: string;
    content: string;
}

export interface UseKnowledgeBasesOptions {
    /** 'agent' → list with ?context=agent (the agent picker only). */
    listContext?: string | null;
    autoSelectOnCreate?: boolean;
    /** Link/unlink callbacks so the agent + project consumers can sync their
     *  knowledgeBaseIds when a KB is added or removed. */
    onKBCreated?: (kb: KnowledgeBase) => void;
    onKBDeleted?: (kbId: string) => void;
    deleteKBConfirm?: string;
    deleteDocConfirm?: string;
    paginateDocs?: boolean;
    docsPageSize?: number;
    enableDrive?: boolean;
    enableAzureInfo?: boolean;
}

const EMPTY_FILTERS: KbDocFilters = { sender: '', threadId: '', hasAttachment: false, dateFrom: '', dateTo: '' };

// Mirrors MAX_BULK_DELETE in server/routes/knowledgeBases/documents.js. The
// route refuses a body over this size with a 400 instead of (as it used to)
// silently deleting the first 200 and dropping the rest — so a selection
// bigger than this has to be sent as several requests, never one.
const MAX_BULK_DELETE = 200;

/** What to put on screen for a thrown value that may not be an Error. */
const failureText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function useKnowledgeBases({
    listContext = null,
    autoSelectOnCreate = true,
    onKBCreated,
    onKBDeleted,
    deleteKBConfirm = 'Delete this knowledge base and all its documents?',
    deleteDocConfirm = 'Delete this document?',
    paginateDocs = false,
    docsPageSize = 50,
    enableDrive = false,
    enableAzureInfo = false,
}: UseKnowledgeBasesOptions = {}) {
    const { confirm, confirmDialog } = useConfirm();
    // ── KB list ──────────────────────────────────────────────────────
    const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
    const [loadingKbs, setLoadingKbs] = useState(true);
    const [selectedKB, setSelectedKB] = useState<KnowledgeBase | null>(null);

    // ── Create / edit KB ─────────────────────────────────────────────
    const [showCreateKB, setShowCreateKB] = useState(false);
    const [newKBName, setNewKBName] = useState('');
    const [newKBDesc, setNewKBDesc] = useState('');
    const [creatingKB, setCreatingKB] = useState(false);
    const [editingKB, setEditingKB] = useState<string | null>(null); // KB id being edited
    const [editName, setEditName] = useState('');
    const [editDesc, setEditDesc] = useState('');
    const [savingEdit, setSavingEdit] = useState(false);

    // ── Documents ────────────────────────────────────────────────────
    const [kbDocs, setKbDocs] = useState<KbDocument[]>([]);
    const [kbDocsTotal, setKbDocsTotal] = useState(0);
    const [kbDocsOffset, setKbDocsOffset] = useState(0);
    const [kbSelectedIds, setKbSelectedIds] = useState<Set<string>>(new Set());
    const [kbDocsFilters, setKbDocsFilters] = useState(EMPTY_FILTERS);
    const [kbBulkBusy, setKbBulkBusy] = useState(false);

    // ── Ingestion ────────────────────────────────────────────────────
    const [kbInputMode, setKbInputMode] = useState('text');
    const [kbTextContent, setKbTextContent] = useState('');
    const [kbTextTitle, setKbTextTitle] = useState('');
    const [kbUrlInput, setKbUrlInput] = useState('');
    const [kbIngesting, setKbIngesting] = useState(false);
    const [kbIngestStatus, setKbIngestStatus] = useState('');
    const [sitemapMode, setSitemapMode] = useState(false);
    const [sitemapMaxPages, setSitemapMaxPages] = useState(50);

    // ── Sources (K1b) ────────────────────────────────────────────────
    // Where a knowledge base's documents came FROM, and whether each source
    // keeps itself up to date. Every consumer of this hook shows documents;
    // a source is the thing a person recognises ("the Sales folder"), and a
    // document list with no sources above it cannot answer "why is this
    // here" or "will it update".
    //
    // The transport is `KnowledgeStudio/knowledgeApi` rather than another
    // pair of fetches in this file: this hook already exists BECAUSE the
    // same /api/kb calls were copy-pasted into three components, and adding
    // a fourth copy of the source routes here would be the same mistake one
    // layer down. The direction (hook → a component folder's api module) is
    // safe because that module is a leaf: it imports utils/helpers and
    // nothing else, so there is no cycle to create.
    const [kbSources, setKbSources] = useState<KbSource[]>([]);
    const [kbSourceTotals, setKbSourceTotals] = useState<Record<string, unknown> | null>(null);
    const [kbSourcesError, setKbSourcesError] = useState<string | null>(null);

    const fetchKBSources = useCallback(async (kbId: string | null | undefined): Promise<KbSource[]> => {
        if (!kbId) { setKbSources([]); setKbSourceTotals(null); return []; }
        try {
            const body = await knowledgeApi.listSources(kbId);
            const list = Array.isArray(body?.sources) ? body.sources : [];
            setKbSources(list);
            setKbSourceTotals(body?.totals || null);
            setKbSourcesError(null);
            return list;
        } catch (e) {
            // A sources failure must not empty the DOCUMENT list the caller
            // is also showing — they are different requests and only one of
            // them failed.
            setKbSourcesError(failureText(e) || 'Could not load sources');
            setKbSources([]);
            setKbSourceTotals(null);
            return [];
        }
    }, []);

    // ── Re-index ─────────────────────────────────────────────────────
    const [reindexStatus, setReindexStatus] = useState('');
    const [reindexing, setReindexing] = useState(false);

    // ── n8n / Drive / Azure ──────────────────────────────────────────
    const [n8nWorkflows, setN8nWorkflows] = useState<unknown[]>([]);
    const [n8nIngestMode, setN8nIngestMode] = useState('data'); // 'data' | 'definition'
    const [drivePickerOpen, setDrivePickerOpen] = useState(false);
    const [driveConnected, setDriveConnected] = useState(false);
    const [useAzureKB, setUseAzureKB] = useState(false);

    // ── Effects ──────────────────────────────────────────────────────
    // fetchKBs/fetchKBDocs are plain functions (a new one per render), so the
    // loads hang off Effect Events: once at mount, and once per selected KB.
    const loadList = useEffectEvent(() => { fetchKBs(); });
    useEffect(() => { loadList(); }, []);
    const loadSelected = useEffectEvent((kbId: string | undefined) => {
        if (kbId) {
            fetchKBDocs(kbId, { offset: 0 });
            fetchKBSources(kbId);
        } else {
            setKbDocs([]);
            setKbSources([]);
            setKbSourceTotals(null);
        }
    });
    useEffect(() => { loadSelected(selectedKB?.id); }, [selectedKB?.id]);

    useEffect(() => {
        if (kbInputMode !== 'n8n') return;
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/kb/n8n/ingestible`);
                if (res.ok) setN8nWorkflows(await res.json());
            } catch (e) { console.error('Failed to fetch n8n ingestible:', e); }
        })();
    }, [kbInputMode]);

    useEffect(() => {
        if (!enableDrive) return;
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/integrations/gdrive/status`);
                if (res.ok) { const d = await res.json(); setDriveConnected(!!d.connected); }
            } catch { /* ignore */ }
        })();
    }, [enableDrive]);

    useEffect(() => {
        if (!enableAzureInfo) return;
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/ai/config`);
                if (res.ok) { const d = await res.json(); setUseAzureKB(!!d.useAzureDocProcessing); }
            } catch { /* ignore */ }
        })();
    }, [enableAzureInfo]);

    // ── KB API calls ─────────────────────────────────────────────────
    async function fetchKBs() {
        setLoadingKbs(true);
        try {
            const url = listContext
                ? `${API_BASE}/api/kb?context=${encodeURIComponent(listContext)}`
                : `${API_BASE}/api/kb`;
            const res = await authFetch(url);
            if (res.ok) setKbs(await res.json());
        } catch (e) { console.error('Failed to fetch KBs:', e); }
        finally { setLoadingKbs(false); }
    }

    const openCreateKB = () => setShowCreateKB(v => !v);
    const cancelCreateKB = () => { setShowCreateKB(false); setNewKBName(''); setNewKBDesc(''); };

    async function createKB() {
        if (!newKBName.trim()) return;
        setCreatingKB(true);
        try {
            const res = await authFetch(`${API_BASE}/api/kb`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newKBName, description: newKBDesc }),
            });
            if (res.ok) {
                const kb = await res.json();
                setNewKBName(''); setNewKBDesc(''); setShowCreateKB(false);
                fetchKBs();
                if (autoSelectOnCreate) setSelectedKB(kb);
                onKBCreated?.(kb);
            }
        } catch (e) { console.error('Failed to create KB:', e); }
        finally { setCreatingKB(false); }
    }

    const startEditKB = (kb: KnowledgeBase) => { setEditingKB(kb.id); setEditName(kb.name); setEditDesc(kb.description || ''); };

    async function updateKB() {
        if (!editingKB || !editName.trim()) return;
        setSavingEdit(true);
        try {
            const res = await authFetch(`${API_BASE}/api/kb/${editingKB}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: editName, description: editDesc }),
            });
            if (res.ok) {
                setEditingKB(null);
                fetchKBs();
                if (selectedKB?.id === editingKB) {
                    setSelectedKB(prev => (prev ? { ...prev, name: editName, description: editDesc } : prev));
                }
            }
        } catch (e) { console.error('Failed to update KB:', e); }
        finally { setSavingEdit(false); }
    }

    async function deleteKB(kbId: string) {
        if (!(await confirm({ title: deleteKBConfirm, confirmLabel: 'Delete', destructive: true }))) return;
        try {
            await authFetch(`${API_BASE}/api/kb/${kbId}`, { method: 'DELETE' });
            if (selectedKB?.id === kbId) { setSelectedKB(null); setKbDocs([]); }
            fetchKBs();
            onKBDeleted?.(kbId);
        } catch (e) { console.error('Failed to delete KB:', e); }
    }

    async function fetchKBDocs(
        kbId: string,
        { append = false, offset = 0, filters = kbDocsFilters }: { append?: boolean; offset?: number; filters?: KbDocFilters } = {},
    ) {
        try {
            let url = `${API_BASE}/api/kb/${kbId}/documents`;
            if (paginateDocs) {
                const params = new URLSearchParams();
                params.set('limit', String(docsPageSize));
                params.set('offset', String(offset));
                if (filters.sender) params.set('sender', filters.sender);
                if (filters.threadId) params.set('threadId', filters.threadId);
                if (filters.hasAttachment) params.set('hasAttachment', 'true');
                if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
                if (filters.dateTo) params.set('dateTo', filters.dateTo);
                url += `?${params.toString()}`;
            }
            const res = await authFetch(url);
            if (!res.ok) return;
            const body = await res.json();
            const rows = Array.isArray(body) ? body : (body.documents || []);
            if (paginateDocs) {
                const total = Array.isArray(body) ? rows.length : (body.total || rows.length);
                if (append) setKbDocs(prev => [...prev, ...rows]);
                else setKbDocs(rows);
                setKbDocsTotal(total);
                setKbDocsOffset(offset);
                if (!append) setKbSelectedIds(new Set());
            } else {
                setKbDocs(rows);
            }
        } catch (e) { console.error('Failed to fetch docs:', e); }
    }

    const loadMoreKBDocs = () => {
        if (!selectedKB) return;
        fetchKBDocs(selectedKB.id, { append: true, offset: kbDocsOffset + docsPageSize });
    };

    async function deleteDoc(docId: string) {
        if (!selectedKB) return;
        if (!(await confirm({ title: deleteDocConfirm, confirmLabel: 'Delete', destructive: true }))) return;
        try {
            await authFetch(`${API_BASE}/api/kb/${selectedKB.id}/documents/${docId}`, { method: 'DELETE' });
            fetchKBDocs(selectedKB.id, { offset: 0 });
            fetchKBs();
        } catch (e) { console.error('Failed to delete doc:', e); }
    }

    // ── Bulk doc selection (paginated consumers) ─────────────────────
    const toggleSelectDoc = (docId: string) => {
        setKbSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(docId)) next.delete(docId); else next.add(docId);
            return next;
        });
    };

    const toggleSelectAllOnPage = () => {
        setKbSelectedIds(prev => {
            const visible = kbDocs.map(d => d.id);
            const allSelected = visible.every(id => prev.has(id));
            const next = new Set(prev);
            if (allSelected) visible.forEach(id => next.delete(id));
            else visible.forEach(id => next.add(id));
            return next;
        });
    };

    async function bulkDeleteSelected() {
        if (!selectedKB || kbSelectedIds.size === 0) return;
        if (!(await confirm({ title: `Delete ${kbSelectedIds.size} document${kbSelectedIds.size === 1 ? '' : 's'}?`, confirmLabel: 'Delete', destructive: true }))) return;
        setKbBulkBusy(true);
        const ids = Array.from(kbSelectedIds);
        // Ids still not confirmed deleted — starts as everything, shrinks by
        // one whole batch at a time. A batch that fails (refused, or the
        // request itself blew up) stops the loop right there: it and every
        // batch after it stay selected, exactly like never having been sent.
        const remaining = new Set(kbSelectedIds);
        try {
            for (let i = 0; i < ids.length; i += MAX_BULK_DELETE) {
                const batch = ids.slice(i, i + MAX_BULK_DELETE);
                const res = await authFetch(`${API_BASE}/api/kb/${selectedKB.id}/documents/bulk-delete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ documentIds: batch }),
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    toast.error('Bulk delete failed: ' + (err.error || 'failed'));
                    break;
                }
                batch.forEach(id => remaining.delete(id));
            }
        } catch (e) {
            console.error('Bulk delete failed:', e);
            toast.error('Bulk delete failed: ' + failureText(e));
        } finally {
            setKbSelectedIds(remaining);
            await fetchKBDocs(selectedKB.id, { offset: 0 });
            await fetchKBs();
            setKbBulkBusy(false);
        }
    }

    // ── Re-index ─────────────────────────────────────────────────────
    async function reindexKB() {
        if (!selectedKB) return;
        if (!(await confirm({ title: `Re-index "${selectedKB.name}"?`, description: 'This will re-fetch all URL sources and re-embed all documents with the current model. This may take a while.', confirmLabel: 'Re-index' }))) return;
        setReindexing(true); setReindexStatus('Starting re-index...');
        try {
            const res = await authFetch(`${API_BASE}/api/kb/${selectedKB.id}/reindex`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            if (res.ok) {
                const data = await res.json();
                // The route sends { reindexed, failed, sources, unattached, details } —
                // no `total`. `unattached` matters on its own: those documents were NOT
                // re-embedded, so leaving it out would claim a complete pass over a KB
                // that still holds vectors from the old model.
                let status = `Done: ${data.reindexed} re-indexed across ${data.sources} source${data.sources === 1 ? '' : 's'}`;
                if (data.failed) status += `, ${data.failed} failed`;
                if (data.unattached) status += `, ${data.unattached} not attached to a source (not re-embedded)`;
                setReindexStatus(status);
                fetchKBDocs(selectedKB.id); fetchKBs();
                setTimeout(() => setReindexStatus(''), 8000);
            } else {
                const err = await res.json().catch(() => ({}));
                setReindexStatus(''); toast.error('Re-index failed: ' + (err.error || 'failed'));
            }
        } catch (e) { setReindexStatus(''); toast.error('Re-index failed: ' + failureText(e)); }
        finally { setReindexing(false); }
    }

    // ── Ingestion ────────────────────────────────────────────────────
    const refreshAfterIngest = () => { if (selectedKB) fetchKBDocs(selectedKB.id); fetchKBs(); };

    async function ingestText() {
        if (!selectedKB || !kbTextContent.trim()) return;
        setKbIngesting(true); setKbIngestStatus('Processing...');
        try {
            const res = await authFetch(`${API_BASE}/api/kb/${selectedKB.id}/ingest/text`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: kbTextContent, title: kbTextTitle || 'Text' }),
            });
            if (res.ok) {
                setKbTextContent(''); setKbTextTitle(''); setKbIngestStatus('');
                refreshAfterIngest();
            } else {
                const err = await res.json().catch(() => ({}));
                setKbIngestStatus('Error: ' + (err.error || 'failed'));
            }
        } catch (e) { setKbIngestStatus('Failed: ' + failureText(e)); }
        finally { setKbIngesting(false); }
    }

    async function ingestUrl() {
        if (!selectedKB || !kbUrlInput.trim()) return;
        setKbIngesting(true); setKbIngestStatus('Fetching URL...');
        try {
            const res = await authFetch(`${API_BASE}/api/kb/${selectedKB.id}/ingest/url`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: kbUrlInput.trim() }),
            });
            if (res.ok) {
                setKbUrlInput(''); setKbIngestStatus('');
                refreshAfterIngest();
            } else {
                const err = await res.json().catch(() => ({}));
                setKbIngestStatus('Error: ' + (err.error || 'failed'));
            }
        } catch (e) { setKbIngestStatus('Failed: ' + failureText(e)); }
        finally { setKbIngesting(false); }
    }

    async function ingestSitemap() {
        if (!selectedKB || !kbUrlInput.trim()) return;
        setKbIngesting(true); setKbIngestStatus('Fetching sitemap...');
        try {
            const res = await authFetch(`${API_BASE}/api/kb/${selectedKB.id}/ingest/sitemap`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: kbUrlInput.trim(), maxPages: sitemapMaxPages }),
            });
            if (res.ok) {
                const data = await res.json();
                setKbUrlInput('');
                setKbIngestStatus(`Done: ${data.ingested} ingested, ${data.skipped} skipped, ${data.errors} errors`);
                refreshAfterIngest();
                setTimeout(() => setKbIngestStatus(''), 5000);
            } else {
                const err = await res.json().catch(() => ({}));
                setKbIngestStatus('Sitemap error: ' + (err.error || 'failed'));
            }
        } catch (e) { setKbIngestStatus('Sitemap failed: ' + failureText(e)); }
        finally { setKbIngesting(false); }
    }

    async function ingestN8n(workflowId: string) {
        if (!selectedKB || !workflowId) return;
        setKbIngesting(true); setKbIngestStatus('Ingesting workflow...');
        try {
            const res = await authFetch(`${API_BASE}/api/kb/${selectedKB.id}/ingest/n8n`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workflowId, mode: n8nIngestMode }),
            });
            if (res.ok) {
                const data = await res.json();
                setKbIngestStatus(`Done: ${data.chunks} chunks`);
                refreshAfterIngest();
                setTimeout(() => setKbIngestStatus(''), 5000);
            } else {
                const err = await res.json().catch(() => ({}));
                setKbIngestStatus('Error: ' + (err.error || 'failed'));
            }
        } catch (e) { setKbIngestStatus('Failed: ' + failureText(e)); }
        finally { setKbIngesting(false); }
    }

    async function ingestFile(e: ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file || !selectedKB) return;
        setKbIngesting(true); setKbIngestStatus('Uploading...');
        const formData = new FormData();
        formData.append('file', file);
        try {
            const res = await authFetch(`${API_BASE}/api/kb/${selectedKB.id}/ingest/file`, {
                method: 'POST', body: formData,
            });
            if (res.ok) {
                setKbIngestStatus('');
                refreshAfterIngest();
            } else {
                const err = await res.json().catch(() => ({}));
                setKbIngestStatus('Error: ' + (err.error || 'failed'));
            }
        } catch (e2) { setKbIngestStatus('Failed: ' + failureText(e2)); }
        finally { setKbIngesting(false); e.target.value = ''; }
    }

    async function ingestDriveFiles(driveFiles: DriveFile[]) {
        if (!selectedKB || !driveFiles?.length) return;
        setKbIngesting(true);
        let ingested = 0;
        try {
            for (const file of driveFiles) {
                setKbIngestStatus(`Ingesting ${file.name}... (${ingested + 1}/${driveFiles.length})`);
                const res = await authFetch(`${API_BASE}/api/kb/${selectedKB.id}/ingest/text`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: file.content, title: file.name }),
                });
                if (res.ok) {
                    ingested++;
                } else {
                    // Surface per-file failures instead of silently swallowing them.
                    const err = await res.json().catch(() => ({}));
                    console.error(`Failed to ingest ${file.name}:`, err.error);
                }
            }
            setKbIngestStatus('');
            refreshAfterIngest();
            if (ingested > 0 && ingested < driveFiles.length) {
                toast.error(`Ingested ${ingested}/${driveFiles.length} files. Some failed.`);
            }
        } catch (e) { setKbIngestStatus(''); toast.error('Failed: ' + failureText(e)); }
        finally { setKbIngesting(false); }
    }

    return {
        // list
        kbs, loadingKbs, selectedKB, setSelectedKB, fetchKBs,
        // create
        showCreateKB, setShowCreateKB, openCreateKB, cancelCreateKB,
        newKBName, setNewKBName, newKBDesc, setNewKBDesc, creatingKB, createKB,
        // edit (admin rename)
        editingKB, setEditingKB, editName, setEditName, editDesc, setEditDesc,
        savingEdit, startEditKB, updateKB,
        // delete
        deleteKB, confirmDialog,
        // documents
        kbDocs, setKbDocs, kbDocsTotal, kbDocsOffset, fetchKBDocs, deleteDoc, loadMoreKBDocs,
        docsPageSize,
        // sources
        kbSources, kbSourceTotals, kbSourcesError, fetchKBSources,
        // bulk / filters (paginated consumers)
        kbSelectedIds, setKbSelectedIds, toggleSelectDoc, toggleSelectAllOnPage,
        bulkDeleteSelected, kbBulkBusy, kbDocsFilters, setKbDocsFilters,
        // ingestion
        kbInputMode, setKbInputMode, kbTextContent, setKbTextContent,
        kbTextTitle, setKbTextTitle, kbUrlInput, setKbUrlInput,
        kbIngesting, kbIngestStatus, setKbIngestStatus,
        ingestText, ingestUrl, ingestSitemap, ingestN8n, ingestFile, ingestDriveFiles,
        // sitemap
        sitemapMode, setSitemapMode, sitemapMaxPages, setSitemapMaxPages,
        // n8n
        n8nWorkflows, n8nIngestMode, setN8nIngestMode,
        // drive
        drivePickerOpen, setDrivePickerOpen, driveConnected,
        // re-index
        reindexKB, reindexStatus, reindexing,
        // misc
        useAzureKB,
    };
}
