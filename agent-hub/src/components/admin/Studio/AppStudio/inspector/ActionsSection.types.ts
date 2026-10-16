import type { AppDefinition, AppNode } from './appDefinition';
import type { UseEventWiringOptions } from './useEventWiring';

/**
 * Props of ActionsSection (ActionsSection.jsx). `onCommit` is called without a
 * guard; the rest may be left out. The section reads `node` and `definition`
 * through `?.` and renders nothing when the node has no events.
 */
export interface ActionsSectionProps {
    node?: AppNode | null;
    definition?: AppDefinition | null;
    onCommit: (next: AppDefinition) => void;
    /** Receives the response of the "Test" run of a wired automation. */
    onTestActionResult?: UseEventWiringOptions['onTestActionResult'];
    disabled?: boolean;
    /** Names this app in an automation made from here; absent = no back-pointer. */
    appId?: string | null;
}
