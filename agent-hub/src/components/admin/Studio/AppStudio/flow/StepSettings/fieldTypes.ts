/**
 * The controls of step field types that came after the built-in ones: one file
 * per type under `fieldTypes/<type>.tsx`, default-exporting `{ type, Control }`.
 * StepField asks here first for a type it has no own control for, so a new field
 * type (a code editor, a text-or-formula input, a map of bindings) is added by a
 * file, not by another case in StepField.
 */
import type { ComponentType } from 'react';
import type { StepFieldProps } from '../StepSettings.types';

/** What a registered control receives: everything StepField has, plus the label and hint it worked out. */
export interface StepFieldControlProps extends StepFieldProps {
    label: string;
    hint?: string;
    required: boolean;
}

export interface StepFieldTypeModule {
    /** The field `type` in the step spec this control edits. */
    type: string;
    Control: ComponentType<StepFieldControlProps>;
}

/** The field types StepField draws itself; a file may not take one of these over. */
export const BUILT_IN_FIELD_TYPES: readonly string[] = [
    'formula', 'binding', 'enum', 'boolean', 'int', 'tierChoice', 'retry', 'errorHandler', 'switchCases',
    'navParams', 'callParams', 'recordValues', 'inputMapping', 'url', 'string',
];

/** type → control, from what `import.meta.glob` hands over (path → module). */
export function buildFieldControls(modules: Record<string, { default: StepFieldTypeModule }>): Record<string, ComponentType<StepFieldControlProps>> {
    const controls: Record<string, ComponentType<StepFieldControlProps>> = {};
    for (const file of Object.keys(modules).sort()) {
        const entry = modules[file].default;
        const name = file.slice(file.lastIndexOf('/') + 1, file.lastIndexOf('.'));
        if (!entry || entry.type !== name || typeof entry.Control !== 'function') throw new Error(`Step field type file ${file} must export { type, Control } for its own type as default`);
        if (BUILT_IN_FIELD_TYPES.includes(name)) throw new Error(`Step field type file ${file} names a built-in field type`);
        controls[name] = entry.Control;
    }
    return controls;
}

const CONTROLS = buildFieldControls(import.meta.glob<{ default: StepFieldTypeModule }>(['./fieldTypes/*.tsx', '!./fieldTypes/*.test.tsx'], { eager: true }));

/** The registered control of a field type, or null (StepField then draws its own). */
export function fieldControlFor(type: string, controls: Record<string, ComponentType<StepFieldControlProps>> = CONTROLS): ComponentType<StepFieldControlProps> | null {
    return Object.hasOwn(controls, type) ? controls[type] : null;
}
