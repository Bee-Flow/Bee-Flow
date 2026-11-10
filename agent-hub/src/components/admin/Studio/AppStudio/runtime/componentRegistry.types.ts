import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { NodeStyle } from '../inspector/appDefinition';

/** What the web keeps by hand per type: the renderer and the palette icon. */
export type ComponentRenderer = Pick<RegistryEntry, 'Component' | 'icon'>;

/** An example node of a type, without id or type: what the editor and the tests place. */
interface ComponentSample {
    props?: Record<string, unknown>;
    style?: NodeStyle;
    children?: unknown[];
}

/** A type added after the base catalog (components/registry/<type>.ts): its renderer, icon and sample. */
export interface ComponentExtension extends ComponentRenderer {
    sample: ComponentSample;
}

/** One component type: its renderer and the palette metadata from the server catalog (catalogSnapshot.generated.json). */
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
    /** Only on a type added after the base catalog (componentExtensions.ts). */
    sample?: ComponentSample;
}
