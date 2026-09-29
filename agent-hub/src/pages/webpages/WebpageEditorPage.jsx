import { AlertCircle, X } from 'lucide-react';
import React, { useState, useEffect, useEffectEvent, useCallback, useRef, useMemo } from 'react';
import useWebpageSave, { useWebpageChatPersistence } from './hooks/useWebpageSave';
import SaveStatus from './SaveStatus';
import WebpageDataTab from './WebpageDataTab';
import WebpageEditorHeader from './WebpageEditorHeader';
import WebpageHistoryTab from './WebpageHistoryTab';
import WebpageIDE from './WebpageIDE';
import WebpagePreview from './WebpagePreview';
import { api, fetchExtraContent } from './webpagesApi';
import { sharingRefusalText, useWebpageSharingLock } from './webpageSharingLock';
import WebpageSharingLockNote from './WebpageSharingLockNote';
import WebpageUsedByTab from './WebpageUsedByTab';
import ExternalShareSection from '../../components/agents/AgentWizard/pickers/ExternalShareSection';
import ShareLinksMenu from '../../components/agents/AgentWizard/pickers/ShareLinksMenu';
import useChatEngine from '../../hooks/useChatEngine';
import useTranslation from '../../hooks/useTranslation';
import computeWebpageDiff from '../../utils/computeWebpageDiff';
import downloadWebpageZip from '../../utils/downloadWebpageZip';
import { API_BASE, authFetch } from '../../utils/helpers';
import { resizeImageForUpload } from '../../utils/imageResize';
import scopedStorage from '../../utils/scopedStorage';

// Map an (possibly resize-converted) MIME type back to a file extension so the
// stored asset path matches its bytes — the server derives MIME from the path.
function extForMime(mime, name) {
    const map = {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
        'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
        'font/woff': 'woff', 'font/woff2': 'woff2', 'font/ttf': 'ttf', 'font/otf': 'otf',
        'audio/mpeg': 'mp3', 'video/mp4': 'mp4', 'video/webm': 'webm', 'application/pdf': 'pdf',
    };
    if (map[mime]) return map[mime];
    const fromName = (name.split('.').pop() || '').toLowerCase();
    return /^[a-z0-9]{1,5}$/.test(fromName) ? fromName : 'bin';
}

const CHAT_MODES = ['ask', 'auto', 'plan'];

/**
 * Sections a viewer never reaches. Not cosmetic: `GET /:id/versions` and every
 * save are owner-scoped and answer 404 to anyone else, so offering these would
 * be offering an action the screen cannot carry out.
 */
const OWNER_ONLY_TABS = ['code', 'history'];

/**
 * WebpageEditorPage — one open webpage (Track W0 split of pages/WebpagesPage.jsx).
 *
 * Mounted by the shell with `key={loaded.webpage.id}`, so every page gets a
 * fresh instance: content state, chat engine, save discipline and the
 * page-scoped AbortController all start from the loaded bundle and end at
 * unmount. That is the page-switch guard — a handler that outlives its page
 * finds `mountedRef` false and its controller aborted.
 *
 * Props
 *   loaded          { webpage, sources, files:{html,css,js}, chatMessages,
 *                     extraFiles, extraContents }  (see webpagesApi.fetchWebpageBundle)
 *   user            current user (owner gate: IDE toggle, publish, file management)
 *   orgGroups       groups for the visibility capsule
 *   modelTiers / selectedTier / onTierChange   chat model tier (shell-owned so
 *                   it survives opening another page)
 *   initialEditMode open in the IDE (true) or the read-only preview (false)
 *   onClose()       back to the list — the shell flushes via `flushRef` first
 *   onSaved(id)     a save landed (shell bumps the row's updatedAt)
 *   onMetaChange(id, patch)  visibility / settings changed (shell patches the row)
 *   flushRef        ref the shell uses to flush pending edits before unmount
 */
export default function WebpageEditorPage({
    loaded,
    user,
    orgGroups = [],
    modelTiers = {},
    selectedTier = 'fast',
    onTierChange,
    initialEditMode = false,
    onClose,
    onSaved,
    onMetaChange,
    flushRef,
}) {
    const pageId = loaded.webpage.id;
    const [page, setPage] = useState(loaded.webpage);
    const isOwner = page.userId === user?.id;
    const { t } = useTranslation();
    // Sharing this page beyond its owner is Enterprise (`webpage_sharing`).
    // Null when it is not locked, or while the answer is not in yet.
    const sharingLock = useWebpageSharingLock();
    /* ── The five sections (plan W2) ──────────────────────────────
     * One `activeTab` replaced three booleans that used to disagree with each
     * other (`viewMode`, the IDE's own `devMode`, and the overlay flag the
     * version list used to carry — W4 removed that last one). The IDE
     * keeps its internal state as the default, but while a tab is driving it
     * the tab wins — see the controlled props below.
     *   preview  the sandboxed iframe alone
     *   data     links / sources / database
     *   code     the IDE, developer view on
     *   history  de versielijst — sinds W4 een gewoon oppervlak, niet meer een
     *            overlay bovenop de tab waar je stond (WebpageHistoryTab)
     *   usedby   what depends on this page — an honest "we cannot tell yet"
     */
    // A viewer never opens in the code editor: Code and History are owner-only
    // (both server surfaces behind them answer 404 to anyone else), and the
    // header does not offer them either.
    const [activeTab, setActiveTab] = useState(initialEditMode && isOwner ? 'code' : 'preview');
    const viewMode = activeTab === 'preview';
    const [publishMenuOpen, setPublishMenuOpen] = useState(false);
    const [publishBusy, setPublishBusy] = useState(false);
    const [sources, setSources] = useState(loaded.sources);
    const [error, setError] = useState(null);

    const [html, setHtml] = useState(loaded.files.html);
    const [css, setCss] = useState(loaded.files.css);
    const [js, setJs] = useState(loaded.files.js);

    // Extra files (multi-file projects) — array of file metadata, plus a map
    // of path → content for text files / dataUrl for binaries. Hydrated from
    // the bundle and kept in sync via webpage_extra_update / _deleted SSE events.
    const [extraFiles, setExtraFiles] = useState(loaded.extraFiles);
    const [extraContents, setExtraContents] = useState(loaded.extraContents);
    const extraContentsRef = useRef(loaded.extraContents);
    useEffect(() => { extraContentsRef.current = extraContents; }, [extraContents]);

    // Page-scope guards. `mountedRef` is what makes a late response harmless;
    // the AbortController cancels outstanding page-scoped mutations (uploads,
    // file create/delete/rename) when this page is left.
    const mountedRef = useRef(true);
    const inflightAbortRef = useRef(null);
    // The hidden file input the header's "Add image" drives (the button moved
    // out of the IDE toolbar in W2; the input moved with it).
    const headerUploadRef = useRef(null);
    useEffect(() => {
        mountedRef.current = true;
        inflightAbortRef.current = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        return () => {
            mountedRef.current = false;
            try { inflightAbortRef.current?.abort(); } catch { /* ignore */ }
        };
    }, []);
    // Page-scoped guard: ignore an async result whose webpage is no longer the
    // one loaded (the user switched away), so a late response can't mutate the
    // wrong page's state or resurrect a deleted file. Aborted requests are
    // silent (the switch cancelled them on purpose).
    const isStillCurrent = useCallback((targetId) => mountedRef.current && targetId === pageId, [pageId]);
    const reportHandlerError = useCallback((targetId, err) => {
        if (err?.name === 'AbortError') return;
        if (isStillCurrent(targetId)) setError(err.message);
    }, [isStillCurrent]);

    /* ── Save discipline ─────────────────────────────────────── */
    const save = useWebpageSave({
        webpageId: pageId,
        html, css, js,
        extraContentsRef,
        api,
        onSaved,
    });
    const { saveState, lastSavedAt, dirtyFiles, contentRef, flushNow, persist } = save;

    // Let the shell flush the OUTGOING page before it unmounts this editor.
    useEffect(() => {
        if (!flushRef) return undefined;
        flushRef.current = flushNow;
        return () => { if (flushRef.current === flushNow) flushRef.current = null; };
    }, [flushRef, flushNow]);

    /* ── Chat mode (ask / auto / plan) — persisted per user ─── */
    const [chatMode, setChatMode] = useState(() => {
        try {
            const stored = scopedStorage.getItem('webpages_chat_mode');
            return CHAT_MODES.includes(stored) ? stored : 'auto';
        } catch { return 'auto'; }
    });
    const handleChatModeChange = useCallback((mode) => {
        if (!CHAT_MODES.includes(mode)) return;
        setChatMode(mode);
        try { scopedStorage.setItem('webpages_chat_mode', mode); } catch {}
    }, []);

    /* ── Chat engine wiring ──────────────────────────────────── */
    // Ref bridge so the SSE callback (closed over once at hook init) can call
    // the latest setChatMessages without recreating the callback every render.
    const setChatMessagesRef = useRef(null);

    // Plan approval state — set when the user clicks "Approve & build" on a
    // plan card; read by getExtraPayload so the next chat send carries the
    // planExecution authorisation. Cleared after the round-trip starts.
    const [pendingPlanExecution, setPendingPlanExecution] = useState(null);

    // Preview-iframe selection chip — set when the user highlights rendered
    // content in the preview. Surfaces above the chat input as a removable
    // pill. On send, getExtraPayload converts it into the server's existing
    // `webpageSelection: { text, file, action? }` contract. Single-shot —
    // cleared automatically after the send.
    const [attachedSelection, setAttachedSelection] = useState(null);

    /* ── Per-turn undo (plan W2) ─────────────────────────────────
     * The bytes that were on screen before an assistant turn edited a file,
     * kept in a REF keyed by assistant-message id — deliberately not in the
     * message itself. Chat messages are PUT back to the server on every
     * settled turn, and a full copy of index.html per turn would grow that
     * row without bound. The cost of the ref is honest and visible: after a
     * reload there is no before-state, so the Undo chip is not offered at all
     * (WebpageTurnCard renders it only when `canUndo`).
     */
    const undoSnapshotsRef = useRef(new Map());
    const latestAssistantIdRef = useRef(null);
    // Turns the user has resolved: kept (chips dismissed) or undone.
    const [turnResolution, setTurnResolution] = useState({});
    const handleSelectionAttach = useCallback((selection) => {
        if (!selection || !selection.text) return;
        setAttachedSelection({
            text: selection.text,
            tagName: selection.tagName || null,
            className: selection.className || null,
            elementId: selection.elementId || null,
        });
    }, []);
    const handleSelectionClear = useCallback(() => setAttachedSelection(null), []);

    const { messages: chatMessages, setMessages: setChatMessages, isLoading: chatLoading,
        sendMessage: sendChatMessage, stopGenerating: stopChatGenerating,
        retryMessage: retryChatMessage, editAndRegenerate: editAndRegenerateChat,
    } = useChatEngine({
        selectedAgent: null,
        currentConversation: null,
        onConversationCreated: useCallback(() => {}, []),
        getNotebookPayload: useCallback(() => ({}), []),
        onNotebookUpdate: useCallback(() => {}, []),
        directMode: useMemo(() => ({
            enabled: true,
            modelTier: selectedTier,
            customEndpoint: '/ai/chat/webpage/stream',
            getExtraPayload: () => {
                const base = {
                    webpageId: pageId,
                    htmlContent: html,
                    cssContent: css,
                    jsContent: js,
                    chatMode,
                };
                if (pendingPlanExecution) {
                    base.planExecution = pendingPlanExecution;
                }
                if (attachedSelection) {
                    // The server's webpageSelection contract expects { text, file, action? }.
                    // Preview-iframe selections come from rendered HTML, so we tag
                    // file='html' and let the AI find the matching source there.
                    base.webpageSelection = {
                        text: attachedSelection.text,
                        file: 'html',
                    };
                }
                return base;
            },
        }), [selectedTier, pageId, html, css, js, chatMode, pendingPlanExecution, attachedSelection]),
        onDirectConversationCreated: useCallback(() => {}, []),
        // Webpage-specific SSE events — useChatEngine forwards them via these callbacks.
        onWebpageDocUpdate: useCallback((data) => {
            const { file, content, title } = data || {};
            if (!file) return;
            const next = content || '';

            // Capture before-state from the live content ref so the diff is
            // computed against exactly what was on screen when the SSE arrived.
            const before = file === 'html' ? contentRef.current.html
                         : file === 'css'  ? contentRef.current.css
                         : file === 'js'   ? contentRef.current.js
                         : '';

            const diff = computeWebpageDiff(before, next);

            // Remember the FIRST before-state per file per turn: a turn that
            // rewrites index.html three times must undo to what was on screen
            // when the turn started, not to its own second draft.
            const turnId = latestAssistantIdRef.current;
            if (turnId && diff.summary !== 'no change') {
                const map = undoSnapshotsRef.current;
                const entry = map.get(turnId) || new Map();
                if (!entry.has(file)) entry.set(file, before);
                map.set(turnId, entry);
            }

            // Apply the change to editor state.
            if (file === 'html') setHtml(next);
            else if (file === 'css') setCss(next);
            else if (file === 'js') setJs(next);

            // Attach a diff entry to the most recent assistant message so the
            // chat panel can render a diff card below the AI's reply.
            const updateMessages = setChatMessagesRef.current;
            if (typeof updateMessages === 'function' && diff.summary !== 'no change') {
                updateMessages(prev => {
                    if (!prev || prev.length === 0) return prev;
                    // Find latest assistant message (walk from end)
                    for (let i = prev.length - 1; i >= 0; i--) {
                        if (prev[i].role === 'assistant') {
                            const msg = prev[i];
                            const edits = Array.isArray(msg.webpageEdits) ? msg.webpageEdits : [];
                            return [
                                ...prev.slice(0, i),
                                { ...msg, webpageEdits: [...edits, { file, title: title || file, diff }] },
                                ...prev.slice(i + 1),
                            ];
                        }
                    }
                    return prev;
                });
            }
        }, [contentRef]),
        onWebpageSourceAdded: useCallback((source) => {
            setSources(prev => [...prev, source]);
        }, []),
        // Multi-file: a tool just created or updated an extra file. Refetch
        // its content so the preview can inline it. Update the metadata list.
        onWebpageExtraUpdate: useCallback(async (data) => {
            const { path, meta } = data || {};
            if (!path) return;
            const targetId = pageId;
            setExtraFiles(prev => {
                const idx = prev.findIndex(f => f.path === path);
                if (idx >= 0) {
                    const next = [...prev];
                    next[idx] = { ...prev[idx], ...meta };
                    return next;
                }
                return [...prev, meta];
            });
            try {
                const entry = await fetchExtraContent(targetId, { path, mimeType: meta?.mimeType });
                // Drop the fetched content if the user switched pages meanwhile.
                if (!isStillCurrent(targetId)) return;
                setExtraContents(prev => ({ ...prev, [path]: entry }));
            } catch { /* ignore single-file fetch failures */ }
        }, [pageId, isStillCurrent]),
        onWebpageExtraDeleted: useCallback((data) => {
            const path = data?.path;
            if (!path) return;
            setExtraFiles(prev => prev.filter(f => f.path !== path));
            setExtraContents(prev => {
                const next = { ...prev };
                delete next[path];
                return next;
            });
        }, []),
    });

    // Bind the ref so the SSE callback above can mutate the chat-message list.
    setChatMessagesRef.current = setChatMessages;

    /* ── Chat persistence ────────────────────────────────────── */
    const chatPersistence = useWebpageChatPersistence({
        webpageId: pageId, chatMessages, chatLoading, api,
    });
    const { markSaved: markChatSaved, clearOnServer: clearChatOnServer } = chatPersistence;

    // Restore the per-webpage chat history so the user keeps context across
    // refreshes. Marked "saved" first so the debounced effect sees no change.
    const restoreChat = useEffectEvent(() => {
        markChatSaved(loaded.chatMessages);
        setChatMessages(loaded.chatMessages);
    });
    useEffect(() => { restoreChat(); }, []);

    /* ── Plan approval handlers ─────────────────────────────── */
    const handlePlanApprove = useCallback((planId) => {
        if (!planId) return;
        // Flip the matching plan card to approved status
        setChatMessages(prev => prev.map(m => (
            m.webpagePlan && m.webpagePlan.planId === planId
                ? { ...m, webpagePlan: { ...m.webpagePlan, status: 'approved' } }
                : m
        )));
        // Stage the planExecution payload for the next chat send and trigger it.
        setPendingPlanExecution({ planId, action: 'execute' });
        // Defer to the next tick so React has flushed the pendingPlanExecution
        // state before getExtraPayload reads it.
        setTimeout(() => {
            sendChatMessage('Approved — please build the plan.', []);
            // Clear the staging state once the request has been kicked off; the
            // server has already received it, and we don't want it to leak
            // into the next user turn.
            setTimeout(() => setPendingPlanExecution(null), 100);
        }, 0);
    }, [sendChatMessage, setChatMessages]);

    const handlePlanReject = useCallback((planId) => {
        if (!planId) return;
        setChatMessages(prev => prev.map(m => (
            m.webpagePlan && m.webpagePlan.planId === planId
                ? { ...m, webpagePlan: { ...m.webpagePlan, status: 'rejected' } }
                : m
        )));
    }, [setChatMessages]);

    // After a build round-trip finishes (chat goes idle), flip any plan card
    // currently in "approved" state to "executed" so the user sees the ✓.
    useEffect(() => {
        if (chatLoading) return;
        setChatMessages(prev => {
            let changed = false;
            const next = prev.map(m => {
                if (m.webpagePlan && m.webpagePlan.status === 'approved') {
                    changed = true;
                    return { ...m, webpagePlan: { ...m.webpagePlan, status: 'executed' } };
                }
                return m;
            });
            return changed ? next : prev;
        });
    }, [chatLoading, setChatMessages]);

    // Live framework/runtime switches from the AI (emitted as SSE → DOM events by
    // useChatEngine). Update the page's settings so the preview recomposes into
    // the new mode (e.g. vanilla → react-mui) without a reload.
    const pageRef = useRef(page);
    useEffect(() => { pageRef.current = page; }, [page]);
    const patchSettings = useCallback((patch) => {
        const settings = { ...(pageRef.current?.settings || {}), ...patch };
        setPage(prev => ({ ...prev, settings }));
        onMetaChange?.(pageId, { settings });
    }, [onMetaChange, pageId]);
    useEffect(() => {
        const onFramework = (e) => {
            const framework = e?.detail?.framework;
            if (framework) patchSettings({ framework });
        };
        const onRuntime = (e) => {
            const runtime = e?.detail?.runtime;
            if (runtime) patchSettings({ runtime });
        };
        window.addEventListener('webpage_framework_changed', onFramework);
        window.addEventListener('webpage_runtime_changed', onRuntime);
        return () => {
            window.removeEventListener('webpage_framework_changed', onFramework);
            window.removeEventListener('webpage_runtime_changed', onRuntime);
        };
    }, [patchSettings]);

    /* ── Manual edits ────────────────────────────────────────── */
    // Mark a primary slot dirty when the user types into Monaco. SSE-driven
    // updates (AI edits via setHtml/setCss/setJs from chat events) bypass
    // these so they don't mistakenly mark already-saved content as dirty.
    const { markPrimaryDirty, markExtraDirty, acceptServerSnapshot } = save;
    const handleHtmlEdit = useCallback((v) => { setHtml(v); markPrimaryDirty('html'); }, [markPrimaryDirty]);
    const handleCssEdit = useCallback((v) => { setCss(v); markPrimaryDirty('css'); }, [markPrimaryDirty]);
    const handleJsEdit = useCallback((v) => { setJs(v); markPrimaryDirty('js'); }, [markPrimaryDirty]);

    // User-initiated edit of an extra text file. Updates local state for the
    // preview to re-compose, marks the path dirty, and schedules a save.
    // SSE-driven updates from the AI hit setExtraContents directly and do NOT
    // call this — they're already persisted server-side.
    /* ── The chat's per-turn chips (plan W2) ─────────────────── */
    // Which assistant message an incoming edit belongs to. Kept in a ref so
    // the SSE callback (created once) always sees the current turn without
    // being rebuilt on every message.
    useEffect(() => {
        for (let i = chatMessages.length - 1; i >= 0; i--) {
            if (chatMessages[i].role === 'assistant') {
                latestAssistantIdRef.current = chatMessages[i].id;
                return;
            }
        }
        latestAssistantIdRef.current = null;
    }, [chatMessages]);

    const turnState = useCallback((msgId) => ({
        // Offer Undo only while the bytes to restore are really held.
        canUndo: !!msgId && undoSnapshotsRef.current.has(msgId),
        undone: turnResolution[msgId] === 'undone',
        kept: turnResolution[msgId] === 'kept',
    }), [turnResolution]);

    const handleKeepTurn = useCallback((msgId) => {
        if (!msgId) return;
        // Keeping is a dismissal, not a save: the edit was already persisted
        // by the normal save discipline the moment it landed.
        undoSnapshotsRef.current.delete(msgId);
        setTurnResolution(prev => ({ ...prev, [msgId]: 'kept' }));
    }, []);

    const handleUndoTurn = useCallback((msgId) => {
        const entry = msgId && undoSnapshotsRef.current.get(msgId);
        if (!entry) return;
        const setters = { html: setHtml, css: setCss, js: setJs };
        for (const [file, before] of entry.entries()) {
            const set = setters[file];
            if (!set) continue;
            set(before ?? '');
            // Same path a human edit takes, so the restore is saved by the
            // ordinary debounce instead of living only on screen.
            markPrimaryDirty(file);
        }
        undoSnapshotsRef.current.delete(msgId);
        setTurnResolution(prev => ({ ...prev, [msgId]: 'undone' }));
    }, [markPrimaryDirty]);

    // "Change in code": open the Code section on the file the turn touched.
    const [focusFile, setFocusFile] = useState(null);
    const handleShowInCode = useCallback((file) => {
        setActiveTab('code');
        if (file) setFocusFile({ key: file, at: Date.now() });
    }, []);

    const handleExtraChange = useCallback((path, newContent) => {
        setExtraContents(prev => {
            const existing = prev[path];
            if (!existing || !existing.isText) return prev;
            if (existing.content === newContent) return prev;
            return { ...prev, [path]: { ...existing, content: newContent } };
        });
        markExtraDirty(path);
    }, [markExtraDirty]);

    /* ── Manual file / asset management (owner-only; mirrors the AI tools) ── */

    // Merge an extra-file meta + content entry into local state (shared by the
    // create/upload/rename handlers; same shape as the onWebpageExtraUpdate SSE).
    const mergeExtra = useCallback((meta, contentEntry) => {
        setExtraFiles(prev => {
            const idx = prev.findIndex(f => f.path === meta.path);
            if (idx >= 0) { const next = [...prev]; next[idx] = { ...prev[idx], ...meta }; return next; }
            return [...prev, meta];
        });
        if (contentEntry) setExtraContents(prev => ({ ...prev, [meta.path]: contentEntry }));
    }, []);

    const handleCreateFile = useCallback(async (path) => {
        if (!path) return;
        const targetId = pageId;
        try {
            const r = await api(`/${targetId}/files`, { method: 'PUT', body: JSON.stringify({ path, content: '' }), signal: inflightAbortRef.current?.signal });
            if (!isStillCurrent(targetId)) return;
            mergeExtra(r.file, { mimeType: r.file.mimeType, isText: true, content: '' });
        } catch (err) { reportHandlerError(targetId, err); }
    }, [pageId, mergeExtra, isStillCurrent, reportHandlerError]);

    const handleDeleteFile = useCallback(async (path) => {
        if (!path) return;
        const targetId = pageId;
        try {
            await api(`/${targetId}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE', signal: inflightAbortRef.current?.signal });
            if (!isStillCurrent(targetId)) return;
            setExtraFiles(prev => prev.filter(f => f.path !== path));
            setExtraContents(prev => { const n = { ...prev }; delete n[path]; return n; });
        } catch (err) { reportHandlerError(targetId, err); }
    }, [pageId, isStillCurrent, reportHandlerError]);

    const handleRenameFile = useCallback(async (oldPath, newPath) => {
        if (!oldPath || !newPath || oldPath === newPath) return;
        const targetId = pageId;
        try {
            const res = await authFetch(`${API_BASE}/api/webpages/${targetId}/assets/move`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: oldPath, to: newPath }), signal: inflightAbortRef.current?.signal,
            });
            if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Rename ${res.status}`); }
            const { file: meta } = await res.json();
            if (!isStillCurrent(targetId)) return;
            setExtraFiles(prev => prev.filter(f => f.path !== oldPath).concat(meta));
            setExtraContents(prev => { const n = { ...prev }; const c = n[oldPath]; delete n[oldPath]; if (c) n[meta.path] = c; return n; });
        } catch (err) { reportHandlerError(targetId, err); }
    }, [pageId, isStillCurrent, reportHandlerError]);

    const handleAssetUpload = useCallback(async (file, folder = 'assets') => {
        if (!file) return;
        const targetId = pageId;
        try {
            let blob = file;
            let mimeType = file.type || 'application/octet-stream';
            if (file.type && file.type.startsWith('image/')) {
                const r = await resizeImageForUpload(file);
                blob = r.blob; mimeType = r.mimeType;
            }
            const ext = extForMime(mimeType, file.name || 'asset');
            const stem = (file.name || 'asset').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]/g, '_') || 'asset';
            let path = `${folder}/${stem}.${ext}`;
            const taken = new Set(extraFiles.map(f => f.path));
            let n = 1;
            while (taken.has(path)) { path = `${folder}/${stem}-${n}.${ext}`; n++; }

            const form = new FormData();
            form.append('file', blob, path.split('/').pop());
            form.append('path', path);
            const res = await authFetch(`${API_BASE}/api/webpages/${targetId}/assets`, { method: 'POST', body: form, signal: inflightAbortRef.current?.signal });
            if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Upload ${res.status}`); }
            const { file: meta, contentBase64 } = await res.json();
            if (!isStillCurrent(targetId)) return;
            mergeExtra(meta, { mimeType: meta.mimeType, isText: false, dataUrl: `data:${meta.mimeType};base64,${contentBase64}` });
            return meta.path;
        } catch (err) { reportHandlerError(targetId, err); }
        return undefined;
    }, [pageId, extraFiles, mergeExtra, isStillCurrent, reportHandlerError]);

    // Cmd/Ctrl+S → flush. Only intercept the browser's native save when the
    // user is actually inside the IDE pane (Monaco editor, chat input, etc.).
    // Outside the IDE the keypress falls through to the browser so the user
    // gets the expected "Save page as…" dialog.
    const idePaneRef = useRef(null);
    useEffect(() => {
        const handler = (e) => {
            if (!((e.metaKey || e.ctrlKey) && e.key === 's')) return;
            const pane = idePaneRef.current;
            if (!pane) return;
            const active = document.activeElement;
            if (!active || !pane.contains(active)) return;
            e.preventDefault();
            flushNow();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [flushNow]);

    /* ── New Chat — clear local state + DELETE on the server ── */
    const handleNewChat = useCallback(async () => {
        setChatMessages([]);
        await clearChatOnServer();
    }, [setChatMessages, clearChatOnServer]);

    /* ── Versions ────────────────────────────────────────────── */
    // Alleen nog het AANTAL, voor de badge in de kop. De lijst zelf — laden,
    // bladeren, bekijken, terugzetten — woont sinds W4 in WebpageHistoryTab.
    // `null` betekent "nog niet gevraagd" en is met opzet iets anders dan 0:
    // nul versies en nooit-opgehaald mogen niet dezelfde badge tekenen.
    const [versionCount, setVersionCount] = useState(null);
    const handleVersionsLoaded = useCallback((n) => setVersionCount(n), []);

    /**
     * Tab selection. Alle vijf de tabs zijn nu een OPPERVLAK; "history" was tot
     * W4 een overlay bovenop de tab waar je stond, met een onthouden vorige tab
     * om naar terug te keren. Dat kunstje is weg: de strip wijst naar wat er
     * werkelijk onder ligt.
     */
    const handleTab = useCallback((id) => {
        // Defence in depth: the header already hides these for a viewer.
        if (!isOwner && OWNER_ONLY_TABS.includes(id)) return;
        setActiveTab(id);
    }, [isOwner]);

    /**
     * Terugzetten. De Geschiedenis-tab vraagt de bevestiging (via
     * shared/useConfirm — de kale confirm() met zijn "localhost says"-balk is
     * hier weg); deze functie is het ENIGE pad dat de editorstand verzet.
     *
     * `acceptServerSnapshot(files)` staat vóór de setters en dat is de hele
     * truc: het her-baselinet de save-discipline en slikt het content-effect
     * dat setHtml/setCss/setJs hierna veroorzaken. Zonder dat zou het
     * terugzetten meteen als een verse, niet-opgeslagen wijziging tellen en
     * teruggeschreven worden bovenop wat de server net had gezet.
     */
    const handleRestoreVersion = useCallback(async (vid) => {
        const { files } = await api(`/${pageId}/versions/${vid}/restore`, { method: 'POST' });
        if (!mountedRef.current) return;
        acceptServerSnapshot(files);
        setHtml(files.html || '');
        setCss(files.css || '');
        setJs(files.js || '');
    }, [pageId, acceptServerSnapshot]);

    /* ── Publishing (org / group visibility) ─────────────────── */
    // `republish` tells the server this is an explicit publish (freeze the
    // current content as the snapshot the audience reads) and not a change of
    // audience. Ticking a group must NOT push the owner's newest work live,
    // so the capsule's callbacks never set it — only the header's pill does.
    const callPublish = useCallback(async (nextPublished, nextSharedGroups, { republish = false } = {}) => {
        try {
            const res = await authFetch(`${API_BASE}/api/webpages/${pageId}/publish`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    isPublished: nextPublished,
                    ...(nextSharedGroups !== undefined ? { sharedGroups: nextSharedGroups } : {}),
                    ...(republish ? { republish: true } : {}),
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                // A licence refusal (webpage_sharing) reads as a sentence, not
                // as the bare `feature_locked` token the gate answers with.
                throw new Error(sharingRefusalText(res.status, data, t) || data.error || `Publish failed (${res.status})`);
            }
            // The server answers with the version it actually pinned. Take it
            // from the response rather than assuming: a publish that could not
            // pin is a 500 above, and anything else would leave the header
            // claiming a snapshot that does not exist.
            const body = await res.json().catch(() => ({}));
            const patch = {
                isPublished: nextPublished,
                ...(nextSharedGroups !== undefined ? { sharedGroups: nextSharedGroups } : {}),
                ...('publishedVersionId' in body ? { publishedVersionId: body.publishedVersionId } : {}),
            };
            if (!mountedRef.current) return;
            setPage(prev => prev ? { ...prev, ...patch } : prev);
            onMetaChange?.(pageId, patch);
        } catch (err) {
            if (mountedRef.current) setError(err.message);
        }
    }, [pageId, onMetaChange, t]);

    /**
     * The header's one primary action — and it does TWO different things,
     * because publishing a draft and republishing a live page are two
     * different decisions:
     *
     *   draft      OPENS THE CAPSULE. It does not publish. A one-click
     *              "Publish" would hand a personal page to the whole
     *              organisation without ever naming the audience — a silent
     *              widening, and the capsule right beside it asks before doing
     *              exactly that (`confirmWidening`). The button that starts
     *              the flow must not be the shortcut around its own guard.
     *   published  re-freezes the current content for the audience the page
     *              ALREADY has. No audience changes, so nothing widens and
     *              there is nothing to confirm.
     *
     * Either way pending edits are flushed first: publishing a keystroke that
     * has not reached the server yet would pin yesterday's page and read as a
     * save bug rather than a publish bug.
     */
    const handlePublishAction = useCallback(async () => {
        if (publishBusy) return;
        if (!page.isPublished) { setPublishMenuOpen(true); return; }
        setPublishBusy(true);
        try {
            await flushNow().catch(e => console.warn('[Webpages] pre-publish flush failed', e));
            const groups = Array.isArray(page.sharedGroups) ? page.sharedGroups : [];
            await callPublish(true, groups, { republish: true });
        } finally {
            if (mountedRef.current) setPublishBusy(false);
        }
    }, [callPublish, flushNow, page.isPublished, page.sharedGroups, publishBusy]);

    /** Inline rename from the header's title. */
    const handleRename = useCallback(async (nextName) => {
        const name = (nextName || '').trim();
        if (!name || name === page.name) return;
        const targetId = pageId;
        try {
            await api(`/${targetId}`, { method: 'PUT', body: JSON.stringify({ name }) });
            if (!isStillCurrent(targetId)) return;
            setPage(prev => (prev ? { ...prev, name } : prev));
            onMetaChange?.(targetId, { name });
        } catch (err) { reportHandlerError(targetId, err); }
    }, [pageId, page.name, onMetaChange, isStillCurrent, reportHandlerError]);

    const handleSetPersonal = useCallback(() => {
        callPublish(false, []);
        setPublishMenuOpen(false);
    }, [callPublish]);
    const handleSetEntireOrg = useCallback(() => {
        callPublish(true, []);
        setPublishMenuOpen(false);
    }, [callPublish]);
    const handleToggleGroup = useCallback((gid) => {
        const current = Array.isArray(page.sharedGroups) ? page.sharedGroups : [];
        const next = current.includes(gid) ? current.filter(x => x !== gid) : [...current, gid];
        callPublish(true, next);
    }, [callPublish, page.sharedGroups]);

    const handleDownloadZip = useCallback(async () => {
        // Flush any pending edits before zipping so the zip matches what's saved.
        await flushNow().catch(e => console.warn('[WebpagesPage] pre-zip persist failed', e));
        await downloadWebpageZip({
            name: page.name,
            html, css, js,
            extraFiles,
            extraContents,
            framework: page.settings?.framework,
        });
    }, [page.name, page.settings?.framework, html, css, js, extraFiles, extraContents, flushNow]);

    const visibleGroups = useMemo(
        () => orgGroups.filter(g => !user?.organizationId || g.organizationId === user.organizationId),
        [orgGroups, user?.organizationId],
    );

    /* ── What the header's badges may claim ──────────────────────
     * Both counts come from data already loaded, so neither costs a request —
     * and both are `undefined` (not 0) until they are really known, because
     * the badge slot renders nothing for undefined and a "0" would be a claim.
     * "Used by" has no source at all and stays absent on purpose.
     */
    const dataCount = useMemo(() => {
        const grants = page?.bridgeGrants || {};
        const n = (Array.isArray(grants.automations) ? grants.automations.length : 0)
            + (Array.isArray(grants.integrations) ? grants.integrations.length : 0)
            + (Array.isArray(sources) ? sources.length : 0);
        return n > 0 ? n : undefined;
    }, [page?.bridgeGrants, sources]);
    const headerCounts = useMemo(() => ({
        data: dataCount,
        // Only after the list has actually been fetched — before that we do
        // not know whether there are none or none-loaded.
        history: versionCount === null ? undefined : (versionCount || undefined),
        usedBy: undefined,
    }), [dataCount, versionCount]);

    /* ── Editor view (VS Code IDE shell) ────────────────────────── */
    return (
        <div className="relative flex flex-col h-full">
            <WebpageEditorHeader
                page={page}
                isOwner={isOwner}
                activeTab={activeTab}
                onTab={handleTab}
                counts={headerCounts}
                statusChip={(
                    <SaveStatus saveState={saveState} lastSavedAt={lastSavedAt} onRetry={persist} size={11} />
                )}
                onRename={handleRename}
                onBack={onClose}
                onPublish={handlePublishAction}
                publishBusy={publishBusy}
                capsuleOpen={publishMenuOpen}
                onCapsuleToggle={() => setPublishMenuOpen(v => !v)}
                onCapsuleClose={() => setPublishMenuOpen(false)}
                orgGroups={visibleGroups}
                onSetPersonal={handleSetPersonal}
                onSetEntireOrg={handleSetEntireOrg}
                onToggleGroup={handleToggleGroup}
                capsuleExtra={(
                    <>
                        <WebpageSharingLockNote reason={sharingLock} className="px-4 pt-2" />
                        <ExternalShareSection webpageId={pageId} webpageName={page.name} />
                    </>
                )}
                onAddImage={isOwner ? () => headerUploadRef.current?.click() : undefined}
                onDownloadZip={handleDownloadZip}
                extras={!isOwner ? <ShareLinksMenu webpageId={pageId} webpageName={page.name} /> : null}
            />
            {/* The header's "Add image" button drives this; the IDE no longer
                carries its own copy (plan W2 hoisted both buttons up). */}
            <input
                ref={headerUploadRef}
                type="file"
                multiple
                accept="image/*,.svg,.woff,.woff2,.ttf,.otf,.ico,.mp3,.mp4,.webm"
                style={{ display: 'none' }}
                onChange={(e) => {
                    Array.from(e.target.files || []).forEach(f => handleAssetUpload(f, 'assets'));
                    e.target.value = '';
                }}
            />

            {/* Errors from file/asset handlers (upload, create, delete, rename). */}
            {error && (
                <div className="shrink-0 px-4 py-2 text-xs flex items-center gap-2" style={{ background: 'rgba(239,68,68,0.1)', color: '#991b1b' }} role="alert">
                    <AlertCircle className="w-3.5 h-3.5" /> {error}
                    <button onClick={() => setError(null)} className="ml-auto" aria-label="Dismiss error"><X className="w-3 h-3" /></button>
                </div>
            )}

            {/* Body: the section the header's strip points at. */}
            <div className="flex-1 min-h-0">
                {activeTab === 'data' ? (
                    <WebpageDataTab
                        webpageId={pageId}
                        sources={sources}
                        onSourcesChange={setSources}
                        readOnly={!isOwner}
                        // Het Audience-segment tekent dezelfde drie interne
                        // rijen als de capsule in de kop, met exact dezelfde
                        // schrijfacties. Doorgeven in plaats van dupliceren:
                        // twee wegen naar `is_published` zouden vroeg of laat
                        // verschillend gaan valideren.
                        page={page}
                        orgGroups={visibleGroups}
                        onSetPersonal={isOwner ? handleSetPersonal : null}
                        onSetEntireOrg={isOwner ? handleSetEntireOrg : null}
                        onToggleGroup={isOwner ? handleToggleGroup : null}
                    />
                ) : activeTab === 'history' ? (
                    <WebpageHistoryTab
                        webpageId={pageId}
                        onRestore={handleRestoreVersion}
                        onLoaded={handleVersionsLoaded}
                    />
                ) : activeTab === 'usedby' ? (
                    <WebpageUsedByTab page={page} />
                ) : viewMode ? (
                    <WebpagePreview
                        webpageId={pageId}
                        html={html}
                        css={css}
                        js={js}
                        extraFiles={extraFiles}
                        extraContents={extraContents}
                        isStreaming={chatLoading}
                        framework={page.settings?.framework}
                        runtime={page.settings?.runtime}
                    />
                ) : (
                <div ref={idePaneRef} className="h-full">
                <WebpageIDE
                    selected={page}
                    html={html} css={css} js={js}
                    onHtmlChange={handleHtmlEdit}
                    onCssChange={handleCssEdit}
                    onJsChange={handleJsEdit}
                    dirtyFiles={dirtyFiles}
                    extraFiles={extraFiles}
                    extraContents={extraContents}
                    onExtraChange={handleExtraChange}
                    onCreateFile={handleCreateFile}
                    onRenameFile={handleRenameFile}
                    onDeleteFile={handleDeleteFile}
                    onUploadAsset={handleAssetUpload}
                    sources={sources}
                    onSourcesChange={setSources}
                    chatMessages={chatMessages}
                    chatLoading={chatLoading}
                    onChatSend={(text, attachments) => {
                        sendChatMessage(text, attachments);
                        // Single-shot: clear the attached selection after the
                        // first send so the next message doesn't carry it
                        // unless the user picks a new one.
                        if (attachedSelection) setAttachedSelection(null);
                    }}
                    onChatStop={stopChatGenerating}
                    onChatRetry={retryChatMessage}
                    onChatEdit={editAndRegenerateChat}
                    onPlanApprove={handlePlanApprove}
                    onPlanReject={handlePlanReject}
                    onNewChat={handleNewChat}
                    chatMode={chatMode}
                    onChatModeChange={handleChatModeChange}
                    onSelectionAttach={handleSelectionAttach}
                    attachedSelection={attachedSelection}
                    onSelectionClear={handleSelectionClear}
                    modelTiers={modelTiers}
                    selectedTier={selectedTier}
                    onTierChange={onTierChange}
                    saveState={saveState}
                    lastSavedAt={lastSavedAt}
                    onRetrySave={persist}
                    onVersionsClick={() => handleTab('history')}
                    onDownload={handleDownloadZip}
                    user={user}
                    // W2: the header owns these now. The IDE keeps its own
                    // state as the default so it still works standalone, but
                    // while a tab drives it the tab wins.
                    devMode={activeTab === 'code'}
                    onDevModeChange={(next) => handleTab(next ? 'code' : 'preview')}
                    hideHoistedActions
                    turnState={turnState}
                    onKeepTurn={handleKeepTurn}
                    onUndoTurn={handleUndoTurn}
                    onShowInCode={handleShowInCode}
                    focusFile={focusFile}
                />
                </div>
                )}
            </div>

        </div>
    );
}
