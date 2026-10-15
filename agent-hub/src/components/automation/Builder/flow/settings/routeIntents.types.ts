import type { FileFieldOption, FilesInside } from './routeIntentsFiles';

/** A field the rule rows offer: the SAME options the editor builds. */
export type IntentField = FileFieldOption & { type?: string };

/** One suggested output: a port name and the expression behind it. */
export interface IntentRule {
    name: string;
    expr: string;
}

export interface IntentResult {
    kind: string | null;
    understood: string;
    field: IntentField | null;
    rules: IntentRule[];
    problem: string | null;
    problemCode: string | null;
    truncated: boolean;
    filesInside: FilesInside | null;
}

/** Everything `result()` takes: every member is optional. */
export type IntentResultArgs = Partial<IntentResult>;

export interface IntentContext {
    src: string;
    lower: string;
    fields: IntentField[];
    named: IntentField | null;
    topics: boolean;
    element: unknown;
    allFields: IntentField[];
    namedAny: IntentField | null;
}

export interface SuggestOptions {
    fields?: IntentField[];
    /** A topic classifier is installed. */
    topics?: boolean;
    /** One item's sample: is it a file, or does it hold a list of files. */
    element?: unknown;
}

export interface DateClause {
    kind: string;
    at: number;
    end: number;
    a: string;
    b: string | null;
}

export interface NumberClause {
    kind: string;
    at: number;
    end: number;
    a: number;
    b: number | null;
}

export interface MatchCountOptions {
    root?: unknown;
    itemVar?: string;
    host?: object | null;
}
