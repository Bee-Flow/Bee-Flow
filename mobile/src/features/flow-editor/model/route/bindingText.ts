/**
 * The binding helpers the condition model writes expressions with —
 * `isCleanPath`, `detectTemplate`, `bindingFromInput`, `renderBindingValue` —
 * the web's utils/bindingHelpers.ts functions (the generated mirror under
 * bindings/mirror/utils/), pinned by route.lockstep.test.ts (and by
 * bindings/bindingHelpers.lockstep.test.ts, through the re-export).
 *
 * The one copy: the rest of bindingHelpers (autocomplete, caret edits, path
 * walking, previews) is the variable picker's, in bindings/, which re-exports
 * these from here. They live beside the condition model because the model
 * sits below the bindings layer and must not import it. Paths are read with
 * the runtime's own grammar (model/pathGrammar.ts) and `{{ … }}` with its
 * quote-aware scan, so `{{a["x}}y"]}}` is one placeholder and a picked path
 * is stored in the spelling every other editor writes.
 */

import type { Binding } from '../types';
import {
    bindingFromInput as webBindingFromInput,
    detectTemplate,
    isCleanPath,
    renderBindingValue as webRenderBindingValue,
} from '../../bindings/mirror/utils/bindingHelpers';

export { detectTemplate, isCleanPath };

/**
 * A binding as the right-hand side of an expression: literals as JSON, refs
 * as the bare path, expressions verbatim, a template as an expression fragment.
 */
export const renderBindingValue = webRenderBindingValue as (b: unknown) => string;

/**
 * The binding a typed value means in a mode: 'expression' → a ref (a clean
 * path under a known root, stored in its canonical spelling) or an
 * expression; 'fixed' → a template when it interpolates, else a literal.
 */
export const bindingFromInput = webBindingFromInput as (value: unknown, mode: 'fixed' | 'expression') => Binding;
