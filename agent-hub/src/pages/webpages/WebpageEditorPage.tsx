import { AlertCircle, X } from 'lucide-react';
import { useCallback, useMemo, useRef, useState, type RefObject } from 'react';
import usePageGuards from './hooks/usePageGuards';
import useWebpageChat from './hooks/useWebpageChat';
import { useFlushRegistration, useHeaderCounts, useSaveShortcut, useSettingsSwitchEvents } from './hooks/useWebpageEditorEffects';
import { useWebpageExtraFiles, useWebpageFileActions } from './hooks/useWebpageExtraFiles';
import useWebpagePublishing from './hooks/useWebpagePublishing';
import useWebpageSave from './hooks/useWebpageSave';
import SaveStatus from './SaveStatus';
import WebpageEditorBody from './WebpageEditorBody';
import WebpageEditorHeader from './WebpageEditorHeader';
import type { WebpageSource } from './WebpageSources';
import type { ExtraContents, ExtraFileMeta, PrimarySetters, WebpagePatch, WebpageRow } from './webpageEditorTypes';
import { api } from './webpagesApi';
import ExternalShareSection from '../../components/agents/AgentWizard/pickers/ExternalShareSection';
import ShareLinksMenu from '../../components/agents/AgentWizard/pickers/ShareLinksMenu';
import type { RetryModelTiers } from '../../components/chat/MessageItem/MessageActionsRow';
import type { OrgGroup } from '../../api/queries/orgGroups';
import { managedOf } from '../../utils/managedPart';
import type { ChatMessage } from '../../hooks/useChatEngine/types';
import { useTranslation } from '../../hooks/useTranslation';
import downloadWebpageZip from '../../utils/downloadWebpageZip';

/**
 * Sections a viewer never reaches. Not cosmetic: `GET /:id/versions` and every
 * save are owner-scoped and answer 404 to anyone else, so offering these would
 * be offering an action the screen cannot carry out.
 */
const OWNER_ONLY_TABS = ['code', 'history'];

export interface WebpageEditorPageProps {
    loaded: {
        webpage: WebpageRow;
        sources: WebpageSource[];
        files: { html: string; css: string; js: string };
        chatMessages: ChatMessage[];
        extraFiles: ExtraFileMeta[];
        extraContents: ExtraContents;
    };
    user?: { id?: string; organizationId?: string } | null;
    orgGroups?: OrgGroup[];
    modelTiers?: RetryModelTiers;
    selectedTier?: string;
    onTierChange?: (tier: string) => void;
    initialEditMode?: boolean;
    onClose?: () => void;
    onSaved?: (id: string) => void;
    onMetaChange?: (id: string, patch: WebpagePatch) => void;
    flushRef?: RefObject<(() => Promise<unknown>) | null>;
}

/**
 * The five sections (plan W2). One `activeTab` replaced three booleans that
 * used to disagree with each other (`viewMode`, the IDE's own `devMode`, and
 * the overlay flag the version list used to carry — W4 removed that last
 * one). The IDE keeps its internal state as the default, but while a tab is
 * driving it the tab wins.
 *   preview  the sandboxed iframe alone
 *   data     links / sources / database
 *   code     the IDE, developer view on
 *   history  the version list — since W4 an ordinary surface, no longer an
 *            overlay on top of the tab you were on (WebpageHistoryTab)
 *   usedby   what depends on this page — an honest "we cannot tell yet"
 *
 * A viewer never opens in the code editor: Code and History are owner-only
 * (both server surfaces behind them answer 404 to anyone else), and the
 * header does not offer them either. Neither is on offer for a managed page;
 * that falls back to Preview.
 */
function useEditorTabs(initialEditMode: boolean, isOwner: boolean, managed: unknown, initialManaged: unknown) {
    const [tabState, setActiveTab] = useState(initialEditMode && isOwner && !initialManaged ? 'code' : 'preview');
    const activeTab = managed && (tabState === 'code' || tabState === 'history') ? 'preview' : tabState;
    // Every tab is a SURFACE; "history" used to be an overlay with a
    // remembered previous tab to return to. The strip now points at what is
    // really underneath.
    const handleTab = useCallback((id: string) => {
        // Defence in depth: the header already hides these for a viewer.
        if (!isOwner && OWNER_ONLY_TABS.includes(id)) return;
        setActiveTab(id);
    }, [isOwner]);
    // "Change in code": open the Code section on the file the turn touched.
    const [focusFile, setFocusFile] = useState<{ key: string; at: number } | null>(null);
    const handleShowInCode = useCallback((file?: string) => {
        setActiveTab('code');
        if (file) setFocusFile({ key: file, at: Date.now() });
    }, []);
    return { activeTab, handleTab, focusFile, handleShowInCode };
}

/** All state and handlers of one open webpage. */
function useWebpageEditor({ loaded, user, orgGroups = [], selectedTier = 'fast', initialEditMode = false, onSaved, onMetaChange, flushRef }: WebpageEditorPageProps) {
    const pageId = loaded.webpage.id;
    const [page, setPage] = useState<WebpageRow>(loaded.webpage);
    const isOwner = page.userId === user?.id;
    // A page a Solution stage manages is read-only for everyone: no AI builder, no
    // code editor, no history (the header does not offer those tabs either).
    const managed = managedOf(page);
    const tabs = useEditorTabs(initialEditMode, isOwner, managed, managedOf(loaded.webpage));
    const [sources, setSources] = useState<WebpageSource[]>(loaded.sources);
    const [html, setHtml] = useState(loaded.files.html);
    const [css, setCss] = useState(loaded.files.css);
    const [js, setJs] = useState(loaded.files.js);
    const setters = useMemo<PrimarySetters>(() => ({ html: setHtml, css: setCss, js: setJs }), []);
    const guards = usePageGuards(pageId);
    const extras = useWebpageExtraFiles(pageId, loaded, guards.isStillCurrent);
    const fileActions = useWebpageFileActions({ pageId, extras, guards });

    const save = useWebpageSave({ webpageId: pageId, html, css, js, extraContentsRef: extras.extraContentsRef, api, onSaved });
    const { flushNow, markPrimaryDirty, markExtraDirty, acceptServerSnapshot } = save;
    useFlushRegistration(flushRef, flushNow);

    const onSourceAdded = useCallback((source: unknown) => setSources(prev => [...prev, source as WebpageSource]), []);
    const chat = useWebpageChat({
        pageId, selectedTier, content: { html, css, js }, contentRef: save.contentRef, setters, markPrimaryDirty,
        initialMessages: loaded.chatMessages, extras, onSourceAdded,
    });
    useSettingsSwitchEvents(pageId, page, setPage, onMetaChange);

    // Mark a primary slot dirty when the user types into Monaco. SSE-driven
    // updates (AI edits from chat events) bypass these so they don't mistakenly
    // mark already-saved content as dirty.
    const edits = useMemo(() => ({
        html: (v: string) => { setHtml(v); markPrimaryDirty('html'); },
        css: (v: string) => { setCss(v); markPrimaryDirty('css'); },
        js: (v: string) => { setJs(v); markPrimaryDirty('js'); },
        extra: (path: string, content: string) => { extras.changeExtraContent(path, content); markExtraDirty(path); },
    }), [markPrimaryDirty, markExtraDirty, extras.changeExtraContent]);
    const idePaneRef = useSaveShortcut(flushNow);

    // Only the COUNT of versions, for the badge in the header; the list itself
    // lives in WebpageHistoryTab since W4. `null` means "not asked yet", which
    // is deliberately different from 0: zero versions and never-fetched must
    // not draw the same badge.
    const [versionCount, setVersionCount] = useState<number | null>(null);
    const handleVersionsLoaded = useCallback((n: number) => setVersionCount(n), []);

    /**
     * Restore. The History tab asks for the confirmation; this is the ONLY
     * path that moves the editor state. `acceptServerSnapshot(files)` comes
     * before the setters and that is the whole trick: it re-baselines the
     * save discipline and swallows the content effect the setters cause.
     * Without it the restore would count as a fresh unsaved change and be
     * written back on top of what the server just set.
     */
    const { mountedRef } = guards;
    const handleRestoreVersion = useCallback(async (vid: string) => {
        const { files } = await api(`/${pageId}/versions/${vid}/restore`, { method: 'POST' });
        if (!mountedRef.current) return;
        acceptServerSnapshot(files);
        setHtml(files.html || '');
        setCss(files.css || '');
        setJs(files.js || '');
    }, [pageId, acceptServerSnapshot, mountedRef]);

    const publishing = useWebpagePublishing({ pageId, page, setPage, onMetaChange, flushNow, mountedRef, setError: guards.setError });

    /** Inline rename from the header's title. */
    const { isStillCurrent, reportHandlerError } = guards;
    const handleRename = useCallback(async (nextName: string) => {
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

    const { extraFiles, extraContents } = extras;
    const handleDownloadZip = useCallback(async () => {
        // Flush any pending edits before zipping so the zip matches what's saved.
        await flushNow().catch((e: unknown) => console.warn('[WebpagesPage] pre-zip persist failed', e));
        await downloadWebpageZip({ name: page.name, html, css, js, extraFiles, extraContents, framework: page.settings?.framework });
    }, [page.name, page.settings?.framework, html, css, js, extraFiles, extraContents, flushNow]);

    const visibleGroups = useMemo(
        () => orgGroups.filter(g => !user?.organizationId || g.organizationId === user.organizationId),
        [orgGroups, user?.organizationId],
    );
    const headerCounts = useHeaderCounts(page, sources, versionCount);

    return {
        pageId, page, isOwner, managed, tabs, sources, setSources, content: { html, css, js }, edits, guards, extras,
        fileActions, save, chat, idePaneRef, handleVersionsLoaded, handleRestoreVersion, publishing, handleRename,
        handleDownloadZip, visibleGroups, headerCounts,
    };
}

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
export default function WebpageEditorPage(props: WebpageEditorPageProps) {
    const { t } = useTranslation();
    const ed = useWebpageEditor(props);
    const { pageId, page, isOwner, publishing, guards, save } = ed;
    const { error, setError } = guards;
    const { modelTiers = {}, selectedTier = 'fast', onTierChange, onClose, user } = props;
    const { fileActions } = ed;
    // The hidden file input the header's "Add image" drives.
    const headerUploadRef = useRef<HTMLInputElement | null>(null);
    return (
        <div className="relative flex flex-col h-full">
            <WebpageEditorHeader
                page={page}
                isOwner={isOwner}
                managed={ed.managed}
                activeTab={ed.tabs.activeTab}
                onTab={ed.tabs.handleTab}
                counts={ed.headerCounts}
                statusChip={(
                    <SaveStatus saveState={save.saveState} lastSavedAt={save.lastSavedAt} onRetry={save.persist} size={11} />
                )}
                onRename={ed.handleRename}
                onBack={onClose}
                onPublish={publishing.handlePublishAction}
                publishBusy={publishing.publishBusy}
                capsuleOpen={publishing.publishMenuOpen}
                onCapsuleToggle={() => publishing.setPublishMenuOpen(v => !v)}
                onCapsuleClose={() => publishing.setPublishMenuOpen(false)}
                orgGroups={ed.visibleGroups}
                onSetPersonal={publishing.handleSetPersonal}
                onSetEntireOrg={publishing.handleSetEntireOrg}
                onToggleGroup={publishing.handleToggleGroup}
                capsuleExtra={<ExternalShareSection webpageId={pageId} webpageName={page.name} />}
                onAddImage={isOwner ? () => headerUploadRef.current?.click() : undefined}
                onDownloadZip={ed.handleDownloadZip}
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
                    Array.from(e.target.files || []).forEach(f => fileActions.handleAssetUpload(f, 'assets'));
                    e.target.value = '';
                }}
            />

            {/* Errors from file/asset handlers (upload, create, delete, rename). */}
            {error && (
                <div className="shrink-0 px-4 py-2 text-xs flex items-center gap-2" style={{ background: 'rgba(239,68,68,0.1)', color: '#991b1b' }} role="alert">
                    <AlertCircle className="w-3.5 h-3.5" /> {error}
                    <button onClick={() => setError(null)} className="ml-auto" aria-label={t('webpages.dismiss_error', 'Dismiss error')}><X className="w-3 h-3" /></button>
                </div>
            )}

            <div className="flex-1 min-h-0">
                <WebpageEditorBody
                    activeTab={ed.tabs.activeTab}
                    pageId={pageId}
                    page={page}
                    user={user}
                    isOwner={isOwner}
                    managed={ed.managed}
                    content={ed.content}
                    edits={ed.edits}
                    sources={ed.sources}
                    setSources={ed.setSources}
                    visibleGroups={ed.visibleGroups}
                    audience={{ onSetPersonal: publishing.handleSetPersonal, onSetEntireOrg: publishing.handleSetEntireOrg, onToggleGroup: publishing.handleToggleGroup }}
                    onRestoreVersion={ed.handleRestoreVersion}
                    onVersionsLoaded={ed.handleVersionsLoaded}
                    extras={ed.extras}
                    fileActions={fileActions}
                    chat={ed.chat}
                    save={save}
                    tiers={{ modelTiers, selectedTier, onTierChange }}
                    onTab={ed.tabs.handleTab}
                    onDownloadZip={ed.handleDownloadZip}
                    onShowInCode={ed.tabs.handleShowInCode}
                    focusFile={ed.tabs.focusFile}
                    idePaneRef={ed.idePaneRef}
                />
            </div>
        </div>
    );
}
