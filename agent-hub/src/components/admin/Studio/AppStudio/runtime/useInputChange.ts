import { useCallback, useRef } from 'react';
import type { AppNode } from '../inspector/appDefinition';
import { useFormContext } from './formContext';
import { useRuntime } from './RuntimeContext';

/**
 * `onChange` — run an action the moment a DISCRETE input changes.
 *
 * This is what turns a row of dropdowns into a triage bar: pick a status and it
 * saves, no Save button. Offered only on select / checkbox / date / multiselect;
 * a text field would fire on every keystroke, which is why the spec does not
 * declare the event there.
 *
 * The action receives the WHOLE form's values with this field's new value
 * already applied — `setValue` is async state, so reading the context back on
 * the same tick would hand the action the previous value. That off-by-one is
 * exactly the bug that makes a status bar save the status you picked *before*
 * this one.
 *
 * Run mode only: clicking through a dropdown while designing must not write.
 */
export default function useInputChange(node: Pick<AppNode, 'onChange'> | null | undefined, name: string | null | undefined) {
    const { mode, runAction } = useRuntime();
    const form = useFormContext();

    return useCallback((nextValue: unknown) => {
        if (mode !== 'run') return;
        const actionId = node?.onChange;
        if (!actionId) return;
        const values: Record<string, unknown> = { ...(form?.values || {}) };
        if (name) values[name] = nextValue;
        runAction(actionId, { formValues: values });
    }, [mode, runAction, node?.onChange, form, name]);
}

/**
 * `onChange` for a TEXT editor (input_richtext, input_html; schema 3): once, when the field
 * loses focus with a value other than the one it had when it got focus. Firing per keystroke
 * would run the action on every letter, which is why plain text fields have no onChange.
 *
 * `focus(value)` goes on the editor's focus, `blur(value)` on its blur with the committed
 * value. Run mode only, like useInputChange.
 */
export function useBlurChange(node: Pick<AppNode, 'onChange'> | null | undefined, name: string | null | undefined) {
    const fire = useInputChange(node, name);
    const atFocus = useRef<unknown>(undefined);
    const focus = useCallback((value: unknown) => { atFocus.current = value; }, []);
    const blur = useCallback((value: unknown) => {
        if (value === undefined || value === atFocus.current) return;
        atFocus.current = value;
        fire(value);
    }, [fire]);
    return { focus, blur };
}
