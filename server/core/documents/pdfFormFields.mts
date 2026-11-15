/**
 * The AcroForm fields of a PDF and what was filled into them, through pdf.js
 * `getFieldObjects()`.
 *
 * pdf.js keeps form values out of the text layer (`getTextContent` reads the
 * page content stream; a field's value lives in its widget annotation), so a
 * filled-in form read as text shows the labels and none of the answers. This
 * reads the answers.
 *
 * Shape: one `{ name, value, type }` per terminal field, in document order.
 *   text                  value is the string (empty when not filled in)
 *   checkbox              value is true when ticked, false when not
 *   radiobutton           value is the export value of the chosen option, or null
 *   combobox / listbox    value is the chosen export value (an array when several may be chosen)
 * Push buttons and signature fields carry no answer and are left out. A
 * non-terminal field (a parent that only groups kids) has no widget of its own
 * and is skipped; its kids come through under their full dotted name.
 *
 * pdf.js 4+ answers with a Map, older versions with a plain object: both are read.
 */

export type FormFieldType = 'text' | 'checkbox' | 'radiobutton' | 'combobox' | 'listbox';
export type FormFieldValue = string | boolean | string[] | null;
export interface FormField { name: string; value: FormFieldValue; type: FormFieldType }

/** One widget as getFieldObjects describes it; only the keys read here. */
interface FieldWidget { type?: string; value?: unknown; multipleSelection?: boolean; kidIds?: unknown }

type FieldObjects = Map<string, FieldWidget[]> | Record<string, FieldWidget[]> | null | undefined;

interface PdfDoc { getFieldObjects(): Promise<FieldObjects> }
interface PdfjsModule {
    getDocument(src: { data: Uint8Array; isEvalSupported?: boolean; useSystemFonts?: boolean; verbosity?: number }): { promise: Promise<PdfDoc>; destroy(): Promise<void> };
}
/** pdf.js VerbosityLevel.ERRORS: its warnings (an unsupported push button, a missing font) are not ours to log. */
const PDFJS_ERRORS_ONLY = 0;

const ANSWER_TYPES: ReadonlySet<string> = new Set(['text', 'checkbox', 'radiobutton', 'combobox', 'listbox']);
/** The value pdf.js reports for an unticked checkbox or a radio group with nothing chosen. */
const OFF = 'Off';

let pdfjsPromise: Promise<PdfjsModule> | null = null;
function loadPdfjs(): Promise<PdfjsModule> {
    pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfjsModule>;
    return pdfjsPromise;
}

function entriesOf(objects: FieldObjects): Array<[string, FieldWidget[]]> {
    if (!objects) return [];
    if (objects instanceof Map) return [...objects.entries()];
    return Object.entries(objects);
}

function asText(v: unknown): string {
    return typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v));
}

/** Nothing chosen: no value, an empty one, or the "Off" state of a button. */
function isUnset(raw: unknown): boolean {
    return raw === undefined || raw === null || raw === '' || raw === OFF || raw === false;
}

/** A combobox or listbox: the chosen export value, or the list of them when several may be chosen. */
function choiceValue(raw: unknown, multiple: boolean): FormFieldValue {
    const chosen = (Array.isArray(raw) ? raw : (isUnset(raw) ? [] : [raw])).map(asText);
    if (multiple) return chosen;
    return chosen.length ? chosen[0] : null;
}

function valueOf(type: FormFieldType, widget: FieldWidget): FormFieldValue {
    const raw = widget.value;
    if (type === 'text') return asText(raw);
    if (type === 'checkbox') return !isUnset(raw);
    if (type === 'radiobutton') return isUnset(raw) ? null : asText(raw);
    return choiceValue(raw, widget.multipleSelection === true);
}

/** The answer-carrying fields out of a getFieldObjects() result (exported for tests). */
export function formFieldsFromObjects(objects: FieldObjects): FormField[] {
    const out: FormField[] = [];
    for (const [name, widgets] of entriesOf(objects)) {
        if (!Array.isArray(widgets)) continue;
        // A radio group lists one widget per option, all carrying the group's
        // value: the first widget with an answer type speaks for the field.
        const widget = widgets.find((w) => w && typeof w.type === 'string' && ANSWER_TYPES.has(w.type));
        if (!widget) continue;
        const type = widget.type as FormFieldType;
        out.push({ name, value: valueOf(type, widget), type });
    }
    return out;
}

/**
 * The filled-in AcroForm fields of a PDF. A PDF without a form gives [];
 * a file pdf.js cannot open throws.
 */
export async function readPdfFormFields(buffer: Uint8Array): Promise<FormField[]> {
    const pdfjs = await loadPdfjs();
    const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true, verbosity: PDFJS_ERRORS_ONLY });
    try {
        const doc = await task.promise;
        return formFieldsFromObjects(await doc.getFieldObjects());
    } finally {
        await task.destroy().catch(() => undefined);
    }
}
