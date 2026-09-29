import { Upload, X } from 'lucide-react';
import React, { useState, useEffect, useEffectEvent, useCallback } from 'react';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { nOf } from '../../../admin/Studio/KnowledgeStudio/plural';
import Modal from '../../../shared/Modal';
import { kbDocumentCount, uploadKbIdOf } from '../builderSplit/uploadKb';

// Sub-component: list of all KBs the user can link/unlink to this agent,
// plus an inline create-form. Co-located here because nothing else uses it.
function KbList({ kbs, linkedIds, onToggle, onCreate, t }) {
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [busy, setBusy] = useState(false);
    const submit = async () => {
        if (!name.trim() || busy) return;
        setBusy(true);
        const created = await onCreate(name.trim(), description.trim());
        setBusy(false);
        if (created) { setName(''); setDescription(''); setCreating(false); }
    };
    return (
        <div>
            <div className="flex items-center justify-between mb-2">
                <div className="text-[13px] font-medium text-[var(--text-secondary)]">
                    {t('agent_wizard.knowledge.kbs')} ({kbs.length})
                </div>
                <button
                    onClick={() => setCreating(v => !v)}
                    className="text-xs text-[var(--accent)] hover:underline"
                >
                    + {t('agent_wizard.knowledge.create_kb')}
                </button>
            </div>
            {creating && (
                <div className="mb-3 p-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] space-y-2">
                    <input
                        autoFocus
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t('agent_wizard.knowledge.kb_name')}
                        className="w-full bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                    />
                    <input
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder={t('agent_wizard.knowledge.kb_description')}
                        className="w-full bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                    />
                    <div className="flex justify-end gap-2">
                        <button onClick={() => setCreating(false)} className="px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                            {t('agent_studio.cancel')}
                        </button>
                        <button onClick={submit} disabled={!name.trim() || busy} className="px-4 py-1.5 rounded-full text-xs font-medium bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50">
                            {busy ? '…' : t('agent_wizard.knowledge.create_kb')}
                        </button>
                    </div>
                </div>
            )}
            {kbs.length === 0 && (
                <div className="text-xs text-[var(--text-tertiary)] py-2">{t('agent_wizard.knowledge.no_kbs')}</div>
            )}
            <div className="divide-y divide-[var(--border-default)] border-t border-b border-[var(--border-default)]">
                {kbs.map(kb => {
                    const linked = linkedIds.includes(kb.id);
                    const docCount = kbDocumentCount(kb);
                    return (
                        <div key={kb.id} className="flex items-center gap-3 py-2 px-1">
                            <div className="flex-1 min-w-0">
                                <div className="text-sm text-[var(--text-primary)] truncate">{kb.name}</div>
                                {docCount !== undefined && (
                                    <div className="text-[11px] text-[var(--text-tertiary)]">
                                        {nOf(t, 'agent_wizard.knowledge.n_documents', docCount, '{count} document', '{count} documents')}
                                    </div>
                                )}
                            </div>
                            <button
                                onClick={() => onToggle(kb.id)}
                                className={`px-3 py-1 rounded-full text-xs border transition ${linked
                                    ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--bg-secondary)]'
                                    : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}
                            >
                                {linked ? `✓ ${t('agent_wizard.knowledge.linked')}` : `+ ${t('agent_wizard.knowledge.link')}`}
                            </button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/**
 * ── TWEE AGENT-INSTELLINGEN ZIJN HIER WEG (A2 stap 2) ───────────────
 * `strictKnowledge` en `includeSourceReferences` stonden bovenaan deze modal,
 * als twee vinkjes boven een bestandenlijst. Ze gaan niet over BESTANDEN maar
 * over het ANTWOORD van de agent, en ze stonden op de enige plek waar je ze
 * pas ziet nadat je op "Bestanden uploaden" hebt geklikt. Sinds A2 stap 2
 * staan ze waar de vraag gesteld wordt: `strictKnowledge` op Rol, onder "Als
 * het niet weet", en `includeSourceReferences` in het ⋯-menu van de
 * Kennis-kaart op "Kan gebruiken". De props zijn hier verdwenen in plaats van
 * genegeerd — een prop die niets doet is de volgende die per ongeluk weer
 * gebruikt wordt.
 */
export default function FilesUploadModal({ t, agent, agentName, knowledgeBaseIds, onKnowledgeBaseIdsChange, allKbs, onToggleKbLink, onCreateKb, onDocCountChange, onKbsChange, onClose }) {
    // Primary KB = the auto-created KB at wizard/commit time, or the first
    // linked KB. The "Upload files" pill counts the same base (uploadKb.ts).
    const initialKbId = uploadKbIdOf(agent, knowledgeBaseIds);
    const [kbId, setKbId] = useState(initialKbId);
    const [docs, setDocs] = useState([]);
    // The server's count of every document in the base; `docs` is one page.
    const [total, setTotal] = useState(null);
    const [loading, setLoading] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState(null);
    const [dragOver, setDragOver] = useState(false);

    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const ensureKB = useCallback(async () => {
        if (kbId) return kbId;
        // Lazily create one if commit didn't (older agents, KB feature was
        // disabled, unsaved drafts — BFSF-270). Prefer the LIVE typed name over
        // the stale agent shell so a draft doesn't mint a KB called "Untitled".
        const kbName = agentName || agent?.name || 'Knowledge';
        try {
            const res = await authFetch(`${API_BASE}/api/kb`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: kbName, description: `Auto-generated for agent "${kbName}"` }),
            });
            if (!res.ok) throw new Error(await res.text());
            const created = await res.json();
            setKbId(created.id);
            const next = Array.from(new Set([...(knowledgeBaseIds || []), created.id]));
            onKnowledgeBaseIdsChange(next);
            return created.id;
        } catch (err) {
            setError(err.message);
            return null;
        }
    }, [kbId, agentName, agent?.name, agent?.id, knowledgeBaseIds, onKnowledgeBaseIdsChange]);

    // Tells the parent the number this dialog shows, so the pill that opened
    // it shows the same one.
    const reportDocCount = useEffectEvent((id, n) => { onDocCountChange?.(id, n); });

    const loadDocs = useCallback(async (id) => {
        if (!id) return;
        setLoading(true);
        try {
            const res = await authFetch(`${API_BASE}/api/kb/${id}/documents?limit=200`);
            if (res.ok) {
                const data = await res.json();
                const list = Array.isArray(data) ? data : (data?.documents || data?.items || []);
                setDocs(list);
                setTotal(Number.isFinite(data?.total) ? data.total : list.length);
            }
        } catch (_) { /* ignore */ } finally { setLoading(false); }
    }, []);

    useEffect(() => { if (kbId) loadDocs(kbId); }, [kbId, loadDocs]);
    useEffect(() => { if (kbId && total !== null) reportDocCount(kbId, total); }, [kbId, total]);

    const uploadFiles = async (files) => {
        if (!files || files.length === 0) return;
        setError(null);
        setUploading(true);
        let id = null;
        try {
            id = await ensureKB();
            if (!id) return;
            for (const file of files) {
                const fd = new FormData();
                fd.append('file', file);
                const res = await authFetch(`${API_BASE}/api/kb/${id}/ingest/file`, {
                    method: 'POST',
                    body: fd,
                });
                if (!res.ok) {
                    const txt = await res.text();
                    throw new Error(`${file.name}: ${txt}`);
                }
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setUploading(false);
        }
        if (!id) return;
        // Also after a failed file: the ones before it did land. The parent's
        // knowledge-base list carries per-base counts too, and a base created
        // just now is not in it yet.
        await loadDocs(id);
        onKbsChange?.();
    };

    const onDrop = (e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer?.files?.length) uploadFiles(Array.from(e.dataTransfer.files));
    };

    const deleteDoc = async (docId) => {
        if (!kbId) return;
        try {
            const res = await authFetch(`${API_BASE}/api/kb/${kbId}/documents/${docId}`, { method: 'DELETE' });
            if (!res.ok) throw new Error(await res.text());
            await loadDocs(kbId);
            onKbsChange?.();
        } catch (err) { setError(err.message); }
    };

    return (
        <Modal
            open
            onClose={onClose}
            size="lg"
            zIndex={1000}
            variant="bare"
            label={t('agent_wizard.files.title')}
            className="bg-[var(--bg-card,#fff)] overflow-y-auto"
        >
            <div>
                <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-default)]">
                    <div>
                        <div className="text-sm font-semibold text-[var(--text-primary)]">{t('agent_wizard.files.title')}</div>
                        <div className="text-xs text-[var(--text-tertiary)]">{t('agent_wizard.files.subtitle')}</div>
                        {/* BFSF-270: for unsaved drafts, say WHERE files go —
                            the assignee's "there should be a message" — while
                            keeping the flow fully functional. */}
                        {!agent?.id && (
                            <div className="text-xs text-[var(--text-tertiary)] mt-1">
                                {t('agent_wizard.files.draft_notice', 'Files are stored in a knowledge base right away — save the agent to keep them linked.')}
                            </div>
                        )}
                    </div>
                    <button onClick={onClose} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"><X size={18} /></button>
                </div>

                <div className="p-5 space-y-4">
                    {/* KbList draws its own "Knowledge bases (N)" heading, next
                        to its Create button; a second one here doubled it. */}
                    {Array.isArray(allKbs) && (
                        <KbList
                            t={t}
                            kbs={allKbs}
                            linkedIds={knowledgeBaseIds}
                            onToggle={onToggleKbLink}
                            onCreate={onCreateKb}
                        />
                    )}

                    <label
                        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                        onDragLeave={() => setDragOver(false)}
                        onDrop={onDrop}
                        data-testid="files-drop-zone"
                        className={`block rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition ${dragOver ? 'border-[var(--accent)] bg-[var(--bg-secondary)]' : 'border-[var(--border-default)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)]'}`}
                    >
                        <Upload className="mx-auto mb-2 text-[var(--text-tertiary)]" size={24} />
                        <div className="text-sm text-[var(--text-primary)]">{t('agent_wizard.files.drop_here')}</div>
                        <div className="text-xs text-[var(--text-tertiary)] mt-1">{t('agent_wizard.files.click_or_drag')}</div>
                        <input
                            type="file"
                            multiple
                            className="hidden"
                            onChange={(e) => { uploadFiles(Array.from(e.target.files || [])); e.target.value = ''; }}
                        />
                    </label>

                    {uploading && <div className="text-xs text-[var(--text-secondary)]">{t('agent_wizard.files.uploading')}</div>}
                    {error && <div className="text-xs text-red-500">{error}</div>}

                    <div>
                        <div className="text-[13px] font-medium text-[var(--text-secondary)] mb-2">
                            {t('agent_wizard.files.documents')} {!loading && `(${total ?? docs.length})`}
                        </div>
                        {loading && <div className="text-xs text-[var(--text-tertiary)]">…</div>}
                        {!loading && docs.length === 0 && (
                            <div className="text-xs text-[var(--text-tertiary)] py-3 text-center">{t('agent_wizard.files.no_documents')}</div>
                        )}
                        <div className="divide-y divide-[var(--border-default)]">
                            {docs.map((d) => (
                                <div key={d.id} className="flex items-center gap-3 py-2 text-sm text-[var(--text-primary)]">
                                    <div className="flex-1 min-w-0">
                                        <div className="truncate">{d.title || d.source_url || d.id}</div>
                                        <div className="text-[11px] text-[var(--text-tertiary)]">
                                            {d.chunk_count != null ? `${d.chunk_count} chunks` : ''}
                                        </div>
                                    </div>
                                    <button onClick={() => deleteDoc(d.id)} className="text-[var(--text-tertiary)] hover:text-red-500"><X size={14} /></button>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
