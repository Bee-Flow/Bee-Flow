import type { AppDefinition, AppNode } from './appDefinition';
import type { UseEventWiringOptions, WiredAutomation } from './useEventWiring';

/** @param {import('./ActionsSection.types').ActionsSectionProps} props */
export interface ActionsSectionProps {
    node?: AppNode | null;
    definition: AppDefinition;
    onTestActionResult?: ((actionId: string | null, body: unknown) => void) | null;
    onCommit: (definition: AppDefinition) => void;
    disabled?: boolean;
    appId?: string | null;
}

export interface EventWiringProps {
    event: string;
    node: AppNode | null | undefined;
    definition: AppDefinition;
    onTestActionResult?: ((actionId: string | null, body: unknown) => void) | null;
    onCommit: (definition: AppDefinition) => void;
    disabled: boolean;
    automations: WiredAutomation[] | null;
    setAutomations: (automations: WiredAutomation[]) => void;
    titleFor: ((automationId?: string | null) => string | null) | null;
    appId?: string | null;
}
