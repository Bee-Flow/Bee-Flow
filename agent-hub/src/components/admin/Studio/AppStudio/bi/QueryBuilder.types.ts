import type { AppDefinition, AppNode } from '../inspector/appDefinition';
import type { BuiltView } from '../inspector/panels/BindingField.types';

/**
 * Props of QueryBuilder (QueryBuilder.jsx). Every prop may be left out: the
 * body calls `onClose` and `onSave` through `?.`, and without an `appId` it
 * loads no tables.
 */
export interface QueryBuilderProps {
    open?: boolean;
    onClose?: (() => void) | null;
    appId?: string | null;
    /** 'chart' also hands a column mapping to `onSave`; the title differs. */
    componentType?: string;
    onSave?: ((built: BuiltView) => void) | null;
    /** Shows a "go to the tables" link that closes the dialog first. */
    onOpenTables?: (() => void) | null;
}

/**
 * Props of ConfigureDataButton (QueryBuilder.jsx). `patch` is the inspector's
 * updateNodeProps-then-onCommit committer, so a chart lands in ONE history
 * entry; it is called through `?.`. The button renders inert outside the editor
 * shell, where no appId is in scope. Inspectors also pass `node` and
 * `definition` for symmetry; the button ignores them.
 */
export interface ConfigureDataButtonProps {
    patch?: ((patch: Record<string, unknown>) => void) | null;
    /** 'chart' prefills chartType/xKey/series; 'stat' binds `value` instead of `source`. */
    componentType?: string;
    disabled?: boolean;
    node?: AppNode | null;
    definition?: AppDefinition | null;
}
