// Declarations for ./BindingField.jsx, which is still JavaScript (its binding
// editor is not converted in this pass). Typed here so the TypeScript panels
// that render it can pass well-typed props. The binding value itself stays
// `unknown`: the seven binding kinds are edited by the component, not typed here.
import type { JSX, ReactNode } from 'react';
import type { AppDefinition, AppNode } from '../appDefinition';

export interface BindingFieldProps {
    label: ReactNode;
    value: unknown;
    onChange: (value: unknown) => void;
    definition?: AppDefinition | null;
    node?: AppNode | null;
    componentType?: string;
    hint?: ReactNode;
    placeholder?: string | null;
    singleValue?: boolean;
    onBuild?: ((built: unknown) => void) | null;
    disabled?: boolean;
}

export default function BindingField(props: BindingFieldProps): JSX.Element;
