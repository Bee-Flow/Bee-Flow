import React from 'react';
import CreateKBModal from './CreateKBModal';
import EmailThreadExplorer from './EmailThreadExplorer';
import type { EmailThreadDoc } from './EmailThreadExplorer';
import KBIngestPanel from './KBIngestPanel';
import useKnowledgeBases from '../../hooks/useKnowledgeBases';
import type { KbDocument, KbDocFilters, KnowledgeBase, KbSource, DriveFile } from '../../hooks/useKnowledgeBases';
import { API_BASE, authFetch } from '../../utils/helpers';
import GoogleDrivePicker from '../chat/GoogleDrivePicker';
import { TranslateParams, useTranslation } from '../../hooks/useTranslation';

interface KnowledgeBaseRow extends KnowledgeBase {
    organization_id?: string;
    document_count?: number;
    total_chunks?: number;
}

interface KbDocumentRow extends KbDocument {
    title?: string;
    source_type?: string;
    chunk_count?: number;
    created_at: string;
    metadata?: { from?: string; hasAttachments?: boolean };
}

interface KnowledgePanelProps {
    /** Accepted, never read: see the note below. */
    agentId?: string | null;
    API_BASE: string;
    strictKnowledge?: boolean;
    onStrictKnowledgeChange?: (strict: boolean) => void;
    includeSourceReferences?: boolean;
    onIncludeSourceReferencesChange?: (include: boolean) => void;
    knowledgeBaseIds?: string[];
    onKnowledgeBaseIdsChange?: (ids: string[]) => void;
}

// `agentId` is deliberately NOT read here any more. It used to feed the flat
// per-agent knowledge layer (GET /agents/:id/knowledge) that lived behind a
// `{false && …}` branch; both are gone. The panel's data now hangs off knowledge
// BASE ids, so callers may keep passing agentId — nothing consumes it, and a new
// fetch keyed on it would be the regression KnowledgePanel.test.jsx pins.
const KnowledgePanel = ({ API_BASE, strictKnowledge = false, onStrictKnowledgeChange, includeSourceReferences = false, onIncludeSourceReferencesChange, knowledgeBaseIds = [], onKnowledgeBaseIdsChange }: KnowledgePanelProps) => {
    const { t } = useTranslation();
    // ── Multi-KB (shared hook) ──────────────────────────────────────
    // Agent-picker context: list only KBs usable by agents, and keep the
    // agent's knowledgeBaseIds in sync when a KB is created/deleted here.
    const kb = useKnowledgeBases({
        listContext: 'agent',
        paginateDocs: true,
        enableDrive: true,
        enableAzureInfo: true,
        onKBCreated: (created: KnowledgeBase) => { if (onKnowledgeBaseIdsChange) onKnowledgeBaseIdsChange([...knowledgeBaseIds, created.id]); },
        onKBDeleted: (kbId: string) => { if (onKnowledgeBaseIdsChange) onKnowledgeBaseIdsChange(knowledgeBaseIds.filter((id: string) => id !== kbId)); },
    });
    const selectedKB = kb.selectedKB;

    // ── KB link toggle (agent-specific link state) ──────────────────
    const toggleKBLink = (kbId: string) => {
        if (!onKnowledgeBaseIdsChange) return;
        const current = new Set(knowledgeBaseIds);
        if (current.has(kbId)) current.delete(kbId);
        else current.add(kbId);
        onKnowledgeBaseIdsChange([...current]);
    };

    return (
        <div className="flex flex-col h-full space-y-4" data-testid="knowledge-panel" data-tour="agent-knowledge">
            {/* Google Drive Picker Modal */}
            <GoogleDrivePicker
                isOpen={kb.drivePickerOpen}
                onClose={() => kb.setDrivePickerOpen(false)}
                onFilesSelected={kb.ingestDriveFiles}
                apiBase={API_BASE}
            />
            <KnowledgePanelSection onStrictKnowledgeChange={onStrictKnowledgeChange} t={t} strictKnowledge={strictKnowledge} onIncludeSourceReferencesChange={onIncludeSourceReferencesChange} includeSourceReferences={includeSourceReferences} kb={kb} knowledgeBaseIds={knowledgeBaseIds} selectedKB={selectedKB} toggleKBLink={toggleKBLink} />
            {kb.confirmDialog}
        </div>
    );
};

export default KnowledgePanel;

function KnowledgePanelSection({ onStrictKnowledgeChange, t, strictKnowledge, onIncludeSourceReferencesChange, includeSourceReferences, kb, knowledgeBaseIds, selectedKB, toggleKBLink }: { onStrictKnowledgeChange: ((strict: boolean) => void) | undefined; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; strictKnowledge: boolean; onIncludeSourceReferencesChange: ((include: boolean) => void) | undefined; includeSourceReferences: boolean; kb: { kbs: KnowledgeBase[]; loadingKbs: boolean; selectedKB: KnowledgeBase | null; setSelectedKB: React.Dispatch<React.SetStateAction<KnowledgeBase | null>>; fetchKBs: () => Promise<void>; showCreateKB: boolean; setShowCreateKB: React.Dispatch<React.SetStateAction<boolean>>; openCreateKB: () => void; cancelCreateKB: () => void; newKBName: string; setNewKBName: React.Dispatch<React.SetStateAction<string>>; newKBDesc: string; setNewKBDesc: React.Dispatch<React.SetStateAction<string>>; creatingKB: boolean; createKB: () => Promise<void>; editingKB: string | null; setEditingKB: React.Dispatch<React.SetStateAction<string | null>>; editName: string; setEditName: React.Dispatch<React.SetStateAction<string>>; editDesc: string; setEditDesc: React.Dispatch<React.SetStateAction<string>>; savingEdit: boolean; startEditKB: (kb: KnowledgeBase) => void; updateKB: () => Promise<void>; deleteKB: (kbId: string) => Promise<void>; confirmDialog: React.JSX.Element; kbDocs: KbDocument[]; setKbDocs: React.Dispatch<React.SetStateAction<KbDocument[]>>; kbDocsTotal: number; kbDocsOffset: number; fetchKBDocs: (kbId: string, { append, offset, filters }?: { append?: boolean; offset?: number; filters?: KbDocFilters; }) => Promise<void>; deleteDoc: (docId: string) => Promise<void>; loadMoreKBDocs: () => void; docsPageSize: number; kbSources: KbSource[]; kbSourceTotals: Record<string, unknown> | null; kbSourcesError: string | null; fetchKBSources: (kbId: string | null | undefined) => Promise<KbSource[]>; kbSelectedIds: Set<string>; setKbSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>; toggleSelectDoc: (docId: string) => void; toggleSelectAllOnPage: () => void; bulkDeleteSelected: () => Promise<void>; kbBulkBusy: boolean; kbDocsFilters: KbDocFilters; setKbDocsFilters: React.Dispatch<React.SetStateAction<KbDocFilters>>; kbInputMode: string; setKbInputMode: React.Dispatch<React.SetStateAction<string>>; kbTextContent: string; setKbTextContent: React.Dispatch<React.SetStateAction<string>>; kbTextTitle: string; setKbTextTitle: React.Dispatch<React.SetStateAction<string>>; kbUrlInput: string; setKbUrlInput: React.Dispatch<React.SetStateAction<string>>; kbIngesting: boolean; kbIngestStatus: string; setKbIngestStatus: React.Dispatch<React.SetStateAction<string>>; ingestText: () => Promise<void>; ingestUrl: () => Promise<void>; ingestSitemap: () => Promise<void>; ingestN8n: (workflowId: string) => Promise<void>; ingestFile: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>; ingestDriveFiles: (driveFiles: DriveFile[]) => Promise<void>; sitemapMode: boolean; setSitemapMode: React.Dispatch<React.SetStateAction<boolean>>; sitemapMaxPages: number; setSitemapMaxPages: React.Dispatch<React.SetStateAction<number>>; n8nWorkflows: unknown[]; n8nIngestMode: string; setN8nIngestMode: React.Dispatch<React.SetStateAction<string>>; drivePickerOpen: boolean; setDrivePickerOpen: React.Dispatch<React.SetStateAction<boolean>>; driveConnected: boolean; reindexKB: () => Promise<void>; reindexStatus: string; reindexing: boolean; useAzureKB: boolean; }; knowledgeBaseIds: string[]; selectedKB: KnowledgeBase | null; toggleKBLink: (kbId: string) => void; }) {
    return <div className="max-w-3xl space-y-4">
        {/* Toggles */}
        {onStrictKnowledgeChange && (
            <div className="flex items-center justify-between p-4 rounded-xl border bg-[var(--bg-tertiary)] border-[var(--border-default)]">
                <div className="flex items-center gap-3">
                    <span className="text-lg">🔒</span>
                    <div>
                        <div className="text-sm font-medium text-[var(--text-primary)]">{t('knowledge.knowledge_strict_knowledge_mode', 'Strict Knowledge Mode')}</div>
                        <div className="text-xs text-[var(--text-muted)]">{t('knowledge.knowledge_only_answer_from_the_knowledge_base', 'Only answer from the knowledge base.')}</div>
                    </div>
                </div>
                <button onClick={() => onStrictKnowledgeChange(!strictKnowledge)}
                    className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${strictKnowledge ? 'bg-amber-500' : 'bg-gray-600'}`}>
                    <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${strictKnowledge ? 'left-5' : 'left-1'}`} />
                </button>
            </div>
        )}
        {onIncludeSourceReferencesChange && (
            <div className="flex items-center justify-between p-4 rounded-xl border bg-[var(--bg-tertiary)] border-[var(--border-default)]">
                <div className="flex items-center gap-3">
                    <span className="text-lg">🔗</span>
                    <div>
                        <div className="text-sm font-medium text-[var(--text-primary)]">{t('knowledge.knowledge_include_source_references', 'Include Source References')}</div>
                        <div className="text-xs text-[var(--text-muted)]">{t('knowledge.knowledge_cite_source_urls_when_answering_from', 'Cite source URLs when answering from knowledge.')}</div>
                    </div>
                </div>
                <button onClick={() => onIncludeSourceReferencesChange(!includeSourceReferences)}
                    className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${includeSourceReferences ? 'bg-blue-500' : 'bg-gray-600'}`}>
                    <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${includeSourceReferences ? 'left-5' : 'left-1'}`} />
                </button>
            </div>
        )}

        {/* ════════════════ Knowledge Bases ════════════════ */}
        {(
            <div className="space-y-4">
                {/* KB List */}
                <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-[var(--text-primary)]">
                        {t('knowledge.knowledge_knowledge_bases_count', 'Knowledge Bases ({count})', { count: kb.kbs.length })}
                    </h3>
                    <button onClick={kb.openCreateKB}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--accent-primary)]"
                        data-testid="kb-create-btn">
                        {t('knowledge.knowledge_create_kb', '+ Create KB')}
                    </button>
                </div>

                {/* Create KB Form */}
                {kb.showCreateKB && (
                    <CreateKBModal
                        name={kb.newKBName} onNameChange={kb.setNewKBName}
                        description={kb.newKBDesc} onDescChange={kb.setNewKBDesc}
                        creating={kb.creatingKB} onCreate={kb.createKB} onCancel={kb.cancelCreateKB}
                        namePlaceholder="KB Name (e.g. Product Docs)" />
                )}

                {kb.loadingKbs ? (
                    <div className="text-center py-6 text-xs text-[var(--text-muted)]">Loading...</div>
                ) : kb.kbs.length === 0 ? (
                    <div className="text-center py-8 text-xs rounded-xl border border-dashed text-[var(--text-muted)] border-[var(--border-subtle)]">
                        {t('knowledge.knowledge_no_knowledge_bases_yet_create_one_to', 'No knowledge bases yet. Create one to get started with')} {kb.useAzureKB ? 'Azure OpenAI' : 'bge-m3'} {t('knowledge.knowledge_embeddings_hybrid_search', 'embeddings + hybrid search.')}
                    </div>
                ) : (
                    <div className="space-y-2">
                        {(kb.kbs as KnowledgeBaseRow[]).map((item: KnowledgeBaseRow) => {
                            const isLinked = knowledgeBaseIds.includes(item.id);
                            const isSelected = selectedKB?.id === item.id;
                            return (
                                <div key={item.id}
                                    className={`p-3 rounded-lg border group cursor-pointer transition-all ${isSelected ? 'ring-2 ring-[var(--accent-primary)] border-transparent' : 'hover:border-[var(--border-default)]'} [background:var(--bg-tertiary)] [border-color:var(--border-default)]!`}
                                    onClick={() => kb.setSelectedKB(isSelected ? null : item)}
                                    data-testid={`kb-item-${item.id}`}>
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm ${isLinked ? '[background:rgba(59,130,246,0.15)]' : '[background:var(--bg-secondary)]'}`}>
                                                📚
                                            </div>
                                            <div>
                                                <div className="text-sm font-medium flex items-center gap-1.5 text-[var(--text-primary)]">
                                                    {item.name}
                                                    {item.organization_id ? (
                                                        <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-blue-500/10 text-blue-400" title={t('knowledge.knowledge_shared_with_organization', 'Shared with organization')}>{t('knowledge.knowledge_org', '🏢 Org')}</span>
                                                    ) : (
                                                        <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-white/5 text-[var(--text-muted)]" title={t('knowledge.knowledge_personal_kb', 'Personal KB')}>👤</span>
                                                    )}
                                                </div>
                                                <div className="text-[10px] flex items-center gap-2 text-[var(--text-muted)]">
                                                    {item.document_count || 0} {t('knowledge.knowledge_docs', 'docs ·')} {item.total_chunks || 0} {t('knowledge.knowledge_chunks', 'chunks')}
                                                    {item.description && <span>· {item.description}</span>}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2" onClick={(e: React.MouseEvent<HTMLDivElement>) => e.stopPropagation()}>
                                            <button onClick={() => toggleKBLink(item.id)}
                                                className={`px-2.5 py-1 rounded-full text-[10px] font-medium transition-all ${isLinked ? 'bg-blue-500/15 text-blue-400 hover:bg-red-500/15 hover:text-red-400' : 'bg-white/5 text-[var(--text-muted)] hover:bg-blue-500/15 hover:text-blue-400'}`}>
                                                {isLinked ? '✓ Linked' : '+ Link'}
                                            </button>
                                            <button onClick={() => kb.deleteKB(item.id)}
                                                className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/10" title={t('knowledge.knowledge_delete_kb', 'Delete KB')}
                                                data-testid={`kb-delete-${item.id}`}>
                                                <svg className="w-3.5 h-3.5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Selected KB Detail — Ingest + Documents */}
                {selectedKB && (
                    <div className="p-4 rounded-xl border bg-[var(--bg-secondary)] border-[var(--border-default)] space-y-4">
                        <div className="flex items-center justify-between">
                            <h4 className="text-sm font-semibold text-[var(--text-primary)]">
                                📚 {selectedKB.name}
                            </h4>
                            <div className="flex items-center gap-2">
                                {kb.reindexStatus && (
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 font-medium flex items-center gap-1">
                                        {kb.reindexing && (
                                            <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                                                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="44" strokeDashoffset="8" />
                                            </svg>
                                        )}
                                        {kb.reindexStatus}
                                    </span>
                                )}
                                <button onClick={kb.reindexKB} disabled={kb.reindexing || kb.kbDocs.length === 0}
                                    className="text-[10px] px-2 py-0.5 rounded-full font-medium transition-all hover:bg-amber-500/15 disabled:opacity-40 [background:rgba(245,158,11,0.08)]! [color:rgb(245,158,11)]!"
                                    title={t('knowledge.knowledge_re_fetch_urls_and_re_embed_all', 'Re-fetch URLs and re-embed all documents with current model')}>
                                    {kb.reindexing ? '⏳ Re-indexing...' : '🔄 Re-index'}
                                </button>

                            </div>
                        </div>

                        {/* Ingest Section */}
                        <KBIngestPanel kb={kb} fieldBg="var(--bg-tertiary)" />

                        {/* Documents List */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <h5 className="text-xs font-medium text-[var(--text-muted)]">
                                    {kb.kbDocsTotal > kb.kbDocs.length ? t('knowledge.knowledge_documents_of', 'Documents ({count} of {total})', { count: kb.kbDocs.length, total: kb.kbDocsTotal }) : t('knowledge.knowledge_documents', 'Documents ({count})', { count: kb.kbDocs.length })}
                                </h5>
                                {kb.kbSelectedIds.size > 0 && (
                                    <div className="flex items-center gap-2">
                                        <span className="text-[10px] text-[var(--text-muted)]">{t('knowledge.knowledge_selected', '{count} selected', { count: kb.kbSelectedIds.size })}</span>
                                        <button onClick={kb.bulkDeleteSelected} disabled={kb.kbBulkBusy}
                                            className="px-2 py-0.5 rounded text-[10px] font-medium bg-red-500/10 text-red-600 hover:bg-red-500/20 disabled:opacity-50">
                                            {kb.kbBulkBusy ? 'Deleting…' : 'Delete selected'}
                                        </button>
                                        <button onClick={() => kb.setKbSelectedIds(new Set())} className="text-[10px] text-[var(--text-muted)]">{t('knowledge.knowledge_clear', 'Clear')}</button>
                                    </div>
                                )}
                            </div>

                            {/* Email-specific filter bar: shown when any doc in list is sourced from email. */}
                            {kb.kbDocs.some((d: KbDocument) => d.source_type === 'email') && (
                                <div className="mb-2 p-2 rounded-lg border flex flex-wrap gap-1.5 items-center border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                                    <input type="text" placeholder={t('knowledge.knowledge_sender', 'Sender')} value={kb.kbDocsFilters.sender}
                                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => kb.setKbDocsFilters((f: KbDocFilters) => ({ ...f, sender: e.target.value }))}
                                        className="px-2 py-1 rounded text-[11px] border [background:var(--bg-primary)] [border-color:var(--border-subtle)] [color:var(--text-primary)]!" />
                                    <input type="date" value={kb.kbDocsFilters.dateFrom}
                                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => kb.setKbDocsFilters((f: KbDocFilters) => ({ ...f, dateFrom: e.target.value }))}
                                        className="px-2 py-1 rounded text-[11px] border [background:var(--bg-primary)] [border-color:var(--border-subtle)] [color:var(--text-primary)]!" />
                                    <input type="date" value={kb.kbDocsFilters.dateTo}
                                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => kb.setKbDocsFilters((f: KbDocFilters) => ({ ...f, dateTo: e.target.value }))}
                                        className="px-2 py-1 rounded text-[11px] border [background:var(--bg-primary)] [border-color:var(--border-subtle)] [color:var(--text-primary)]!" />
                                    <label className="flex items-center gap-1 text-[11px] text-[var(--text-primary)]">
                                        <input type="checkbox" checked={kb.kbDocsFilters.hasAttachment}
                                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => kb.setKbDocsFilters((f: KbDocFilters) => ({ ...f, hasAttachment: e.target.checked }))} />
                                        {t('knowledge.knowledge_has_attachment', 'Has attachment')}
                                    </label>
                                    <button onClick={() => kb.fetchKBDocs(selectedKB.id, { offset: 0 })}
                                        className="px-2 py-1 rounded text-[11px] font-medium [background:var(--accent-primary)] [color:#fff]!">
                                        {t('knowledge.knowledge_apply', 'Apply')}
                                    </button>
                                    <button onClick={() => { const cleared = { sender: '', threadId: '', hasAttachment: false, dateFrom: '', dateTo: '' }; kb.setKbDocsFilters(cleared); kb.fetchKBDocs(selectedKB.id, { offset: 0, filters: cleared }); } }
                                        className="px-2 py-1 rounded text-[11px] text-[var(--text-muted)]">{t('knowledge.knowledge_clear', 'Clear')}</button>
                                </div>
                            )}

                            {kb.kbDocs.length === 0 ? (
                                <div className="text-center py-4 text-xs rounded-lg border border-dashed text-[var(--text-muted)] border-[var(--border-subtle)]">
                                    {t('knowledge.knowledge_no_documents_yet_ingest_text_files_or', 'No documents yet. Ingest text, files, or URLs above.')}
                                </div>
                            ) : (
                                <>
                                    <div className="flex items-center gap-2 mb-1.5 text-[10px] text-[var(--text-muted)]">
                                        <input type="checkbox"
                                            checked={kb.kbDocs.length > 0 && kb.kbDocs.every((d: KbDocument) => kb.kbSelectedIds.has(d.id))}
                                            onChange={kb.toggleSelectAllOnPage} />
                                        {t('knowledge.knowledge_select_all_on_page', 'Select all on page')}
                                    </div>
                                    <div className="space-y-1.5">
                                        {(kb.kbDocs as KbDocumentRow[]).map((doc: KbDocumentRow) => (
                                            <div key={doc.id} className="flex items-center justify-between p-2.5 rounded-lg group bg-[var(--bg-tertiary)]"
                                                data-testid={`kb-doc-${doc.id}`}>
                                                <div className="flex items-center gap-2 min-w-0">
                                                    <input type="checkbox" checked={kb.kbSelectedIds.has(doc.id)}
                                                        onChange={() => kb.toggleSelectDoc(doc.id)}
                                                        className="flex-shrink-0" />
                                                    <span className="text-sm flex-shrink-0">
                                                        {doc.source_type === 'web' ? '🌐'
                                                            : doc.source_type === 'upload' ? '📄'
                                                                : doc.source_type === 'email' ? '✉️'
                                                                    : '📝'}
                                                    </span>
                                                    <div className="min-w-0">
                                                        <div className="text-xs font-medium truncate text-[var(--text-primary)]">{doc.title || 'Untitled'}</div>
                                                        <div className="text-[10px] truncate text-[var(--text-muted)]">
                                                            {t('knowledge.knowledge_chunks_2', '{count} chunks · {date}', { count: doc.chunk_count || 0, date: new Date(doc.created_at).toLocaleDateString() })}
                                                            {doc.metadata?.from ? ` · ${String(doc.metadata.from).replace(/<[^>]+>/, '').trim().slice(0, 30)}` : ''}
                                                            {doc.metadata?.hasAttachments ? ' · 📎' : ''}
                                                        </div>
                                                    </div>
                                                </div>
                                                <button onClick={() => kb.deleteDoc(doc.id)}
                                                    className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/10 flex-shrink-0"
                                                    data-testid={`kb-doc-delete-${doc.id}`}>
                                                    <svg className="w-3.5 h-3.5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                                    </svg>
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                    {kb.kbDocsTotal > kb.kbDocs.length && (
                                        <div className="flex justify-center mt-2">
                                            <button onClick={kb.loadMoreKBDocs}
                                                className="px-3 py-1 rounded text-[11px] font-medium border border-[var(--border-subtle)] text-[var(--text-primary)]">
                                                {t('knowledge.knowledge_load_more', 'Load more (')}{kb.kbDocsTotal - kb.kbDocs.length} {t('knowledge.knowledge_left', 'left)')}
                                            </button>
                                        </div>
                                    )}
                                </>
                            )}

                            {/* Email thread explorer (only renders when the KB has email threads). */}
                            {kb.kbDocs.some((d: KbDocument) => d.source_type === 'email') && selectedKB?.id && (
                                <EmailThreadExplorer
                                    kbId={selectedKB.id}
                                    authFetch={authFetch}
                                    onOpenDoc={(doc: EmailThreadDoc) => kb.setKbDocsFilters((f: KbDocFilters) => ({ ...f, threadId: doc.metadata?.threadId || '' }))} />
                            )}
                        </div>
                    </div>
                )}


            </div>
        )}
    </div>;
}
