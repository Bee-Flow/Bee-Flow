/**
 * useNotebookDocument — the open notebook's document and everything that can
 * change it:
 *
 *   - typing, saved by compare-and-set (useDocumentAutosave), or shared live
 *     while the notebook is co-edited (useNotebookCollab) — never both;
 *   - a save that lost a race: the choice between the saved version and
 *     yours (NotebookConflictPanel), with nothing reloaded behind your back;
 *   - an AI edit from the chat: applied in place, unless you have typed
 *     something that is not saved yet — then your save goes first and, as it
 *     now meets the AI's version, the same compare-and-choose takes over;
 *   - a restore from the history.
 *
 * `readOnly` (a viewer) saves nothing and applies nothing but what the
 * server already holds.
 *
 * A save refused because the notebook is edited together right now joins the
 * live session (useSessionJoin); saving waits until that join has answered.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../../../../api/client';
import useTranslation from '../../../../hooks/useTranslation';
import useDocumentAutosave, { keepUnsavedCopy, type ConflictInfo } from '../hooks/useDocumentAutosave';
import type { NotebookDetailData } from '../notebookQueries';
import { editorHtml, type NotebookEditorHandle } from './editorHandle';
import type { NotebookSaveMode } from './NotebookSaveStatus';
import type { NoticeWithAction } from './NotebookNotice';
import useNotebookCollab from './useNotebookCollab';
import useSessionJoin from './useSessionJoin';

interface Options {
    data: NotebookDetailData;
    user: { id: string; name?: string } | null;
    readOnly: boolean;
    onNotice: (notice: NoticeWithAction | null) => void;
    /** Open the version history (from a notice's action). */
    onShowHistory: () => void;
}

interface CurrentVersion { version?: { documentVersion?: number | null; content?: { html?: string } } }

export default function useNotebookDocument({ data, user, readOnly, onNotice, onShowHistory }: Options) {
    const { t } = useTranslation();
    const nb = data.notebook;
    const eligible = data.collab.eligible && !!data.project;
    const collab = useNotebookCollab({ notebookId: nb.id, projectId: nb.projectId, eligible, user });
    const [conflict, setConflict] = useState<ConflictInfo | null>(null);
    const [conflictBusy, setConflictBusy] = useState(false);
    const [conflictError, setConflictError] = useState<string | null>(null);

    const resumeRef = useRef<() => void>(() => {});
    const join = useSessionJoin({ collab, onNotice, onShowHistory, resume: () => resumeRef.current() });
    const startJoin = join.start;

    /** A save was refused because the notebook is co-edited. False: this person cannot join, so saving must not wait. */
    const onCollabActive = useCallback((keptVersionId: string | null): boolean => {
        if (!eligible) {
            // Edited together in its project, which this person cannot join
            // here (the owner after leaving the project). No join will ever
            // resume saving: each later save still goes and is kept as a
            // version while the session lasts, and lands once it is over.
            onNotice({
                kind: 'error',
                message: t('notebooks.collab_elsewhere', 'This notebook is being edited together in its project right now, so your change was not saved here. It is kept in the version history.'),
                action: { label: t('notebooks.show_history', 'Show history'), onClick: onShowHistory },
            });
            return false;
        }
        startJoin(keptVersionId);
        return true;
    }, [eligible, onNotice, onShowHistory, startJoin, t]);

    const autosave = useDocumentAutosave({
        entityId: nb.id,
        initialVersion: nb.version,
        initialContent: nb.documentContent || '',
        bound: collab.bound,
        readOnly,
        onConflict: (info) => { setConflictError(null); setConflict(info); },
        onCollabActive,
    });
    const { editorRef, setDocumentContent, markDirty, setKnownVersion, resolveConflict, hasUnsaved, handleDocSave, resumeSaving } = autosave;
    useEffect(() => { resumeRef.current = resumeSaving; }, [resumeSaving]);

    /** The editor reported a change (its HTML; `remote` when somebody else made it). */
    const onEditorChange = useCallback((html: string, meta?: { remote?: boolean }) => {
        if (!collab.bound && !meta?.remote) markDirty();
        setDocumentContent(html);
    }, [collab.bound, markDirty, setDocumentContent]);

    /** Show content the server now holds (an AI edit, a restore, the other side of a conflict). */
    const showServerContent = useCallback((html: string, version: number | null | undefined) => {
        // One undoable step that keeps the caret: Ctrl+Z takes an AI edit or a restore back.
        const handle = editorRef.current as NotebookEditorHandle | null;
        if (handle?.replaceDocument) handle.replaceDocument(html);
        else handle?.setContent?.(html);
        setDocumentContent(html);
        if (version != null) setKnownVersion(version);
    }, [editorRef, setDocumentContent, setKnownVersion]);

    /** An AI edit arrived from the chat. */
    const onAiDocUpdate = useCallback((html: string, version: number | null) => {
        if (collab.bound) return;   // it reached the editor through the live session
        if (hasUnsaved()) {
            // Your typing is not saved yet: save it first. It meets the AI's
            // newer version and turns into the compare-and-choose, instead of
            // being overwritten in the editor.
            const mine = editorHtml(editorRef.current as NotebookEditorHandle | null);
            if (mine != null) void handleDocSave(mine);
            return;
        }
        showServerContent(html, version);
    }, [collab.bound, editorRef, handleDocSave, hasUnsaved, showServerContent]);

    /** A version was restored (the history panel's answer). */
    const onRestored = useCallback((current: unknown) => {
        const cur = (current || {}) as { html?: string; version?: number | null; live?: boolean };
        if (cur.live || collab.bound || typeof cur.html !== 'string') return;
        showServerContent(cur.html, cur.version ?? null);
    }, [collab.bound, showServerContent]);

    const keepMine = useCallback(async () => {
        if (!conflict) return;
        const mine = editorHtml(editorRef.current as NotebookEditorHandle | null) ?? conflict.localHtml;
        const version = conflict.currentVersion;
        setConflict(null);
        await resolveConflict({ keepServer: false, version, html: mine });
    }, [conflict, editorRef, resolveConflict]);

    /**
     * What was typed after the conflict appeared is in no version yet (the
     * server kept the text as it was at the refused save): keep it before the
     * saved version replaces it. True when there was such text and it is kept.
     */
    const keepLaterTyping = useCallback(async (info: ConflictInfo) => {
        const mine = editorHtml(editorRef.current as NotebookEditorHandle | null);
        if (mine == null || !mine.trim() || mine === info.localHtml) return false;
        await keepUnsavedCopy(nb.id, mine);
        return true;
    }, [editorRef, nb.id]);

    const takeSaved = useCallback(async () => {
        if (!conflict) return;
        setConflictBusy(true);
        setConflictError(null);
        let keptLater = false;
        try {
            keptLater = await keepLaterTyping(conflict);
        } catch (e) {
            // Nothing is replaced while that text has no copy.
            setConflictError(t('notebooks.conflict_keep_failed', 'Your newer text could not be kept, so nothing was replaced: {message}', { message: (e as Error).message }));
            setConflictBusy(false);
            return;
        }
        try {
            const data2 = await apiClient.get<CurrentVersion>(`/api/notebooks/${encodeURIComponent(nb.id)}/versions/current`, { retry: false });
            const html = data2?.version?.content?.html ?? '';
            const version = data2?.version?.documentVersion ?? null;
            showServerContent(html, version);
            setConflict(null);
            await resolveConflict({ keepServer: true, version });
            if (keptLater) {
                onNotice({
                    kind: 'info',
                    message: t('notebooks.conflict_kept_later', 'What you typed after the conflict is kept in the version history too.'),
                    action: { label: t('notebooks.show_history', 'Show history'), onClick: onShowHistory },
                });
            }
        } catch (e) {
            setConflictError(t('notebooks.conflict_load_failed', 'The saved version could not be loaded: {message}', { message: (e as Error).message }));
        } finally {
            setConflictBusy(false);
        }
    }, [conflict, keepLaterTyping, nb.id, onNotice, onShowHistory, resolveConflict, showServerContent, t]);

    let saveMode: NotebookSaveMode;
    if (readOnly) saveMode = 'readonly';
    else if (collab.saveMode) saveMode = collab.saveMode;
    else if (autosave.saveState === 'saving') saveMode = 'saving';
    else if (autosave.saveState === 'error') saveMode = 'error';
    else if (autosave.saveState === 'conflict') saveMode = 'conflict';
    else if (autosave.dirty) saveMode = 'dirty';
    else saveMode = 'idle';

    return {
        collab,
        autosave,
        editorRef,
        saveMode,
        conflict,
        conflictBusy,
        conflictError,
        keepMine,
        takeSaved,
        onEditorChange,
        onAiDocUpdate,
        onRestored,
    };
}
