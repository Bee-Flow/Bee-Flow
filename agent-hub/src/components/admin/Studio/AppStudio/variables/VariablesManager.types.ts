import type { AppDefinition } from '../inspector/appDefinition';

/** Where a variable is used: the node to jump to, on the screen it sits in. */
export interface RevealTarget {
    nodeId: string;
    screenId?: string;
}

/**
 * Props of VariablesManager (VariablesManager.jsx). Every prop may be left
 * out: the body reads the variables through `listVariables`, which accepts no
 * definition at all, and renders without `onCommit`. Every edit calls `onCommit`
 * without a guard, so a manager given none can show the variables but not
 * change them.
 */
export interface VariablesManagerProps {
    definition?: AppDefinition | null;
    onCommit?: ((next: AppDefinition) => void) | null;
    /** Makes the usage list clickable; absent = the sites are only listed. */
    onRevealNode?: ((target: RevealTarget) => void) | null;
    disabled?: boolean;
}
