import type { ComponentType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { AppNode } from '../inspector/appDefinition';

/** The props every registered component renders with: its node, and its children. */
export interface ComponentProps {
    node: AppNode;
    children: ReactNode;
}

/** One catalog type: its renderer, its palette metadata and its prop/style templates. */
export interface ComponentEntry {
    Component: ComponentType<ComponentProps>;
    label: string;
    icon: LucideIcon;
    category: string;
    /** Templates: deep-clone before building a node from them. */
    defaultProps: Record<string, unknown>;
    defaultStyle: Record<string, unknown>;
    container?: boolean;
    isInput?: boolean;
}
