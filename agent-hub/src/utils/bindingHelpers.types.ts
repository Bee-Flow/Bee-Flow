/** One step of a parsed path (shared/expr/path.mjs): a key or index, a `[*]`, or a `[name="x"]` match. */
export interface PathToken {
    type: string;
    key?: string | number;
    raw?: string;
    bare?: boolean;
    value?: unknown;
}

/** A node of the expression AST, as far as `readsAsArithmetic` looks. */
export interface AstNode {
    kind?: string;
    op?: string;
    a?: AstNode;
    b?: AstNode;
    segments?: unknown[];
}

/** A stored binding, or anything shaped like one. */
export interface BindingLike {
    kind?: string;
    value?: unknown;
    path?: unknown;
}

export type BindingInput = BindingLike | string | number | boolean | null | undefined;

export type TextControl = HTMLInputElement | HTMLTextAreaElement;
