/**
 * Reading paths, ported from agent-hub `utils/bindingHelpers.ts`, over the
 * ONE path grammar the runtime resolves (shared/expr path.mjs, vendored
 * byte for byte in `@/shared/expr`). server/automation/bind.js walks every
 * ref and `{{ }}` placeholder with the same functions, so a preview on the
 * phone is exactly what the run will see: `["Story Points"]`, `[name="Subject"]`,
 * `[-1]`, JSON text read as the value it encodes, and the same `[*]` rules.
 * This file used to carry its own laxer tokenizer, which previewed spellings
 * (`fields.Story Points`, `value[0x1]`) the run never resolved. Pinned by
 * bindingHelpers.lockstep.test.ts.
 */

// Which text is a path, its canonical spelling and what it is named after
// live one layer down, where the condition model (model/route/) and the
// display helpers (model/displayHelpers) use them too.
export {
    canonicalRefPath, detectTemplate, isCleanPath, pathLabelParts, pathLeafKey, refPathTokens,
} from '../model/pathGrammar';

export { previewValue, walkPath, walkRelativePath } from './mirror/utils/bindingHelpers';
