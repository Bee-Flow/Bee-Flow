import { useCallback, useEffect, useRef, useState, useLayoutEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { PANEL_VIEWS } from './headerModel';
import type { HeaderView, PanelView } from './headerModel';
import type { AppEditorAction, EditorMode } from '../../state/appEditorState';

export interface ViewOpts {
    /** The Data view's subtab to open (⌘K "Open Variables" lands on Variables). */
    tab?: string;
}

/** Which of the Roles view's two drafts hold unsaved edits. */
export interface RolesDirty {
    roles: boolean;
    rules: boolean;
}

export interface HeaderViewState {
    view: HeaderView;
    dataOpen: { tab: string; n: number };
    pendingView: { next: HeaderView; opts: ViewOpts } | null;
    setPendingView: Dispatch<SetStateAction<{ next: HeaderView; opts: ViewOpts } | null>>;
    setRolesDirty: Dispatch<SetStateAction<RolesDirty>>;
    /** Switch without asking (a reveal, "Show me", leaving the Data view). */
    applyView: (next: HeaderView, opts?: ViewOpts) => void;
    /** Switch as the person asked — guarded by the Roles view's unsaved drafts. */
    selectView: (next: HeaderView, opts?: ViewOpts) => void;
    leaveRolesAnyway: () => void;
}

/**
 * Which of the five segments is open.
 *
 * Edit/Preview live in the context (`mode`); a panel view is local and wins
 * while set. `view` is the one word both the segments and the shell read.
 */
export function useHeaderView(
    mode: EditorMode,
    dispatch: Dispatch<AppEditorAction>,
    onViewChange: ((view: HeaderView) => void) | null | undefined,
): HeaderViewState {
    const [rolesDirty, setRolesDirty] = useState<RolesDirty>({ roles: false, rules: false });
    const [panelView, setPanelView] = useState<PanelView | null>(null);
    const view: HeaderView = panelView ?? mode;
    // Data view remembers which subtab to open (⌘K "Open Variables" lands on
    // the Variables subtab); `n` re-keys the view so a repeat request applies.
    const [dataOpen, setDataOpen] = useState({ tab: 'tables', n: 0 });
    // A view someone tried to switch to while Roles held unsaved drafts —
    // the ConfirmDialog in the header decides.
    const [pendingView, setPendingView] = useState<{ next: HeaderView; opts: ViewOpts } | null>(null);

    useEffect(() => { onViewChange?.(view); }, [view, onViewChange]);

    // A mode change from OUTSIDE the segments (⌘K, a hotkey, an AI turn) means
    // "show me the canvas" — an open view would otherwise hide what the
    // person just asked for.
    const [prevMode, setPrevMode] = useState(mode);
    if (prevMode !== mode) {
        setPrevMode(mode);
        setPanelView(null);
    }

    const applyView = useCallback((next: HeaderView, opts: ViewOpts = {}) => {
        if (next === 'edit' || next === 'preview') {
            setPanelView(null);
            dispatch({ type: 'set_mode', mode: next });
            return;
        }
        if (!PANEL_VIEWS.includes(next)) return;
        if (next === 'data') setDataOpen((prev) => ({ tab: opts.tab || 'tables', n: prev.n + 1 }));
        setPanelView(next);
    }, [dispatch]);

    // Roles and row rules live in each panel's local draft until its own Save
    // button runs, so leaving the Roles view mid-edit is a silent discard.
    const rolesDirtyRef = useRef(rolesDirty);
    useLayoutEffect(() => {
        rolesDirtyRef.current = rolesDirty;
    });
    const viewRef = useRef(view);
    useLayoutEffect(() => {
        viewRef.current = view;
    });
    const selectView = useCallback((next: HeaderView, opts: ViewOpts = {}) => {
        if (next === viewRef.current && !opts.tab) return;
        const dirty = rolesDirtyRef.current;
        if (viewRef.current === 'roles' && next !== 'roles' && (dirty.roles || dirty.rules)) {
            setPendingView({ next, opts });
            return;
        }
        applyView(next, opts);
    }, [applyView]);

    const leaveRolesAnyway = () => {
        const target = pendingView;
        setPendingView(null);
        setRolesDirty({ roles: false, rules: false });
        if (target) applyView(target.next, target.opts);
    };

    return { view, dataOpen, pendingView, setPendingView, setRolesDirty, applyView, selectView, leaveRolesAnyway };
}
