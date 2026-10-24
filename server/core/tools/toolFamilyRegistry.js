// @typecheck
/**
 * Tool family registry: which executor runs a tool call, by name.
 *
 * Core owns the dispatcher, the features own their tools. Each tool family
 * (Gmail, Nextcloud, image generation, ...) registers itself here with a name
 * predicate and an executor, so `core/tools/toolDispatcher.js` can route a call
 * without requiring a single feature module (server/ARCHITECTURE.md: CORE must
 * not require a FEATURE). Core's own families register from
 * `builtinToolFamilies.js`; the integration families from
 * `integrations/toolFamilies.js`, which the server loads at boot and every test
 * that runs the real dispatcher against an integration tool loads itself.
 *
 * A family:
 *   name     unique id. Registering the same name again replaces the entry, so
 *            loading a registering module twice is harmless.
 *   isTool   (toolName) => boolean
 *   execute  (toolName, toolArgs, context) => result. The context is the
 *            dispatcher's, untouched. Returning NOT_HANDLED passes the call on
 *            to the next family that claims the name (and finally to the
 *            dispatcher's dynamic fallbacks), as the Nextcloud family does for
 *            a nextcloud_* name none of its sub-apps owns.
 *   order    position in the walk, ascending; equal orders keep registration
 *            order. It matters where two predicates overlap: n8n workflow
 *            tools are also n8n_* tools, and the Nextcloud sub-app families
 *            share the nextcloud_ prefix. Any other property is kept on the
 *            entry for callers that look a family up by name.
 */

const NOT_HANDLED = Symbol('toolFamily.notHandled');

/** Sorted by `order`, stable. */
const families = [];

function registerToolFamily(family) {
    const { name, isTool, execute, order = 1000 } = family || {};
    if (typeof name !== 'string' || !name) throw new TypeError('registerToolFamily: name must be a non-empty string');
    if (typeof isTool !== 'function') throw new TypeError(`registerToolFamily(${name}): isTool must be a function`);
    if (typeof execute !== 'function') throw new TypeError(`registerToolFamily(${name}): execute must be a function`);
    if (!Number.isFinite(order)) throw new TypeError(`registerToolFamily(${name}): order must be a finite number`);
    const entry = Object.freeze({ ...family, order });
    unregisterToolFamily(name);
    families.push(entry);
    families.sort((a, b) => a.order - b.order);
    return entry;
}

function unregisterToolFamily(name) {
    const at = families.findIndex(f => f.name === name);
    if (at === -1) return false;
    families.splice(at, 1);
    return true;
}

function getToolFamily(name) {
    return families.find(f => f.name === name) || null;
}

/** A snapshot, in walk order. */
function listToolFamilies() {
    return families.slice();
}

/**
 * Run the first family that claims `toolName` and does not pass it on.
 * Returns { handled: true, result } or { handled: false }.
 */
async function dispatchToToolFamily(toolName, toolArgs, context) {
    for (const family of families.slice()) {
        if (!family.isTool(toolName)) continue;
        const result = await family.execute(toolName, toolArgs, context);
        if (result !== NOT_HANDLED) return { handled: true, result };
    }
    return { handled: false };
}

module.exports = {
    NOT_HANDLED,
    registerToolFamily,
    unregisterToolFamily,
    getToolFamily,
    listToolFamilies,
    dispatchToToolFamily,
};
