import { createContext, useContext, useMemo, useRef } from 'react';
import { mergeFormValues } from '../runtime/formValues';

/**
 * The LIVE values that are on the screen, readable outside the canvas.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * "Test with screen input" sits in the INSPECTOR (inspector/ActionsSection), and the values live in the CANVAS
 * (editor/Canvas → AppForm publishes them via runtime.registerFormValue). Those are two siblings under the same
 * shell, so there is no prop that runs from one to the other. Without a shared place the test button could only
 * send the STATIC values from the mapping — half of the input, without anyone noticing.
 *
 * ── Why a ref and not state ─────────────────────────────────────────────
 *
 * A shared state value would, on EVERY keystroke in a form, re-render the whole editor — inspector, ribbon, chat
 * and all. The inspector does not need those values to DRAW either; it needs them at the moment Test is pressed.
 * So: a ref with a stable `{ publish, read, readForm }` around it, which never changes identity. Zero extra renders.
 *
 * The canvas additionally keeps its OWN `forms` state, because that feeds the scope in which bindings resolve;
 * the same value is written in the same callback, so the two cannot drift apart.
 *
 * ── What it is NOT ────────────────────────────────────────────────────
 *
 * Not authorisation and not storage. Only "what is in this form right now", per form name, exactly like
 * `forms.<name>` in the expression scope. Whoever uses the values (the test button) must still decide for
 * themselves what may and may not be included — file fields, for example, never go along, see
 * inspector/testPayload.js.
 */

/** `{ [formName]: { [field]: value } }` — what is on the screen right now. */
type ScreenForms = Record<string, Record<string, unknown>>;

/** The store: stable over the shell's whole life. */
export interface ScreenValuesStore {
    publish: (formName: string, values: Record<string, unknown> | null | undefined) => void;
    read: () => ScreenForms;
    readForm: (formName: string | null | undefined) => Record<string, unknown> | null;
}

export const ScreenValuesContext = createContext<ScreenValuesStore | null>(null);

/**
 * De store zelf. Eén per editor-shell; de waarde is stabiel over de hele
 * levensduur, zodat consumenten hem gerust als dependency mogen gebruiken.
 */
export function useScreenValuesStore(): ScreenValuesStore {
    const ref = useRef<ScreenForms>({});
    return useMemo(() => ({
        /** Zelfde vouw als de canvas-scope (mergeFormValues) — één bron, één vorm. */
        publish(formName: string, values: Record<string, unknown> | null | undefined) {
            ref.current = mergeFormValues(ref.current, formName, values);
        },
        /** Alle formulieren, `{ [formName]: { [field]: value } }`. */
        read() {
            return ref.current;
        },
        /**
         * One form, or NULL if that form has published nothing.
         * Null and {} are different answers and must stay that way: null means "this form is not on the
         * screen", {} means "it is there and is empty". The test button reports those two differently too.
         */
        readForm(formName: string | null | undefined) {
            if (!formName) return null;
            const all = ref.current || {};
            return Object.prototype.hasOwnProperty.call(all, formName) ? all[formName] : null;
        },
    }), []);
}

/** De store, of null buiten de editor (de run-pagina heeft geen inspector). */
export function useScreenValues(): ScreenValuesStore | null {
    return useContext(ScreenValuesContext);
}
