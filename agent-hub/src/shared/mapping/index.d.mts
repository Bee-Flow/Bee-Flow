/**
 * Types for the shared mapping core (index.mjs beside this file).
 *
 * Generated copies of this file sit next to the generated copies of the core
 * in agent-hub/src/shared/mapping/ and mobile/src/shared/mapping/vendor/, so
 * TypeScript on both clients reads the same declarations. Keep it in step
 * with index.mjs: mappingVendor.lockstep.test.ts (mobile) fails when a name
 * is exported without being declared, or declared without being exported.
 */

/** One token of a legacy path: a key or index, or the `[*]` wildcard. */
export type LegacyToken = { type: 'prop'; key: string | number } | { type: 'wild' };

/** The legacy `[*]` segment of a Source parsed from a stored path. */
export type WildSegment = { readonly wild: true };

/** A segment of a Source path: an object key, an array index, or a legacy `[*]`. */
export type SourceSegment = string | number | WildSegment;

/** Where a value comes from. `path` is relative to the step's or trigger's `output`. */
export type Source =
    | { root: 'steps'; id: string; path: SourceSegment[] }
    | { root: 'loop'; id: string; path: SourceSegment[] }
    | { root: 'trigger'; path: SourceSegment[] }
    | { root: 'vars'; path: SourceSegment[] };

export interface TemplateOptions {
    leaveUnresolved?: boolean;
    listAsMarkdown?: boolean;
}

export interface ResolveOptions {
    allowSecrets?: boolean;
}

export interface LegacyResolver {
    resolveValue(binding: unknown, runState: object, opts?: ResolveOptions): unknown;
    resolveDeep(structure: unknown, runState: object, opts?: ResolveOptions): unknown;
    resolveInputs(inputs: unknown, runState: object, opts?: ResolveOptions): Record<string, unknown>;
    interpolateTemplate(template: unknown, runState: object, opts?: TemplateOptions): string;
}

export declare const REF_RE: RegExp;
export declare function cloneLiteral<T>(value: T): T;
export declare function tokenizePath(path: string): LegacyToken[] | null;
export declare function resolveTokens(tokens: LegacyToken[], cur: unknown): unknown;
export declare function walkPath(path: unknown, root: unknown): unknown;
export declare function walkRelativePath(path: unknown, value: unknown): unknown;
export declare function interpolateTemplate(
    template: unknown,
    runState: object | null | undefined,
    opts?: TemplateOptions,
    onUnresolved?: (path: string) => void,
): string;
export declare function createLegacyResolver(deps: {
    evaluate: (src: string, scope: object) => unknown;
    onUnresolved?: (path: string) => void;
}): LegacyResolver;
export declare const WILD: WildSegment;
export declare function isWild(seg: unknown): seg is WildSegment;
export declare function parseLegacyPath(path: unknown): Source | null;
export declare function formatPath(source: unknown): string | null;
export declare function lastSegment(pathOrSource: unknown): string | number | undefined;
