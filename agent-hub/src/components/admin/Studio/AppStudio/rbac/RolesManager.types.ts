import type { AppDefinition } from '../inspector/appDefinition';

/** @param {import('./RolesManager.types').RolesManagerProps} props */
export interface RolesManagerProps {
    appId: string;
    definition?: AppDefinition | null;
    onCommit?: ((definition: AppDefinition) => void) | null | undefined;
    onDirtyChange?: ((dirty: boolean) => void) | null;
}

export interface SectionHeaderProps {
    icon: React.ReactNode;
    title: string;
    children?: React.ReactNode;
}
