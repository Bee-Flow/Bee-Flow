import type { BindingInput } from '../../../../utils/bindingHelpers.types';
import type { Binding, ForEachConfig } from './itemRefs';
import type { OnFocusField } from './focusField.types';

/**
 * Single mapping-aware field. The user sees one input and one mode
 * toggle ("=" / "Aa") — the binding kinds (literal/ref/template/expr)
 * are inferred automatically:
 *
 *   fixed (Aa):
 *     - plain text                       → { kind: 'literal' }
 *     - text containing "{{...}}"        → { kind: 'template' }
 *
 *   expression (=):
 *     - clean dotted path                → { kind: 'ref' }
 *     - anything else                    → { kind: 'expr' }
 *
 * Focus-broadcast: when this field is focused, it calls
 * `onFocusField({ label, insert })`. The parent (StepInspector) parks
 * that handle and forwards click-to-insert / drag-to-insert from the
 * VariableTree by calling `insert(path)`. The handle does the cursor-
 * aware splice and emits onChange in one shot.
 *
 * Preview: `previewSample` (a runtime-resolved root sample tree) lets us
 * show "preview: <value>" beneath the field. The parent passes the
 * merged sample tree (trigger sample + upstream step samples + loop) so
 * walkPath() can resolve any bound path locally.
 */
export type FieldValue = BindingInput;

/** The mismatch box that is open under the field. */
export interface ResolverState {
    path: string;
    selectedId: string;
    actualKind: string;
}

export interface BindingFieldProps {
    value?: FieldValue;
    onChange?: (parsed: Binding) => void;
    onFocusField?: OnFocusField | null;
    previewSample?: unknown;
    onRequestForEach?: ((fe: ForEachConfig | null | undefined) => void) | null;
    listAs?: string | null;
    label?: string | null;
    hint?: string | null;
    required?: boolean;
    placeholder?: string;
    multiline?: boolean;
    autoMapped?: boolean;
    showExpressionHelp?: boolean;
    expectShape?: string | null;
    expectKind?: string | null;
}

export interface OnPillClickArgs {
    el: HTMLElement;
    path: string;
}
