/**
 * The document runner's marking PORT.
 *
 * generate_document has to ask "does this org mark AI output, and with which
 * footer" before it renders. The answer is an EU AI Act Art. 50(2) policy and
 * therefore belongs to the compliance feature — but core must not require a
 * feature (layering.test.js), so the feature registers itself here instead.
 *
 * boot/startupTasks.js does the wiring, in the same breath as the compliance
 * scheduler. Nothing registered (a test harness, a build without the feature)
 * means no marking: the document renders unmarked, exactly as it did before
 * marking existed. The runner already logs that case.
 */

let _resolver = null;

/**
 * Register the resolver. `fn(orgId, { automationId, aiStepIds, provider })`
 * resolves to the marking object documentRenderer expects, or null for "this
 * org does not mark".
 */
function setMarkingResolver(fn) {
    _resolver = typeof fn === 'function' ? fn : null;
}

/** True once a feature has registered — the runner logs the difference. */
function hasMarkingResolver() {
    return _resolver !== null;
}

/** Ask the registered resolver; null when none is registered. */
async function resolveMarking(orgId, info) {
    if (!_resolver) return null;
    return _resolver(orgId, info);
}

module.exports = { setMarkingResolver, hasMarkingResolver, resolveMarking };
