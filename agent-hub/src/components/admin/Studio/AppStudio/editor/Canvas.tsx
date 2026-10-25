import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction, type RefObject, type JSX } from 'react';
import { useEditorChrome } from './EditorChromeContext';
import { useScreenValues } from './ScreenValuesContext';
import AppDataScope from '../runtime/AppDataScope';
import { BrowserRunProvider, useBrowserRunStore } from '../runtime/BrowserRunContext';
import { mergeFormValues } from '../runtime/formValues';
import { buildScope } from '../runtime/RuntimeContext';
import useActionRunner from '../runtime/useActionRunner';
import useConfirmDialog from '../runtime/useConfirmDialog';
import { useAppEditor } from '../state/AppEditorContext';
import './editor.css';
import type { DataState } from '../runtime/DataContext';
import type { AppDefinition } from '../inspector/appDefinition';
import type { HeaderApp } from './header/headerModel';
import type { ActionState, RunOpts, Vars } from '../runtime/actionRunner/core';
import type { NavigateFn } from '../runtime/actionRunner/runnerContext';
import type { CanvasBodyProps, CanvasProps } from './Canvas.types';
import { CanvasBody } from './CanvasBody';

/**
 * App Studio editor — the canvas: a scrollable neutral surface around the
 * shared runtime renderer.
 *
 *   edit mode    — AppRenderer with NodeWrapper=EditorNodeWrapper inside ONE
 *                  SortableContext per screen (see dnd.js for the design
 *                  note). Actions are stubbed: navigate really switches the
 *                  canvas screen; run_automation explains itself in a toast.
 *                  Empty sections get a droppable "drag here" placeholder,
 *                  PORTALED into the renderer's own <section> element so it
 *                  sits exactly where dropped components will land — the
 *                  runtime stays editor-free that way.
 *   preview mode — the real thing: AppShell chrome + run-mode renderer with
 *                  useActionRunner against the DRAFT definition, so preview
 *                  actions actually execute.
 *
 * While streamLock is on, a translucent overlay (opacity transition only)
 * blocks all canvas interaction and shows an "AI is editing…" chip.
 */

const EMPTY_ACTION_STATE = {};

export default function Canvas({ app, onCommit, editActionState = EMPTY_ACTION_STATE }: CanvasProps) {
    const { definition, screenId, mode, previewUser, dispatch } = useAppEditor();
    // The shell's autosave flush — preview needs the server to be looking at
    // the same draft it is before it runs a step by ordinal.
    const chrome = useEditorChrome();

    // Preview owns the same scope state as the run view (AppRunPage.RunSurface):
    // forms published by AppForm, screen params from navigate-with-params, vars
    // lifted out of the action runner.
    const [forms, setForms] = useState({});
    const [screenParams, setScreenParams] = useState({});
    // Same fold as the run surface (mergeFormValues), unchanged values included:
    // publishing what the scope already has must not re-memo buildScope.
    // The inspector's "Test with what is on screen" reads the SAME values from
    // a ref-backed store above this component (ScreenValuesContext): the canvas
    // needs them as state (they feed the scope bindings resolve against), the
    // inspector needs them only at the moment somebody presses Test. Written in
    // one callback from one `values`, so the two cannot drift.
    const screenValues = useScreenValues();
    const registerFormValue = useCallback((formName: string, values: { [x: string]: unknown; }|null|undefined) => {
        setForms((prev) => mergeFormValues(prev, formName, values));
        screenValues?.publish(formName, values);
    }, [screenValues]);

    const onNavigate = useCallback(
        (sid: string, params?: unknown) => {
            setScreenParams(params && typeof params === 'object' ? params : {});
            dispatch({ type: 'set_screen', screenId: sid });
        },
        [dispatch],
    );

    // A house-style modal confirm for `confirm` steps (default is window.confirm).
    const { confirm, dialog: confirmDialog } = useConfirmDialog();

    // Mirrored up from CanvasBody (see its bridge effects).
    const [runnerDataState, setRunnerDataState] = useState<DataState>({});
    const refreshRef = useRef<CanvasBodyProps['refresh'] | null>(null);
    const handleRefresh = useCallback((...args: Parameters<CanvasBodyProps['refresh']>) => refreshRef.current?.(...args), []);

    // Live-browse frames for an ai_browse step previewed on the canvas. Without
    // this the runner has no sink, so `publish` is null and every frame the
    // server streams is dropped — the browser_view panel sits on its idle
    // placeholder for the whole run and Preview looks broken while the step is
    // in fact working. The run page (pages/apps/AppRunPage.jsx) wires the same
    // pair; Preview has to, or the two surfaces disagree.
    const browseStore = useBrowserRunStore();

    // Live actions for preview mode, always against the draft definition. The
    // sampled dataState feeds action formulas so previewed sequences see records.
    const { actionState, runAction, vars, setVar } = useActionRunner(app?.id, definition, {
        draft: true,
        onNavigate,
        confirm,
        dataState: runnerDataState,
        currentUser: previewUser,
        onRefresh: handleRefresh,
        onBrowseEvent: browseStore.publish,
        // Same two roots the renderer's scope carries, so a previewed sequence
        // resolves screen.params.* exactly as the published app will.
        forms,
        screen: { id: screenId, params: screenParams },
        // The server steps against the SAVED draft, so persist the canvas
        // before it is asked to run one by ordinal.
        beforeServerStep: chrome?.flush || null,
    });

    // The live scope dynamic binding filters resolve against (buildScope's
    // shape, never a fork; no dataState — the fetch layer must not depend on
    // its own results). In EDIT mode the renderer's scope carries no
    // vars/forms/params (preview-only state), so the fetch scope matches it:
    // formula filters resolve identically on both sides and sampled data
    // ignores stale preview state.
    const scope = useMemo(() => (mode === 'edit'
        ? buildScope({ currentUser: previewUser, screen: { id: screenId, params: {} } })
        : buildScope({
            currentUser: previewUser,
            vars,
            forms,
            screen: { id: screenId, params: screenParams },
        })
    ), [mode, previewUser, vars, forms, screenId, screenParams]);

    return (
        <BrowserRunProvider value={browseStore}>
        <AppDataScope
            appId={app?.id}
            definition={definition}
            screenId={screenId}
            sample={mode === 'edit'}
            draft
            scope={scope}
            // The editor never polls: `sample` already blocks it, but saying so
            // here means a future change to that flag can't quietly start
            // hammering the API on every keystroke-driven re-render.
            refreshMs={0}
        >
            {(dataState, { refresh }) => (
                <CanvasBody
                    appId={app?.id || null}
                    onCommit={onCommit}
                    editActionState={editActionState}
                    dataState={dataState}
                    refresh={refresh}
                    onDataState={setRunnerDataState}
                    refreshRef={refreshRef}
                    actionState={actionState}
                    runAction={runAction}
                    vars={vars}
                    setVar={setVar}
                    forms={forms}
                    screenParams={screenParams}
                    registerFormValue={registerFormValue}
                    onNavigate={onNavigate}
                    confirmDialog={confirmDialog}
                />
            )}
        </AppDataScope>
        </BrowserRunProvider>
    );
}
