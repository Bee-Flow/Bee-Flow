import type { ComponentType, ReactNode } from 'react';
import type { AppDefinition, AppNode } from '../appDefinition';
import BindingFieldJs from './BindingField';

/**
 * The props BindingField takes, as the inspector panels pass them. BindingField
 * itself is still JavaScript, and its props are only inferred from its
 * destructuring (which makes `hint` required and `placeholder` a null-only
 * type), so this file states the contract the callers already keep.
 */
export interface BindingFieldProps {
    label?: ReactNode;
    value?: unknown;
    onChange: (v: unknown) => void;
    definition: AppDefinition;
    node?: AppNode | null;
    componentType?: string;
    hint?: ReactNode;
    placeholder?: string | null;
    singleValue?: boolean;
    onBuild?: (() => void) | null;
    disabled?: boolean;
}

export const BindingField = BindingFieldJs as ComponentType<BindingFieldProps>;
