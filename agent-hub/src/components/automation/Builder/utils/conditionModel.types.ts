/** Translates `key`, falling back to the English text `en`. */
export type Translate = (key: string, en: string, vars?: Record<string, unknown>) => string;

/** A value the builder binds: a literal, a ref to a data path, or an expression. */
export type Binding = { kind?: string; value?: unknown; path?: unknown } | null | undefined;

/** A binding, or the bare string a saved formula may hold. */
export type Value = Binding | string;

/** One row of the clickable builder; every member is optional because saved rows may lack any. */
export interface ConditionRow {
    field?: Binding;
    op?: string;
    value?: Binding;
    threshold?: unknown;
    quantifier?: string;
    keepBlank?: boolean;
}

interface OperatorBase {
    key: string;
    label: string;
    fn?: string;
    symbol?: string;
    negate?: boolean;
    hidden?: boolean;
}

export type Operator = (OperatorBase & { kind: 'unary'; emit: (left: string) => string })
    | (OperatorBase & { kind: 'fn' | 'cmp' | 'topic' });

export interface OperatorOption {
    key: string;
    label: string;
    disabled?: boolean;
}

export interface OperatorOptions {
    topics?: { available?: boolean } | null;
    quantified?: boolean;
    t?: Translate | null;
}

/** What rules.mjs fieldShape() says about a field path. */
export interface FieldShape {
    kind: string;
    path: string;
    list?: string;
    record?: string;
    column?: string;
}

export interface ParsedCall {
    negate: boolean;
    fn: string;
    args: string[];
}

export interface QuantifiedCall {
    left: string;
    op: string;
    quantifier: string;
    rhs?: string | null;
}

export interface Comparator {
    left: string;
    op: string;
    right: string;
}
