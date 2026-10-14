import type { AppDefinition, AppNode } from './appDefinition';

/**
 * The props every component panel under `inspector/panels/` receives from the
 * inspector: the selected node, the app it sits in, and the commit that writes
 * a changed definition back. `definition` is optional because some panels are
 * rendered for a node outside any loaded app.
 */
export interface PanelProps {
    node: AppNode;
    definition?: AppDefinition | null;
    onCommit: (definition: AppDefinition) => void;
    disabled?: boolean;
}
