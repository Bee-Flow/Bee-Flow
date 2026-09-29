import { ArrowLeft, X, Maximize2, Download, Pencil, Eye, History, Check, Loader2, AlertTriangle, RotateCcw, Stamp, Presentation } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import useTranslation from '../../hooks/useTranslation';
import DocumentCanvas from './DocumentCanvas';
import DocumentWorkspacePanel from './DocumentWorkspacePanel';
import DeckOutlineEditor from './DeckOutlineEditor';
import useDocumentText from './useDocumentText';
import {
    getDocument, updateDocument, downloadPdf, downloadPptx, previewDeckDraft, listVersions, restoreVersion, createDocument,
} from './documentsApi';
import { useDocumentsLock } from './documentsLock';
import DocumentsLockNote from './DocumentsLockNote';

const AUTOSAVE_MS = 1500;
// How long after the last keystroke or look change the slides are redrawn.
// The server renders the whole deck each time, so this is deliberately
// slower than the frame's own 400 ms typing debounce for a page.
const DECK_PREVIEW_MS = 450;

/**
 * The document editor: a sheet, a toolbar, and a history drawer.
 *
 * SAVING IS THE WHOLE DESIGN HERE. The canvas hands up `body.innerHTML` on
 * every keystroke (debounced in the frame); this component debounces again and
 * PATCHes. Two debounces is not an accident — the inner one keeps postMessage
 * traffic sane, the outer one keeps the network and the VERSION HISTORY sane,
 * because the server snapshots on every content PATCH and a per-keystroke save
 * would mint a history entry per character.
 *
 * The unsaved-edit flush on unmount matters more than it looks: the common way
 * to leave this screen is clicking Back, which is well inside the autosave
 * window.
 *
 * TWO PLACES, ONE EDITOR. `variant` is the only difference between the Studio
 * page and the right-hand chat panel: the panel closes rather than going back,
 * drops History for width, and offers a jump to the full screen. Forking this
 * into a second component would have meant two autosave implementations, and
 * the one in the panel — where people actually land from a chat link — would
 * have been the copy.
 *
 * A PRESENTATION is the same editor with the sheet swapped for the slide
 * viewer: its body slot is a text OUTLINE, typed in a pane beside the slides
 * ("Edit outline"), and every keystroke or look change is redrawn by the
 * server through POST /:id/preview without being saved — the save is the
 * same debounced autosave a page has. Downloads are the .pptx and the PDF.
 */
export default function DocumentEditor({
    documentId,
    onBack,
    onRenamed,
    variant = 'page',        // 'page' (Studio) | 'panel' (beside the chat)
    onOpenInStudio,
}) {
    const isPanel = variant === 'panel';
    const { t } = useTranslation();
    const d = useDocumentText();
    // Studio Documents is Enterprise (`studio_documents`). Without it the
    // server answers `editable: false`, so this editor is read-only; the line
    // under the tools says why, and that reading and downloading still work.
    const docsLock = useDocumentsLock();
    const [tab, setTab] = useState(null);
    const canvasRef = useRef(null);
    const workspaceRef = useRef(null);
    const writeQueueRef = useRef(Promise.resolve());
    const [panelEpoch,setPanelEpoch] = useState(0);
    const docRef = useRef(null);
    const inFlightRef = useRef(null);
    const [recovery, setRecovery] = useState(null);

    const [doc, setDoc] = useState(null);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState(false);
    const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [downloading, setDownloading] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const [versions, setVersions] = useState([]);
    const [reloadKey, setReloadKey] = useState(0);
    const [slideCount, setSlideCount] = useState(0);
    const [previewError, setPreviewError] = useState('');

    // The newest body the frame has reported but that is not yet persisted.
    const pendingHtmlRef = useRef(null);
    const timerRef = useRef(null);
    const savedTimerRef = useRef(null);

    // The presentation's live preview: the outline as typed and the look as
    // chosen, rendered by the server into the canvas without a save.
    const draftRef = useRef({ bodyHtml: undefined, settings: undefined });
    const previewTimerRef = useRef(null);
    const previewSeqRef = useRef(0);
    const previewAbortRef = useRef(null);
    const isDeck = doc?.docType === 'presentation';
    const previewDraft = useCallback((partial) => {
        if (partial && partial.bodyHtml !== undefined) draftRef.current.bodyHtml = partial.bodyHtml;
        if (partial && partial.settings !== undefined) draftRef.current.settings = partial.settings;
        clearTimeout(previewTimerRef.current);
        previewTimerRef.current = setTimeout(async () => {
            const seq = ++previewSeqRef.current;
            try { previewAbortRef.current?.abort(); } catch { /* none pending */ }
            const ac = typeof AbortController === 'function' ? new AbortController() : null;
            previewAbortRef.current = ac;
            const body = {};
            if (draftRef.current.bodyHtml !== undefined) body.bodyHtml = draftRef.current.bodyHtml;
            if (draftRef.current.settings !== undefined) body.settings = draftRef.current.settings;
            try {
                const html = await previewDeckDraft(documentId, body, { signal: ac ? ac.signal : undefined });
                if (seq !== previewSeqRef.current) return;
                canvasRef.current?.setDraft?.(html);
                setPreviewError('');
            } catch (e) {
                if (e && e.name === 'AbortError') return;
                if (seq === previewSeqRef.current) setPreviewError(e.message || '');
            }
        }, DECK_PREVIEW_MS);
    }, [documentId]);
    useEffect(() => () => { clearTimeout(previewTimerRef.current); try { previewAbortRef.current?.abort(); } catch { /* none */ } }, []);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        getDocument(documentId)
            .then((d) => { if (!cancelled) { setDoc(d); docRef.current = d; if (d && d.docType === 'presentation' && !String(d.bodyHtml || '').trim() && d.editable !== false) setEditing(true); try { setRecovery(sessionStorage.getItem(`document-draft:${documentId}`)); } catch { /* storage unavailable */ } } })
            .catch((e) => { if (!cancelled) setError(e.message); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [documentId]);

    const retainDraft = useCallback((html) => {
        try { sessionStorage.setItem(`document-draft:${documentId}`,html); } catch { /* pending memory copy remains */ }
    },[documentId]);
    const mutate = useCallback(patch => {
        const next=writeQueueRef.current.catch(()=>{}).then(async()=>{
            const saved=await updateDocument(documentId,{...patch,expectedVersionId:patch.expectedVersionId || docRef.current?.versionId});
            if(saved){docRef.current={...docRef.current,...saved};setDoc(docRef.current);}
            return saved;
        });
        writeQueueRef.current=next;return next;
    },[documentId]);
    const flush = useCallback(async () => {
        if (inFlightRef.current) await inFlightRef.current;
        if (pendingHtmlRef.current == null) return;
        const run = async () => {
            while (pendingHtmlRef.current != null) {
                const html = pendingHtmlRef.current;
                pendingHtmlRef.current = null;
                if (html === docRef.current?.bodyHtml) continue;
                setSaveState('saving');
                try {
                    const saved = await mutate({bodyHtml:html});
                    if (saved) { docRef.current = {...docRef.current,...saved}; setDoc(docRef.current); }
                    if (pendingHtmlRef.current == null) { try {sessionStorage.removeItem(`document-draft:${documentId}`);}catch{/* storage unavailable */} }
                    setSaveState('saved');setError('');
                } catch(e) {
                    // A newer keystroke always wins over the failed request's body.
                    if (pendingHtmlRef.current == null) pendingHtmlRef.current = html;
                    retainDraft(pendingHtmlRef.current);setSaveState('error');setError(e.message);throw e;
                }
            }
        };
        inFlightRef.current = run();
        try { await inFlightRef.current; } finally {inFlightRef.current = null;}
    },[documentId,retainDraft,mutate]);
    const handleDirty = useCallback(html => {
        if (docRef.current?.editable === false || html === docRef.current?.bodyHtml) return;
        pendingHtmlRef.current = html;retainDraft(html);setSaveState('saving');
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(()=>flush().catch(()=>{}),AUTOSAVE_MS);
    },[flush,retainDraft]);
    // The outline pane: the same autosave, plus the slides redrawn as typed.
    const handleOutline = useCallback(text => {
        handleDirty(text);
        previewDraft({ bodyHtml: text });
    },[handleDirty,previewDraft]);
    const flushEditor = useCallback(async (allowFailedWrite = false) => {
        await canvasRef.current?.flush();
        clearTimeout(timerRef.current);
        await flush();
        if (allowFailedWrite) await writeQueueRef.current.catch(()=>{});
        else await writeQueueRef.current;
    },[flush]);
    const reload = useCallback(async () => {
        await workspaceRef.current?.flush();
        await flushEditor();
        const latest = await getDocument(documentId);docRef.current=latest;setDoc(latest);setReloadKey(k=>k+1);setPanelEpoch(k=>k+1);
    },[documentId,flushEditor]);
    const savePatch = useCallback(async patch => {
        await flushEditor(true);
        const latest = await mutate(patch);
        if (['bodyHtml','css','settings'].some(key=>Object.hasOwn(patch,key))) {
            // What was drafted is now saved: the reload shows the stored state.
            if (Object.hasOwn(patch,'settings')) draftRef.current.settings = undefined;
            clearTimeout(previewTimerRef.current);
            canvasRef.current?.invalidate?.();setReloadKey(k=>k+1);
        }
        docRef.current={...docRef.current,...latest};setDoc(docRef.current);setSaveState('saved');
        return latest;
    },[mutate,flushEditor]);
    const leave = async () => { try {await workspaceRef.current?.flush();await flushEditor();onBack?.();}catch(e){setError(e.message);} };
    useEffect(()=>()=>{
        clearTimeout(timerRef.current);clearTimeout(savedTimerRef.current);
        if(pendingHtmlRef.current != null) {
            retainDraft(pendingHtmlRef.current);
            // A parent can replace the chat slot without using this editor's
            // Back button. The bridge reports each input immediately, so that
            // final body can still be saved, with recovery retained on failure.
            flush().catch(()=>{});
        }
    },[retainDraft,flush]);

    // And on tab close, for the same reason.
    useEffect(() => {
        const onBeforeUnload = (e) => {
            if (pendingHtmlRef.current == null && !inFlightRef.current) return;
            e.preventDefault();
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, []);

    // The chat can rewrite this document while it is open on screen.
    useEffect(() => {
        const onDocUpdate = (e) => {
            if (!e.detail || e.detail.documentId !== documentId) return;
            // Anything unsaved would be clobbered by the reload, so persist it
            // first — the model's edit and the user's edit both survive, and
            // the version history has both as separate entries.
            reload().catch(e=>setError(e.message));
        };
        window.addEventListener('beeflow:document-updated', onDocUpdate);
        return () => window.removeEventListener('beeflow:document-updated', onDocUpdate);
    }, [documentId, reload]);

    const handleDownload = async (format = 'pdf') => {
        setDownloading(true);
        setError('');
        setNotice('');
        try {
            // Persist first: downloading a PDF that is missing the sentence you
            // just typed is the bug people never report and always notice.
            await workspaceRef.current?.flush();
            await flushEditor();
            const download = format === 'pptx' ? downloadPptx : downloadPdf;
            const { degraded } = await download(documentId, docRef.current?.name, docRef.current?.versionId);
            if (degraded) {
                setNotice(t(
                    'documents.pdf_degraded',
                    'The PDF was made without the rendering container, so its layout is plainer than the screen.',
                ));
            }
        } catch (e) {
            setError(e.message || (format === 'pptx' ? t('documents.pptx_failed', 'Could not build the presentation.') : t('documents.pdf_failed', 'Could not render the PDF.')));
        } finally {
            setDownloading(false);
        }
    };

    const openHistory = async () => {
        setShowHistory((v) => !v);
        if (showHistory) return;
        try {
            setVersions(await listVersions(documentId));
        } catch (e) {
            setError(e.message);
        }
    };

    const handleRestore = async (versionId) => {
        try {
            await workspaceRef.current?.flush();
            await flushEditor();
            const restored = await restoreVersion(documentId, versionId, docRef.current?.versionId);
            docRef.current = restored;
            setPanelEpoch(k=>k+1);
            setDoc(restored);
            pendingHtmlRef.current = null;
            setReloadKey((k) => k + 1);
            setVersions(await listVersions(documentId));
        } catch (e) {
            setError(e.message);
        }
    };

    // The per-document opt-out. `settings.houseStyle === false` is the only
    // value that means "no"; an ABSENT key means nobody decided, which reads as
    // yes. Turning it back on explicitly captures the current house style.
    const usesHouseStyle = doc?.settings?.houseStyle !== false;

    const toggleHouseStyle = async () => {
        const next = !usesHouseStyle;
        try {
            await workspaceRef.current?.flush();
            // Merge, never replace: settings is a wholesale column and other
            // keys live in it.
            const updated = await savePatch({
                settings: { ...(docRef.current?.settings || {}), houseStyle: next },
            });
            setDoc(updated);
            setPanelEpoch(k=>k+1);
        } catch (e) {
            setError(e.message);
        }
    };

    const handleRename = async (name) => {
        const trimmed = (name || '').trim();
        if (!trimmed || trimmed === doc?.name) return;
        try {
            const updated = await savePatch({ name: trimmed });
            setDoc(updated);
            onRenamed?.(updated);
        } catch (e) {
            setError(e.message);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full">
                <Loader2 className="animate-spin" size={22} style={{ color: 'var(--accent-primary)' }} />
            </div>
        );
    }

    if (!doc) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-3">
                <p style={{ color: 'var(--text-muted)' }}>{error || t('documents.not_found', 'Document not found.')}</p>
                <button onClick={onBack} className="text-sm underline" style={{ color: 'var(--accent-primary)' }}>
                    {isPanel ? t('documents.close', 'Close') : t('documents.back', 'Back to Documents')}
                </button>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full" style={{ background: 'var(--bg-primary)' }}>
            {/* ── Toolbar ── */}
            <div
                className="flex flex-wrap items-center gap-2 px-4 py-2.5 shrink-0"
                style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)' }}
            >
                <button
                    onClick={leave}
                    className="p-1.5 rounded-lg hover:opacity-80 shrink-0"
                    aria-label={isPanel ? t('documents.close', 'Close') : t('documents.back', 'Back to Documents')}
                    style={{ color: 'var(--text-muted)' }}
                >
                    {isPanel ? <X size={17} /> : <ArrowLeft size={17} />}
                </button>

                <input
                    key={doc.name}
                    disabled={doc.editable === false}
                    defaultValue={doc.name}
                    onBlur={(e) => handleRename(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    aria-label={t('documents.name', 'Document name')}
                    className="flex-1 min-w-0 bg-transparent text-sm font-semibold px-1.5 py-1 rounded outline-none focus:ring-1"
                    style={{ color: 'var(--text-primary)' }}
                />

                <SaveIndicator state={saveState} t={t} />

                <button
                    disabled={doc.editable === false}
                    onClick={() => setEditing((v) => !v)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium shrink-0"
                    style={editing
                        ? { background: 'var(--accent-primary)', color: '#fff' }
                        : { background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                    data-testid="document-edit-toggle"
                >
                    {editing ? <Eye size={14} /> : <Pencil size={14} />}
                    {editing ? t('documents.done_editing', 'Done') : (isDeck ? t('documents.edit_outline', 'Edit outline') : t('documents.edit', 'Edit text'))}
                </button>

                <button
                    onClick={toggleHouseStyle}
                    disabled={doc.editable === false}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium shrink-0"
                    style={usesHouseStyle
                        ? { background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }
                        : { background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}
                    title={usesHouseStyle
                        ? t('documents.house_style_on_hint', 'This document uses the organisation\'s house style. Click to turn it off for this document only.')
                        : t('documents.house_style_off_hint', 'This document ignores the house style. Click to turn it back on.')}
                    data-testid="document-house-style-toggle"
                    data-on={String(usesHouseStyle)}
                >
                    <Stamp size={14} />
                    {usesHouseStyle
                        ? t('documents.house_style_on', 'House style')
                        : t('documents.house_style_off', 'No house style')}
                </button>

                {!isPanel && (
                    <button
                        onClick={openHistory}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium shrink-0"
                        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                    >
                        <History size={14} />
                        {t('documents.history', 'History')}
                    </button>
                )}

                {isPanel && onOpenInStudio && (
                    <button
                        onClick={async () => { try { await workspaceRef.current?.flush(); await flushEditor(); onOpenInStudio(documentId); } catch (e) { setError(e.message); } }}
                        className="p-1.5 rounded-lg hover:opacity-80 shrink-0"
                        aria-label={t('documents.open_in_studio', 'Open in Studio')}
                        title={t('documents.open_in_studio', 'Open in Studio')}
                        style={{ color: 'var(--text-muted)' }}
                        data-testid="document-open-in-studio"
                    >
                        <Maximize2 size={15} />
                    </button>
                )}

                {isDeck && (
                    <button
                        onClick={() => handleDownload('pptx')}
                        disabled={downloading}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0 disabled:opacity-60"
                        style={{ background: 'var(--accent-primary)', color: '#fff' }}
                        data-testid="document-download-pptx"
                    >
                        {downloading ? <Loader2 size={14} className="animate-spin" /> : <Presentation size={14} />}
                        {t('documents.download_pptx', 'Download PowerPoint')}
                    </button>
                )}
                <button
                    onClick={() => handleDownload('pdf')}
                    disabled={downloading}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0 disabled:opacity-60"
                    style={isDeck ? { background: 'var(--bg-tertiary)', color: 'var(--text-primary)' } : { background: 'var(--accent-primary)', color: '#fff' }}
                    data-testid="document-download-pdf"
                >
                    {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                    {isDeck ? t('documents.download_pdf_short', 'PDF') : t('documents.download_pdf', 'Download PDF')}
                </button>
            </div>

            <nav className="flex flex-wrap items-center gap-1 px-4 py-2 border-b border-[var(--border-subtle)]" aria-label={d('Document tools','Documentgereedschap')}>
                {(isDeck
                    ? [['design',d('Look','Uiterlijk')],['parameters',d('Parameters','Parameters')],['preview',d('Customer preview','Klantvoorbeeld')],['assistant',d('AI assistant','AI-assistent')]]
                    : [['parameters',d('Parameters','Parameters')],['sections',d('Sections','Onderdelen')],['design',d('Design','Vormgeving')],['preview',d('Customer preview','Klantvoorbeeld')],['assistant',d('AI assistant','AI-assistent')]]
                ).map(([key,label])=><button key={key} aria-pressed={tab===key} className={'text-xs rounded px-3 py-1.5 '+(tab===key?'bg-[var(--bg-tertiary)] font-semibold':'')} onClick={async()=>{try{await workspaceRef.current?.flush();setTab(tab===key?null:key);}catch(e){setError(e.message);}}}>{label}</button>)}
                {isDeck && slideCount > 0 && <span className="ml-auto text-xs" style={{ color: 'var(--text-muted)' }} data-testid="document-slide-count">{t('documents.slides_count', '{count} slides').replace('{count}', String(slideCount))}</span>}
            </nav>
            <DocumentsLockNote reason={docsLock} d={d} className="px-4 py-2 text-xs shrink-0 border-b border-[var(--border-subtle)]" />
            {recovery && <div className="px-4 py-2 text-sm bg-amber-500/10"><span>{d('An unsaved draft was recovered.','Een niet-opgeslagen concept is teruggevonden.')}</span> <button className="underline" onClick={async()=>{try{await createDocument({...doc,name:doc.name+' — recovered',bodyHtml:recovery,visibility:'private',kind:'document'});sessionStorage.removeItem(`document-draft:${documentId}`);setRecovery(null);}catch(e){setError(e.message);}}}>{d('Save recovered copy','Herstelde kopie opslaan')}</button></div>}
            {saveState==='error' && <div className="px-4 py-2 flex gap-3 text-xs"><button className="underline" onClick={()=>flush().catch(()=>{})}>{d('Retry save','Opslaan opnieuw proberen')}</button><button className="underline" onClick={()=>setRecovery(pendingHtmlRef.current)}>{d('Recover as a copy','Als kopie herstellen')}</button></div>}
            {(error || notice) && (
                <div
                    className="flex items-start gap-2 px-4 py-2 text-xs shrink-0"
                    style={{
                        background: error ? 'rgba(220,38,38,.08)' : 'rgba(234,179,8,.10)',
                        color: 'var(--text-primary)',
                        borderBottom: '1px solid var(--border-subtle)',
                    }}
                    role="status"
                >
                    <AlertTriangle size={14} className="mt-px shrink-0" />
                    <span className="flex-1">{error || notice}</span>
                    <button onClick={() => { setError(''); setNotice(''); }} className="underline shrink-0">
                        {t('documents.dismiss', 'Dismiss')}
                    </button>
                </div>
            )}

            {editing && (
                <div
                    className="px-4 py-1.5 text-xs shrink-0"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
                >
                    {isDeck
                        ? t('documents.outline_hint', 'Type the outline on the left — one "## " heading per slide. The slides redraw as you type.')
                        : t('documents.edit_hint', 'Click any text in the document and type. Pasted text arrives as plain text so the layout survives.')}
                    {isDeck && previewError && <span className="ml-2" style={{ color: 'var(--danger, #dc2626)' }} data-testid="document-preview-error">{previewError}</span>}
                </div>
            )}

            {/* ── Sheet + history ── */}
            {/* Beside the chat a presentation stacks (outline above the slides): the
                panel is too narrow for two columns and the slides would shrink to stamps. */}
            <div className={`flex-1 min-h-0 flex ${isPanel && isDeck ? 'flex-col' : 'flex-col sm:flex-row'}`}>
                {isDeck && editing && (
                    <div className={`${isPanel ? 'h-2/5 w-full' : 'h-2/5 sm:h-auto sm:w-[38%]'} min-w-0 min-h-0 shrink-0`} style={{ borderRight: '1px solid var(--border-subtle)', borderBottom: '1px solid var(--border-subtle)' }} data-testid="deck-outline-pane">
                        <DeckOutlineEditor value={doc.bodyHtml} epoch={`${reloadKey}:${panelEpoch}`} onChange={handleOutline} disabled={doc.editable === false} />
                    </div>
                )}
                <div className="flex-1 min-w-0 min-h-0">
                    <DocumentCanvas
                        ref={canvasRef}
                        documentId={documentId}
                        editing={editing && !isDeck}
                        reloadKey={reloadKey}
                        onDirty={handleDirty}
                        onError={setError}
                        onDeckReady={setSlideCount}
                        t={t}
                    />
                </div>

                {tab && <DocumentWorkspacePanel ref={workspaceRef} key={documentId+':'+panelEpoch} doc={doc} tab={tab} onSave={savePatch} onPreviewDraft={isDeck ? previewDraft : undefined} onInsert={key=>{setEditing(true);if(!isDeck)canvasRef.current?.insert(key);}} onSection={id=>canvasRef.current?.section(id)} onBeforeAction={flushEditor} onRefresh={()=>reload().catch(e=>setError(e.message))}/>}
                {showHistory && (
                    <aside
                        className="w-64 shrink-0 overflow-y-auto"
                        style={{ borderLeft: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)' }}
                    >
                        <h2 className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                            {t('documents.history', 'History')}
                        </h2>
                        {versions.length === 0 && (
                            <p className="px-3 pb-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                                {t('documents.history_empty', 'No earlier versions yet.')}
                            </p>
                        )}
                        <ul>
                            {versions.map((v) => (
                                <li key={v.id} className="px-3 py-2 flex items-start gap-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                                            {v.summary || t('documents.version', 'Version')}
                                        </p>
                                        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                            {new Date(v.createdAt).toLocaleString()}
                                        </p>
                                    </div>
                                    {doc.editable !== false && <button
                                        onClick={() => handleRestore(v.id)}
                                        className="p-1 rounded hover:opacity-80 shrink-0"
                                        aria-label={t('documents.restore', 'Restore this version')}
                                        title={t('documents.restore', 'Restore this version')}
                                        style={{ color: 'var(--text-muted)' }}
                                    >
                                        <RotateCcw size={13} />
                                    </button>}
                                </li>
                            ))}
                        </ul>
                    </aside>
                )}
            </div>
        </div>
    );
}

function SaveIndicator({ state, t }) {
    if (state === 'idle') return <span className="w-16 shrink-0" />;
    const map = {
        saving: { icon: <Loader2 size={12} className="animate-spin" />, label: t('documents.saving', 'Saving…') },
        saved: { icon: <Check size={12} />, label: t('documents.saved', 'Saved') },
        error: { icon: <AlertTriangle size={12} />, label: t('documents.save_error', 'Not saved') },
    };
    const it = map[state];
    return (
        <span
            className="inline-flex items-center gap-1 text-[11px] shrink-0"
            style={{ color: state === 'error' ? 'var(--danger, #dc2626)' : 'var(--text-muted)' }}
            data-testid="document-save-state"
            data-state={state}
        >
            {it.icon}{it.label}
        </span>
    );
}
