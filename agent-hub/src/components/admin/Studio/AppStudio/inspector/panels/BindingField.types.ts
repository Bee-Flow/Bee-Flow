import type { ReactNode } from 'react';
import type { ChartMapping } from '../../bi/ChartDataPanel';
import type { BindingInput } from '../../runtime/resolveBinding.types';
import type { AppDefinition, AppNode } from '../appDefinition';

/** What the query builder hands back after saving a view. */
export interface BuiltView {
    datasetId: string;
    chart?: ChartMapping | null;
}

/**
 * Props of BindingField (BindingField.jsx). Every prop may be left out except
 * `onChange`, which the field calls without a guard.
 *
 * `value` is whatever the node stores, so it stays `unknown`: a binding object,
 * or a bare literal (string, number, boolean, array, or a plain object without
 * `kind`) that the field treats as `{ kind: 'static', value }`. `onChange`
 * always emits a binding object, never a bare literal.
 */
export interface BindingFieldProps {
    label?: ReactNode;
    value?: unknown;
    onChange: (next: BindingInput) => void;
    definition?: AppDefinition | null;
    node?: AppNode | null;
    componentType?: string;
    hint?: ReactNode;
    placeholder?: string | null;
    singleValue?: boolean;
    onBuild?: ((built: BuiltView) => void) | null;
    disabled?: boolean;
}
