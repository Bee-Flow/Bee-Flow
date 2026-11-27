// @typecheck strict
/** Short reply suggestions are text messages, never action identifiers or approvals.
 * @param {string} action @param {unknown} values @returns {string[]} */
function replyOptions(action, values) {
    if (action !== 'answer' || !Array.isArray(values)) return [];
    const labels = values.filter(v => typeof v === 'string' && v.trim() && v.length <= 80).map(v => v.trim());
    const distinct = [...new Set(labels)].slice(0, 4);
    return distinct.length >= 2 ? distinct : [];
}
const panelSections = new Map([
    ['preferences', ['mail', 'suggestions']],
    ['templates', ['import']],
    ['org', ['budget', 'apps', 'policy', 'proof']],
]);

/** @param {string} action @param {unknown} value */
function panelSection(action, value) {
    return typeof value === 'string' && panelSections.get(action)?.includes(value) ? value : undefined;
}
module.exports = { replyOptions, panelSection };
