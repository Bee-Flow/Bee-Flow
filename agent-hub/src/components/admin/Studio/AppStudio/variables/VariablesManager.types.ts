import type { AppDefinition, DefinitionVariable } from '../inspector/appDefinition';
import type { UsageSite } from '../state/variableUsage';

/** Where a variable is used: the node to jump to, on the screen it sits in. */
interface VariableRevealTarget {
    nodeId: string;
    screenId?: string;
}

/** The place a usage row jumps to. */
export interface RevealTarget {
    nodeId: string;
    screenId?: string;
}

export interface VariablesManagerProps {
    definition: AppDefinition | null;
    /** A method type, so a handler that takes a definition stays assignable. */
    onCommit(definition: AppDefinition | null): void;
    onRevealNode?: ((target: RevealTarget) => void) | null;
    disabled?: boolean;
}

/** The starting-value control, following the declared type. */
export interface DefaultFieldProps {
    variable: DefinitionVariable;
    onChange: (value: unknown) => void;
    disabled: boolean;
}

/**
 * A JSON starting value, edited as text. The parsed value is only committed
 * when it parses — typing `{` must not blow away what was there.
 */
export interface JsonDefaultFieldProps {
    variable: DefinitionVariable;
    onChange: (value: unknown) => void;
    disabled: boolean;
    label: string;
    aria: string;
}

/** Where a variable is used, each row jumping to the place. */
export interface UsageListProps {
    sites: UsageSite[];
    onRevealNode: (target: RevealTarget) => void;
}
