/**
 * The type names the web's mapping library (mirrored into mirror/mapping/) spells
 * differently from the phone: the mirror's importRewrite points the web's
 * `upstream.types` and `hooks/useTranslation` here, so a mirrored file reads the
 * phone's own types under the web's names. Types only.
 */
import type { FlowNode, Translate, VariableGroup } from './types';

/** What a describer hands the variable picker (the web's `Group`). */
export type Group = VariableGroup & { ownItem?: boolean };
/** One node the upstream walk meets (the web's `UpstreamNode`). */
export type UpstreamNode = FlowNode;
export type TranslateFn = Translate;
export type TranslateParams = Record<string, string | number>;

// The binding helpers' types (the web's utils/bindingHelpers.types.ts), with the
// runtime grammar's own strict token type so the phone's token readers accept them.
export type { PathToken } from '@/shared/expr';
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
