/**
 * The Compliance Center's shared form atoms (audits/auditForms.js) and its
 * status pill, typed for the chat-signals card. Both are plain JavaScript,
 * so TypeScript would read every destructured prop as required; these are
 * the props they actually take (the same casting auditForms.test.tsx uses).
 * Hyphenated attributes such as `data-testid` pass through to the element.
 */
import type React from 'react';
import StatusPillJs from '../../../shared/StatusPill';
import {
    ActionButton as ActionButtonJs,
    DateInput as DateInputJs,
    Field as FieldJs,
    Select as SelectJs,
    TextArea as TextAreaJs,
    TextInput as TextInputJs,
    Toggle as ToggleJs,
} from '../../audits/auditForms';

type Tone = 'success' | 'warning' | 'error' | 'neutral';
type ValueControl<A> = Omit<A, 'value' | 'onChange'> & { value: string; onChange: (value: string) => void };

export const Field = FieldJs as unknown as React.ComponentType<{
    label: React.ReactNode;
    hint?: React.ReactNode | null;
    testId?: string;
    className?: string;
    children?: React.ReactNode;
}>;

export const TextInput = TextInputJs as unknown as React.ComponentType<ValueControl<React.InputHTMLAttributes<HTMLInputElement>>>;
export const DateInput = DateInputJs as unknown as React.ComponentType<ValueControl<React.InputHTMLAttributes<HTMLInputElement>>>;
export const TextArea = TextAreaJs as unknown as React.ComponentType<ValueControl<React.TextareaHTMLAttributes<HTMLTextAreaElement>>>;

export const Select = SelectJs as unknown as React.ComponentType<ValueControl<React.SelectHTMLAttributes<HTMLSelectElement>> & {
    options: Array<{ value: string; label: string }>;
}>;

export const Toggle = ToggleJs as unknown as React.ComponentType<{
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: React.ReactNode;
    hint?: React.ReactNode | null;
    testId?: string;
    disabled?: boolean;
}>;

export const ActionButton = ActionButtonJs as unknown as React.ComponentType<Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
    variant?: 'primary' | 'ghost' | Tone;
    icon?: React.ComponentType<{ size?: number | string }>;
    size?: 'sm';
    children?: React.ReactNode;
}>;

export const StatusPill = StatusPillJs as unknown as React.ComponentType<{
    tone?: Tone;
    testId?: string;
    title?: string;
    className?: string;
    children?: React.ReactNode;
}>;
