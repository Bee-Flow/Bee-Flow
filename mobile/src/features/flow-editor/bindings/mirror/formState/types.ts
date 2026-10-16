/**
 * Shapes shared by the form-state modules. A stored step, a form draft and a
 * patch are plain JSON objects keyed by field name; their keys depend on the
 * step type, so they stay open records rather than one interface per type.
 */

// `any` values: JSON from the step definition, and each step type reads its own keys.
export type FormRecord = Record<string, any>;

/** Any one JSON value read from a step or a draft, before it is checked. */
export type JsonValue = FormRecord[string];

/** The two keys every step type's draft starts from. */
export interface FormBase { label: string; icon: string }

/** One step type's half of extractFormState: stored step -> draft. */
export type TypeExtractor = (step: FormRecord, base: FormBase) => FormRecord;

/** One step type's half of buildPatch: writes its fields into `patch`. */
export type TypePatcher = (patch: FormRecord, step: FormRecord, draft: FormRecord) => void;
