/**
 * Types for the vendored expression engine (index.mjs beside this file).
 *
 * The .mjs files in this folder are byte-for-byte copies of
 * agent-hub/src/shared/expr (which is itself byte-identical to
 * server/shared/expr); exprVendor.lockstep.test.ts holds them to both. This
 * declaration is the only file here that is ours: it describes, it does not
 * change, what those modules export.
 */

/** One segment of a member path: `a`, `.b`, `[expr]`, `[*]`. */
export type ExprPathSegment =
    | { kind: 'name'; v: string }
    | { kind: 'index'; expr: ExprNode }
    | { kind: 'wildcard' };

/** The parsed expression tree `parseExpr` returns. */
export type ExprNode =
    | { kind: 'num'; v: number }
    | { kind: 'str'; v: string }
    | { kind: 'bool'; v: boolean }
    | { kind: 'null' }
    | { kind: 'unop'; op: '!' | '-' | '+'; a: ExprNode }
    | { kind: 'binop'; op: string; a: ExprNode; b: ExprNode }
    | { kind: 'ternary'; cond: ExprNode; a: ExprNode; b: ExprNode }
    | { kind: 'call'; name: string; args: ExprNode[] }
    | { kind: 'path'; segments: ExprPathSegment[] };

export declare class ExprError extends Error {
    constructor(message: string, index?: number);
    /** Character offset of the problem in the source, for an inspector caret. */
    index: number | undefined;
}

export type ExprFunction = (...args: unknown[]) => unknown;

export interface ExprFunctionDoc {
    name: string;
    signature: string;
    description: string;
}

/** A host function: parsed like a whitelisted one, answered by the caller. */
export interface ExprHostFunction {
    /** Parse-time argument check: an error message, or null when the call is fine. */
    check?: (args: ExprNode[]) => string | null;
    /** Thrown when the expression is evaluated without `fn`. */
    unanswered?: string;
    fn?: (...args: unknown[]) => unknown;
}

export type ExprHostTable = Readonly<Record<string, ExprHostFunction>>;

export interface ExprOptions {
    host?: ExprHostTable;
}

/** A host call node (`{ kind: 'call' }`) found by collectHostCalls. */
export type ExprCallNode = Extract<ExprNode, { kind: 'call' }>;

export declare function parseExpr(src: string, opts?: ExprOptions): ExprNode;
export declare function compile(src: string, opts?: ExprOptions): { ast: ExprNode; refs: string[] };
export declare function evaluate(src: string | ExprNode, scope?: unknown, opts?: ExprOptions): unknown;
export declare function tryEvaluate(
    src: string | ExprNode,
    scope?: unknown,
    opts?: ExprOptions,
): { value: unknown; error: string | null };
export declare function collectHostCalls(node: ExprNode, out?: ExprCallNode[]): ExprCallNode[];
export declare const FUNCTIONS: Readonly<Record<string, ExprFunction>>;
export declare const EXPR_FUNCTIONS: readonly ExprFunctionDoc[];
export declare const EXPR_FUNCTION_NAMES: readonly string[];

export declare const TOPIC_FN: 'isAbout';
export declare const TOPIC_HOST_SPEC: ExprHostTable;
export declare const MAX_TOPIC_LABELS: number;
export declare const MAX_TOPIC_LABEL_CHARS: number;
export declare const MAX_TOPIC_TEXT_CHARS: number;
export declare function topicLabel(raw: unknown): string;
export declare function normalizeTopicText(value: unknown): string;
export declare function topicCallsOf(asts: readonly (ExprNode | null | undefined)[]): {
    labels: string[];
    calls: ExprCallNode[];
};
export declare function makeTopicHost(
    scoresByText: Map<string, Record<string, number>>,
    opts?: { defaultThreshold?: number },
): ExprHostTable;

/** True for an array of plain values (text, number, yes/no, or nothing). */
export declare function isScalarList(v: unknown): boolean;

/** How a value reads inside human text: '' for nothing, a joined list, else compact JSON. */
export declare function templateText(v: unknown, opts?: { lists?: 'join' | 'json' }): string;
