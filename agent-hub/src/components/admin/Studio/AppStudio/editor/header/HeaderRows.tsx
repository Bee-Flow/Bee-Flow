/**
 * What the header decides about below itself: the view-as-role banner, row 2
 * (EditorToolRow, in EDIT view only) and the views that replace the canvas
 * (Data, Logic, Roles), and the leave-Roles confirmation. The shell hides the canvas and the inspector while
 * one is open (onViewChange).
 */
import { Eye } from 'lucide-react';
import type { Dispatch, ReactNode } from 'react';
import type { HeaderApp, HeaderView } from './headerModel';
import type { RolesDirty } from './useHeaderView';
import useTranslation from '../../../../../../hooks/useTranslation';
import ConfirmDialog from '../../../../../shared/ConfirmDialog';
import type { AppDefinition } from '../../inspector/appDefinition';
import type { AppEditorAction } from '../../state/appEditorState';
import EditorToolRow from '../EditorToolRow';
import { DataView, RolesView } from '../EditorViews';

interface PreviewRoleBannerProps {
    previewRole: string;
    previewRoleName: string | null;
    onExit: () => void;
}

/** View-as-role banner — a subtle strip while previewing a role. */
export function PreviewRoleBanner({ previewRole, previewRoleName, onExit }: PreviewRoleBannerProps) {
    const { t } = useTranslation();
    return (
        <div
            className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b px-3 py-1.5 text-xs"
            data-preview-role-banner={previewRole}
            style={{
                borderColor: 'var(--border-default)',
                background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
                color: 'var(--text-secondary)',
            }}
        >
            <Eye className="h-3.5 w-3.5" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
            <span>
                {t('app_studio.header.previewing_as', 'Previewing as')}{' '}
                <strong className="text-[var(--text-primary)]">{previewRoleName}</strong>
                {' — '}
                {t('app_studio.header.previewing_desc', 'screens and components hidden from this role are hidden here. Lists and tables still show everything you can see; each person only gets their own rows once they open the app themselves.')}
            </span>
            <button
                type="button"
                onClick={onExit}
                className="font-semibold underline underline-offset-2 text-[var(--accent-primary)]"
            >
                {t('app_studio.header.exit_preview', 'Exit preview')}
            </button>
        </div>
    );
}

/**
 * Roles and row rules live in each panel's local draft until its own Save
 * button runs, so leaving the Roles view mid-edit asks first.
 */
export function LeaveRolesDialog({ open, onConfirm, onCancel }: { open: boolean; onConfirm: () => void; onCancel: () => void }) {
    const { t } = useTranslation();
    return (
        <ConfirmDialog
            open={open}
            title={t('app_studio.header.roles_leave_title', 'Leave without saving?')}
            description={t('app_studio.header.roles_leave_desc', 'Your changes to roles and row rules have not been saved yet. Leaving now discards them.')}
            confirmLabel={t('app_studio.header.roles_leave_confirm', 'Discard changes')}
            cancelLabel={t('app_studio.header.roles_leave_cancel', 'Keep editing')}
            destructive
            onConfirm={onConfirm}
            onCancel={onCancel}
        />
    );
}

export interface HeaderViewRowsProps {
    view: HeaderView;
    app: HeaderApp;
    definition: AppDefinition | null;
    screenId: string | null;
    streamLock: boolean;
    dispatch: Dispatch<AppEditorAction>;
    dataOpen: { tab: string; n: number };
    /** The Logic view (LogicaTab, or the shell's own); rendered by the header to keep this module out of LogicaTab's import cycle. */
    renderLogic: () => ReactNode;
    onCommit: (def: AppDefinition) => void;
    canUndo?: boolean;
    canRedo?: boolean;
    onUndo?: () => void;
    onRedo?: () => void;
    onLeaveData: () => void;
    onRolesDirtyChange: (key: keyof RolesDirty, dirty: boolean) => void;
}

/** Row 2 in EDIT view, or the view that replaces the canvas. */
export function HeaderViewRows({
    view, app, definition, screenId, streamLock, dispatch, dataOpen, renderLogic,
    onCommit, canUndo, canRedo, onUndo, onRedo, onLeaveData, onRolesDirtyChange,
}: HeaderViewRowsProps) {
    if (view === 'edit') {
        return <EditorToolRow onCommit={onCommit} canUndo={canUndo} canRedo={canRedo} onUndo={onUndo} onRedo={onRedo} />;
    }
    if (view === 'data') {
        return (
            <DataView
                key={dataOpen.n}
                app={app}
                definition={definition}
                screenId={screenId}
                onCommit={onCommit}
                dispatch={dispatch}
                disabled={streamLock}
                initialTab={dataOpen.tab}
                onLeave={onLeaveData}
            />
        );
    }
    if (view === 'logic') return renderLogic();
    if (view === 'roles') {
        return <RolesView app={app} definition={definition} onCommit={onCommit} onDirtyChange={onRolesDirtyChange} />;
    }
    return null;
}
