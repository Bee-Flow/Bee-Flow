/** A form's fields: which ones the phone can draw, their defaults, what is missing. */

import { parseDecimal } from '@/shared/lib/decimal';

import { isSupportedInput, type SupportedInput } from './catalog';
import { bool, defaultDate, num, optionList, str, type SelectOption } from './props';
import type { AppFormValues, AppNode } from './types';

export interface AppInput {
    node: AppNode;
    type: SupportedInput;
    /** The key the value is submitted under — `props.name`, required by spec. */
    name: string;
    label: string;
    placeholder: string | null;
    required: boolean;
    options: SelectOption[];
    min: number | null;
    max: number | null;
    rows: number;
    inputType: 'text' | 'email' | 'url';
    initial: string | number | boolean | null;
}

export function collectInputs(root: AppNode, noteUnsupported: (type: string) => void): AppInput[] {
    const out: AppInput[] = [];
    const walk = (nodes: AppNode[] | undefined) => {
        for (const node of nodes ?? []) {
            if (!node || node.visible === false) continue;
            if (isSupportedInput(node.type)) {
                const input = toInput(node, node.type);
                if (input) out.push(input);
                continue;
            }
            if (node.type.startsWith('input_')) {
                // A field the phone cannot draw must be named: a form silently
                // missing its file picker submits an incomplete payload and
                // the failure surfaces as a runtime error much later.
                noteUnsupported(node.type);
                continue;
            }
            // Anything else inside a form is content — a heading, a paragraph,
            // a callout. A form block holds inputs only, so this cannot be
            // drawn here, and it used to vanish without a word. With `form` in
            // 12 of 12 shipped templates and `text` appearing 464 times, that
            // was the largest silent hole in this renderer. Containers still
            // recurse; leaves get named.
            if (!node.children?.length) {
                noteUnsupported(node.type);
                continue;
            }
            walk(node.children);
        }
    };
    walk(root.children);
    return out;
}

function initialOf(type: SupportedInput, props: Record<string, unknown>): AppInput['initial'] {
    if (type === 'input_checkbox') return bool(props.defaultChecked, false);
    if (type === 'input_number') return num(props.defaultValue) ?? null;
    if (type === 'input_date') return defaultDate(str(props.defaultValue));
    return str(props.defaultValue) ?? null;
}

function toInput(node: AppNode, type: SupportedInput): AppInput | null {
    const props = node.props ?? {};
    const name = str(props.name);
    if (!name) return null;

    return {
        node,
        type,
        name,
        label: str(props.label) ?? name,
        placeholder: str(props.placeholder) ?? null,
        required: bool(props.required, false),
        options: optionList(props.options),
        min: num(props.min) ?? null,
        max: num(props.max) ?? null,
        rows: num(props.rows) ?? 4,
        inputType: (str(props.inputType) as AppInput['inputType']) ?? 'text',
        initial: initialOf(type, props),
    };
}

export function initialValues(inputs: AppInput[]): AppFormValues {
    const values: AppFormValues = {};
    for (const input of inputs) values[input.name] = input.initial;
    return values;
}

/** Whether a field's value counts as not filled in (a checkbox must be ticked). */
export function isEmptyValue(input: Pick<AppInput, 'type'>, value: AppFormValues[string] | undefined): boolean {
    if (input.type === 'input_checkbox') return value !== true;
    return value === null || value === undefined || String(value).trim() === '';
}

/** Names of the required fields that are still empty. */
export function missingRequired(inputs: AppInput[], values: AppFormValues): string[] {
    return inputs
        .filter((input) => input.required && isEmptyValue(input, values[input.name]))
        .map((input) => input.label);
}

/**
 * A number field's text as the form's value: the number once the text is one
 * (with a dot or a decimal comma), null when it is empty, and otherwise the
 * text itself — so a half-typed or mistyped number is refused at the button
 * (`invalidNumbers`) instead of being sent as the last number it resembled.
 */
export function numberAnswer(text: string): string | number | null {
    if (text.trim() === '') return null;
    return parseDecimal(text) ?? text;
}

/** Labels of the number fields holding text that is not a number. */
export function invalidNumbers(inputs: AppInput[], values: AppFormValues): string[] {
    return inputs
        .filter((input) => input.type === 'input_number' && typeof values[input.name] === 'string')
        .map((input) => input.label);
}
