import { useMemo } from 'react';
import type { Dispatch, RefObject } from 'react';
import type { HeaderView } from './headerModel';
import type { ViewOpts } from './useHeaderView';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import type { AppDefinition } from '../../inspector/appDefinition';
import type { AppEditorAction, EditorMode } from '../../state/appEditorState';

/** One row of the ⌘K palette. */
export interface CommandAction {
    id: string;
    group: string;
    label: string;
    hint?: string;
    run: () => void;
}

export interface DefinitionRole {
    id: string;
    name?: string;
}

export interface CommandActionInputs {
    t: TranslateFn;
    mode: EditorMode;
    definition: AppDefinition | null;
    roles: DefinitionRole[];
    isManaged: boolean;
    dispatch: Dispatch<AppEditorAction>;
    selectView: (next: HeaderView, opts?: ViewOpts) => void;
    setPreviewRole: (roleKey: string | null) => void;
    openVersions: () => void;
    /** Read through refs: both close over values that are not stable. */
    focusAiRef: RefObject<(() => void) | null>;
    openPublishRef: RefObject<(() => void) | null>;
}

/** The command palette's action list, memoised on what changes the LIST. */
export function useCommandActions({
    t, mode, definition, roles, isManaged, dispatch, selectView, setPreviewRole, openVersions, focusAiRef, openPublishRef,
}: CommandActionInputs): CommandAction[] {
    return useMemo(() => {
        const acts: CommandAction[] = [];
        if (!isManaged) acts.push({
            id: 'cmd-mode',
            group: t('app_studio.cmd.group_view', 'View'),
            label: mode === 'edit' ? t('app_studio.cmd.switch_preview', 'Switch to Preview') : t('app_studio.cmd.switch_edit', 'Switch to Edit'),
            run: () => selectView(mode === 'edit' ? 'preview' : 'edit'),
        });
        for (const s of definition?.screens || []) {
            acts.push({
                id: `cmd-screen-${s.id}`,
                group: t('app_studio.cmd.group_screen', 'Go to screen'),
                label: t('app_studio.cmd.go_to', 'Go to {name}', { name: s.name || t('app_studio.screens.untitled', 'Screen') }),
                run: () => { selectView('edit'); dispatch({ type: 'set_screen', screenId: s.id as string }); },
            });
        }
        const app = t('app_studio.cmd.group_app', 'App');
        acts.push({ id: 'cmd-data', group: t('app_studio.cmd.group_data', 'Data'), label: t('app_studio.cmd.open_tables', 'Open Tables'), run: () => selectView('data', { tab: 'tables' }) });
        if (!isManaged) acts.push({ id: 'cmd-ai', group: t('app_studio.cmd.group_ai', 'AI'), label: t('app_studio.cmd.ask_ai', 'Ask the AI builder'), hint: t('app_studio.cmd.hint_chat', 'chat'), run: () => focusAiRef.current?.() });
        acts.push({ id: 'cmd-variables', group: app, label: t('app_studio.cmd.open_variables', 'Open Variables'), run: () => selectView('data', { tab: 'variables' }) });
        acts.push({ id: 'cmd-logic', group: app, label: t('app_studio.cmd.open_logic', 'Open Logic'), run: () => selectView('logic') });
        acts.push({ id: 'cmd-roles', group: app, label: t('app_studio.cmd.open_roles', 'Open Roles & access'), run: () => selectView('roles') });
        acts.push({ id: 'cmd-versions', group: app, label: t('app_studio.header.version_history', 'Version history'), run: openVersions });
        acts.push({ id: 'cmd-publish', group: app, label: t('app_studio.cmd.publish', 'Publish app'), run: () => { openPublishRef.current?.(); } });
        const previewAs = t('app_studio.cmd.group_preview_as', 'Preview as');
        acts.push({ id: 'cmd-role-owner', group: previewAs, label: t('app_studio.cmd.view_as_owner', 'View as Owner (full view)'), run: () => setPreviewRole(null) });
        for (const r of roles) {
            acts.push({ id: `cmd-role-${r.id}`, group: previewAs, label: t('app_studio.cmd.view_as', 'View as {name}', { name: r.name || r.id }), run: () => setPreviewRole(r.id) });
        }
        return acts;
    // Publishing goes through a ref because it closes over `onFlush`, which
    // is not stable; the deps cover everything that changes the LIST of actions.
    }, [mode, definition, roles, dispatch, selectView, setPreviewRole, isManaged, t, openVersions, focusAiRef, openPublishRef]);
}
