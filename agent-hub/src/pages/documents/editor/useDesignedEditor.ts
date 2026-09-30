// The screen-level state of the designed-document editor: mode, panels,
// find, shortcuts, the conflict dialog, and what each keyboard shortcut does.
// The document itself is useDesignedDocument's; the frame's reports are
// useFrameState's.

import { useCallback, useRef, useState } from 'react';
import type { FrameKey } from '../canvasBridge';
import type { CanvasHandle } from '../DocumentCanvas';
import type { People, StudioDocument } from '../documentQueries';
import type { Conflict } from '../useDocumentAutosave';
import type { EditorMode, SidePanel } from './DesignedToolbar';
import useDeckDraft from './useDeckDraft';
import useDesignedDocument, { type WorkspaceHandle } from './useDesignedDocument';
import useEditorShortcuts from './useEditorShortcuts';
import useFrameState from './useFrameState';
import type { WorkspaceTab } from './WorkspaceTabs';

export interface FindState { open: boolean; focus: number; result: { count: number; index: number } | null }

function initialMode(doc: StudioDocument): EditorMode {
    if (doc.editable === false) return 'viewing';
    // A presentation opens on its slides, straight into the outline when it has none yet.
    if (doc.docType === 'presentation') return String(doc.bodyHtml || '').trim() ? 'viewing' : 'editing';
    return 'editing';
}

/** "Compare and choose" for a save that met somebody else's, and for a kept draft. */
function useConflicts(s: ReturnType<typeof useDesignedDocument>) {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [draftCompare, setDraftCompare] = useState<Conflict | null>(null);
    const after = (fn: () => Promise<unknown>) => async () => {
        setBusy(true);
        try { await fn(); } catch (e) { s.setError(e); } finally { setBusy(false); }
    };
    return {
        open, setOpen, busy, draftCompare,
        resolve: (choices: Record<string, 'mine' | 'theirs'>) => after(async () => {
            if (await s.autosave.resolveConflict(choices)) { setOpen(false); s.setReloadKey((k) => k + 1); }
        })(),
        discardMine: after(async () => {
            await s.autosave.discardMine();
            setOpen(false);
            s.setReloadKey((k) => k + 1);
            s.setPanelEpoch((k) => k + 1);
        }),
        compareDraft: () => {
            if (!s.draft) return;
            setDraftCompare({
                currentVersionId: s.doc.versionId, mine: s.draft.html,
                parts: [{ kind: 'conflict', key: 'draft', label: s.doc.name, base: '', mine: s.draft.html, theirs: s.doc.bodyHtml }],
            });
        },
        saveDraftChoice: async (choices: Record<string, 'mine' | 'theirs'>) => {
            setDraftCompare(null);
            if (choices.draft === 'theirs') s.discardDraft();
            else await s.restoreDraft();
        },
        closeDraft: () => setDraftCompare(null),
    };
}

export default function useDesignedEditor({ initial, people, currentUserId, onRenamed }: {
    initial: StudioDocument; people: People; currentUserId: string | null; onRenamed?: (doc: StudioDocument) => void;
}) {
    const canvasRef = useRef<CanvasHandle | null>(null);
    const workspaceRef = useRef<WorkspaceHandle | null>(null);
    const s = useDesignedDocument({ initial, canvasRef, workspaceRef, onRenamed });
    const [mode, setMode] = useState<EditorMode>(() => initialMode(initial));
    const editing = mode === 'editing' && !s.readOnly;
    const frame = useFrameState({ doc: s.doc, editing, currentUserId, extraPeople: people });
    const deck = useDeckDraft(s.doc.id, canvasRef);
    const conflicts = useConflicts(s);
    const [tab, setTab] = useState<WorkspaceTab | null>(null);
    const [side, setSide] = useState<SidePanel>(null);
    const [find, setFind] = useState<FindState>({ open: false, focus: 0, result: null });
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [slideCount, setSlideCount] = useState(0);
    const canComment = !!s.doc.projectId;

    const openFind = () => setFind((f) => ({ ...f, open: true, focus: f.focus + 1 }));
    const closeFind = () => setFind((f) => ({ ...f, open: false, result: null }));
    const actions: Record<FrameKey, () => void> = {
        save: () => { s.flushEditor().catch(() => undefined); },
        find: () => { if (!s.isDeck) openFind(); },
        history: () => setSide((v) => (v === 'history' ? null : 'history')),
        comment: () => { if (canComment) setSide('comments'); },
        help: () => setShortcutsOpen(true),
        escape: () => { if (find.open) closeFind(); else if (editing && !s.isDeck) setMode('viewing'); },
    };
    const onKey = (key: FrameKey) => actions[key]?.();
    useEditorShortcuts(onKey);

    const onFind = useCallback((query: string, step: number) => canvasRef.current?.find(query, step), []);
    const onRestored = (current: unknown) => {
        if (!current || typeof current !== 'object') return;
        s.autosave.replaceWith(current as StudioDocument);
        s.setReloadKey((k) => k + 1);
        s.setPanelEpoch((k) => k + 1);
    };
    const guarded = (fn: () => Promise<unknown>) => () => { fn().catch((e) => s.setError(e)); };

    return {
        s, canvasRef, workspaceRef, mode, setMode, editing, frame, deck, conflicts, tab, setTab, side, setSide,
        find, setFind, openFind, closeFind, onFind, shortcutsOpen, setShortcutsOpen, slideCount, setSlideCount,
        canComment, onKey, onRestored, guarded,
    };
}

export type DesignedEditorState = ReturnType<typeof useDesignedEditor>;
