/**
 * Which text is a reference path, and how it is spelled: the ONE path grammar
 * the runtime resolves (shared/expr path.mjs), plus the two things only the
 * builder holds (a flowlet sub-step id `steps.<call>/<sub>`, and the rule
 * that a dashed name the engine reads as a subtraction is a formula), and what
 * a path is NAMED after (pathLabelParts). These are the web's
 * utils/bindingHelpers.ts functions, the generated mirror under
 * bindings/mirror/utils/ (npm run gen:shared).
 *
 * It sits in model/ because the condition model (route/) and the display
 * helpers parse paths too and must not import bindings/; bindings/walkPath.ts
 * re-exports it.
 */

export {
    canonicalRefPath,
    detectTemplate,
    isCleanPath,
    pathLabelParts,
    pathLeafKey,
    refPathTokens,
} from '../bindings/mirror/utils/bindingHelpers';
