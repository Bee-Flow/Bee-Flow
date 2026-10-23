import type { AppAction, AppDefinition, AppNode, AppScreen, FormFieldRef } from '../inspector/appDefinition';
import type useStepReferences from './useStepReferences';
import type { RefOption, ReferenceKind } from './stepReferences';

export interface StepSettingsProps {
    step: AppAction;
    onChange: (next: AppAction) => void;
    definition: AppDefinition;
    node?: AppNode | null;
    screens?: AppScreen[];
    disabled?: boolean;
    formFields?: FormFieldRef[];
}

/** One field of a step kind, as the catalog's STEP_SPECS describes it. */
export interface FieldSpec {
    type: string;
    required?: boolean;
    values?: string[];
    default?: unknown;
    nullable?: boolean;
    maxLen?: number;
    min?: number | string;
    max?: number | string;
}

export type StepReferences = ReturnType<typeof useStepReferences>;

/** A binding row's value, as the keyed-row editors read it. */
export type RowBinding = { kind?: string; expr?: string; value?: string; name?: string } | null | undefined;

export interface SwitchCase { value?: string | null; steps?: unknown[] }

export interface Placeholder { key: string; kind?: string; fields?: string[] }

export interface StepFieldProps {
    fieldKey: string;
    fs: FieldSpec;
    value: unknown;
    step: AppAction;
    onChange: (next: unknown) => void;
    definition: AppDefinition;
    node: AppNode | null;
    options: Record<string, RefOption[]>;
    references: StepReferences;
    formFields: FormFieldRef[];
    disabled: boolean;
}

/**
 * A reference to something else in the app, as a list of NAMES.
 *
 * A value with nothing behind it any more (the screen was deleted, the table
 * renamed away) keeps its own option so the select still shows what the step
 * says, plus a line naming the problem. Silently snapping to blank would lose
 * the only evidence of what the step used to do.
 */
export interface ReferenceFieldProps {
    label: string;
    hint: string | undefined;
    kind: ReferenceKind;
    value: string;
    onChange: (value: string) => void;
    options: RefOption[];
    disabled: boolean;
}

/** The searchable automation picker, as a field. */
export interface AutomationRefFieldProps {
    label: string;
    hint: string | undefined;
    value: string;
    onChange: (value: string) => void;
    options: RefOption[] | null;
    formFields: FormFieldRef[];
    disabled: boolean;
}

/**
 * The VALUE half of one keyed row — and only the kinds the server accepts for
 * that shape.
 *
 * All three shapes used the full BindingField, which offers a table, a saved
 * view, a connector, an automation's result and an aggregate. Only `recordValues`
 * takes a full binding: `inputMapping` accepts static|field
 * (INPUT_MAPPING_KINDS) and `navParams` accepts static|formula, and anything
 * else is a hard validation error — so picking "A table in this app" for a
 * automation's input made every later autosave 422 with a message about a mapping
 * kind nobody had chosen from a list that offered it.
 */
export interface RowValueFieldProps {
    shape: string;
    value: RowBinding;
    onChange: (next: unknown) => void;
    definition: AppDefinition;
    node: AppNode | null;
    formFields: FormFieldRef[];
    disabled: boolean;
}

/**
 * What each branch of a "Depending on…" step matches.
 *
 * Only the VALUES: the steps inside a case are drawn on the canvas, and are
 * carried through untouched here. The runner compares `case.value` against the
 * step's expression (useActionRunner.caseMatches, loosely, so "2" matches 2),
 * and canonicalize keeps exactly { value, steps } — so a case without a value
 * can never match anything.
 */
export interface SwitchCasesFieldProps {
    label: string;
    value: SwitchCase[] | undefined;
    onChange: (next: unknown) => void;
    disabled: boolean;
}

/**
 * A map of name → value, where each value is a binding. Three spec types share
 * this shape (navigate params, a record's column values, an automation's inputs);
 * they differ only in what the names mean, which the label already says.
 *
 * When the names are COLUMNS of a known table (`columns`), the name box becomes
 * a picker: a mistyped column is a write that fails at run time with a message
 * about a column nobody meant to name.
 *
 * ── WHY A ROW CAN BE UNNAMED WITHOUT BEING COMMITTED ────────────────
 * The stored shape is an OBJECT, so two rows cannot share a name — and a plain
 * Object.fromEntries over the row list resolves that collision by keeping the
 * last one and throwing the other away. That is how it used to work, so
 * clicking "Add one" twice destroyed the first row's binding without a word,
 * and so did renaming one row to match another. An unnamed or clashing row
 * therefore waits in local state until it has a name of its own; only named,
 * unique rows are committed.
 *
 * The other half: `commit([])` used to emit `undefined`, which on a REQUIRED
 * field (create_record's `values`) is a hard validation error — removing the
 * last column made the whole definition unsaveable, with the error surfacing
 * far from the step that caused it. A required field empties to `{}`, a shape
 * the schema accepts, so the app keeps saving while the step is incomplete.
 */
export interface KeyedBindingsFieldProps {
    label: string;
    shape: string;
    value?: Record<string, RowBinding> | null;
    onChange: (next: unknown) => void;
    definition: AppDefinition;
    node: AppNode | null;
    columns?: Array<{ key: string; label: string; required?: boolean }>;
    required?: boolean;
    formFields?: FormFieldRef[];
    disabled: boolean;
}
