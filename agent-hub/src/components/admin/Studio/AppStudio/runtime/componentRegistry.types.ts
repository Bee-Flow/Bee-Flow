import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { NodeStyle } from '../inspector/appDefinition';

/** One component type: its renderer and the palette metadata mirrored from the server catalog. */
export interface RegistryEntry {
    /** Takes `NodeProps<P>` for its own `P`; the registry holds them side by side, so no one `P` fits. */
    Component: ComponentType<never>;
    label: string;
    icon: LucideIcon;
    category: string;
    /** Holds child nodes. */
    container?: boolean;
    /** Collects a form value. */
    isInput?: boolean;
    defaultProps: Record<string, unknown>;
    defaultStyle: NodeStyle;
}
