// @typecheck strict
/**
 * App Studio catalog — component types added after the frozen base.
 *
 * One file per type in componentSpecs/types/<type>.js, exporting the type's spec (the same
 * shape as an entry of the base tables) plus two fields every extension must carry:
 *
 *   since:  3 or more (the schema version the type needs; the base types carry none)
 *   mobile: { reason }  why the phone leaves it to the browser. An extension type is
 *           browser-only on the phone until the phone client draws it, and the reason is
 *           what the phone's catalog (mobile/.../apps/model/catalog.ts) shows for it.
 *
 * The hub (componentSpecs.js) appends these after the base list, in file-name order, so the
 * base order (palette, AI catalog, canonical output) never moves. The directory ships empty.
 */

'use strict';

const { listRegistryFiles, requireSince } = require('./registryDir');

/**
 * @typedef {import('./styleKnobs').ComponentSpec & { since?: number, mobile?: { reason?: string } }} ExtensionSpec
 *   A component spec as a registry file exports it.
 * @typedef {{ baseSpecs: Record<string, unknown>, styleKnobs: Record<string, unknown>, eventNames: readonly string[] }} ExtensionContext
 */

const TEXT_FIELDS = /** @type {const} */ (['label', 'description', 'category']);

/**
 * Check one extension spec against the base; throws on anything that would make it unsafe.
 * @param {string} type
 * @param {ExtensionSpec | null | undefined} spec
 * @param {ExtensionContext} ctx
 * @param {string} where
 * @returns {asserts spec is ExtensionSpec}
 */
function checkTypeExtension(type, spec, ctx, where) {
    if (!spec || typeof spec !== 'object') throw new Error(`${where}: exports the type's spec object`);
    if (Object.prototype.hasOwnProperty.call(ctx.baseSpecs, type)) throw new Error(`${where}: "${type}" is a base type; an extension adds a new one`);
    requireSince(spec.since, where);
    if (!spec.mobile || typeof spec.mobile.reason !== 'string' || !spec.mobile.reason.trim()) {
        throw new Error(`${where}: an extension type carries mobile.reason (why the phone leaves it to the browser)`);
    }
    checkSpecShape(spec, ctx, where);
}

/**
 * @param {ExtensionSpec} spec
 * @param {ExtensionContext} ctx
 * @param {string} where
 */
function checkSpecShape(spec, ctx, where) {
    for (const field of TEXT_FIELDS) {
        if (typeof spec[field] !== 'string' || !spec[field]) throw new Error(`${where}: ${field} must be a non-empty string`);
    }
    if (!spec.props || typeof spec.props !== 'object') throw new Error(`${where}: props must be an object`);
    if (!Array.isArray(spec.styleKnobs)) throw new Error(`${where}: styleKnobs must be an array`);
    for (const knob of spec.styleKnobs) {
        if (!Object.prototype.hasOwnProperty.call(ctx.styleKnobs, knob)) throw new Error(`${where}: unknown style knob "${knob}"`);
    }
    for (const event of spec.events || []) {
        if (!ctx.eventNames.includes(event)) throw new Error(`${where}: unknown event "${event}"`);
    }
}

/**
 * The extension types in `dir`, as a null-prototype `{ [type]: spec }` in file-name order.
 * @param {string} dir
 * @param {ExtensionContext} ctx
 * @returns {Record<string, ExtensionSpec>}
 */
function loadTypeExtensions(dir, ctx) {
    /** @type {Record<string, ExtensionSpec>} */
    const out = Object.create(null);
    for (const { name, file } of listRegistryFiles(dir)) {
        /** @type {ExtensionSpec | null | undefined} */
        const spec = require(file);
        checkTypeExtension(name, spec, ctx, file);
        out[name] = spec;
    }
    return out;
}

module.exports = { loadTypeExtensions, checkTypeExtension };
