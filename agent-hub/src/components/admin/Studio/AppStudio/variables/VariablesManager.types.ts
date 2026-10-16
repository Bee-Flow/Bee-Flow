import type { AppDefinition } from '../inspector/appDefinition';

/** Where a variable is used: the node to jump to, on the screen it sits in. */
export interface VariableRevealTarget {
    nodeId: string;
    screenId?: string;
}

/**
 * Props of VariablesManager (VariablesManager.jsx). Every edit calls
 * `onCommit` without a guard, so it is required. The rest may be left out: the
 * variables are read through `listVariables`, which accepts no definition.
 */
export interface VariablesManagerProps {
    definition?: AppDefinition | null;
    onCommit: (next: AppDefinition) => void;
    /** Makes the usage list clickable; absent = the sites are only listed. */
    onRevealNode?: ((target: VariableRevealTarget) => void) | null;
    disabled?: boolean;
}
