import type { AppDefinition } from '../inspector/appDefinition';

/**
 * Props of RolesManager (RolesManager.jsx). Every prop may be left out: without
 * an `appId` the app model is never loaded, and a save only mirrors the roles
 * into the definition when both `definition` and `onCommit` are given.
 */
export interface RolesManagerProps {
    appId?: string | null;
    definition?: AppDefinition | null;
    onCommit?: ((next: AppDefinition) => void) | null;
    /** Reports unsaved work, and false again on unmount. */
    onDirtyChange?: ((dirty: boolean) => void) | null;
}
