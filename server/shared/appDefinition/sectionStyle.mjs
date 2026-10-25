// @typecheck
/**
 * Section style vocabulary: the knobs a section has and the style a new
 * section starts with. Shared by the server catalog
 * (server/appStudio/componentSpecs/screenSpec.js) and the editor (inspector and
 * definitionOps), through the generated agent-hub/src/shared/appDefinition/.
 */

// `height` is deliberately NOT in SECTION_STYLE_DEFAULTS: cleanStyle spreads the
// defaults into every section, so adding it there would rewrite every stored
// definition on the next save. Absent means 'auto', exactly as before.
export const SECTION_STYLE_KNOBS = ['padding', 'gap', 'background', 'height'];
export const SECTION_STYLE_DEFAULTS = { padding: 4, gap: 3, background: 'none' };
