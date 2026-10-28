// @typecheck strict
/**
 * What renderDocument takes.
 * @typedef {{
 *   content?: string,
 *   contentFormat?: string,
 *   title?: string,
 *   author?: string,
 *   format?: string,
 *   layout?: string,
 *   marking?: import('./documentRenderer').AiMarking | null,
 *   theme?: import('../office/officegen').DeckThemeInput | null,
 *   docxStyle?: ReturnType<typeof import('../docxHouseStyle').buildDocxStylingFromHouseStyle> | null,
 * }} RenderInput
 */

module.exports = {};
