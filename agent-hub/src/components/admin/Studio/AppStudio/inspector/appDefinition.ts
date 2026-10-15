/**
 * The shape of an app definition, as the inspector reads it.
 *
 * `state/definitionOps.js` and the validators own the real schema and are
 * still JavaScript, so every inspector module that touches a definition would
 * otherwise invent its own idea of one. This is that idea, written down once.
 * Only the members the inspector actually reads are named; an index signature
 * carries the rest through untouched, because a field nobody here reads must
 * not become a field this file claims does not exist.
 */

/** One component on a screen. Events live on it as `onClick`, `onSubmit`, … */
export interface AppNode {
    id: string;
    type: string;
    props?: { name?: string; multiple?: boolean; title?: string; label?: string;[key: string]: unknown };
    children?: AppNode[];
    visible?: boolean;
    visibleWhen?: BoolOrFormula;
    enabledWhen?: BoolOrFormula;
    validations?: ValidationRule[];
    computed?: Record<string, FormulaValue>;
    [key: string]: unknown;
}

/** A formula as the schema stores it. Legacy documents hold the bare expression string instead. */
export interface FormulaRef {
    kind?: string;
    expr?: string;
}

export type FormulaValue = string | FormulaRef | null | undefined;

/** A flag that is a plain boolean or a formula. */
export type BoolOrFormula = boolean | FormulaValue;

/** One entry of a node's `validations`: required, format, minLength or formula. */
export interface ValidationRule {
    type: string;
    format?: string;
    value?: number;
    expr?: string;
    message?: string;
}

/** One band of a screen. It holds nodes but is not one — it has no `type`. */
export interface AppSection {
    id?: string;
    type?: string;
    children?: AppNode[];
    [key: string]: unknown;
}

export interface AppScreen {
    id?: string;
    name?: string;
    sections?: AppSection[];
    [key: string]: unknown;
}

export interface AppDefinition {
    screens?: AppScreen[];
    actions?: Record<string, AppAction>;
    [key: string]: unknown;
}

/**
 * One inputMapping row. `name` belongs to `kind: 'field'` and `value` to
 * `kind: 'static'`, but they are not split into a union: the editor renders
 * both controls off the same object and reads whichever the current mode
 * needs, so a half-filled row is a state this shape has to be able to hold.
 */
export interface InputMapping {
    kind: 'field' | 'static';
    name?: string;
    value?: string;
}

/** One value a navigate action carries to the next screen. */
export interface NavigateParam {
    kind: 'static' | 'formula';
    value?: string;
    expr?: string;
}

/** An action's bounded onSuccess/onError effects. */
export interface ActionEffect {
    toast?: { message?: string; tone?: string };
    navigateTo?: string | null;
    [key: string]: unknown;
}

export interface AppAction {
    kind: string;
    /** A `sequence` action's steps, each of which is a step kind of its own. */
    steps?: unknown[];
    automationId?: string;
    screenId?: string;
    modalId?: string;
    message?: string;
    url?: string;
    inputMapping?: Record<string, InputMapping>;
    onSuccess?: ActionEffect;
    onError?: ActionEffect;
    [key: string]: unknown;
}

/** One parameter of the target automation's DECLARED contract. */
export interface ParamMeta {
    type: string;
    required: boolean;
    description?: string;
}

/** That contract, by parameter name. Null when the automation declares none. */
export type ParamMetaByName = Record<string, ParamMeta>;

/** One input field of the form an action sits in. */
export interface FormFieldRef {
    name: string;
    type: string;
    multiple: boolean;
}

/**
 * Which component, in which screen, of which app. Only ever whole: two thirds
 * of a back-pointer is worse than none, so there is no partial form of this.
 */
export interface AppRef {
    appId: string;
    screenId: string;
    nodeId: string;
}

/**
 * What every per-type Content panel receives. `P` names the props of the one
 * component type the panel edits; the node's own `props` then reads as those
 * members and nothing is claimed about the rest.
 */
export interface PanelProps<P = Record<string, unknown>> {
    node: AppNode & { props?: P };
    definition: AppDefinition;
    onCommit: (definition: AppDefinition) => void;
    disabled?: boolean;
}
