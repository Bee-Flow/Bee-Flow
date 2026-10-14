import type { AppDefinition } from '../inspector/appDefinition';

/** One role as the panel stages it before a save. */
export interface DraftRole {
    key: string;
    label: string;
}

/** What deleting one role would touch: the groups and the default that use it. */
export interface RoleUsage {
    key: string;
    groupNames: string[];
    isDefault: boolean;
}

export interface RolesManagerProps {
    appId: string | null;
    definition?: AppDefinition | null;
    onCommit?: ((next: AppDefinition) => void) | null;
    onDirtyChange?: ((dirty: boolean) => void) | null;
}
