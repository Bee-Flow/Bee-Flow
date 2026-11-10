// @typecheck strict
/**
 * App Studio catalog — style knob groups added after the frozen base.
 *
 * A knob GROUP is a set of knobs a style list earns by rule, the way the advanced width pair
 * rides with `span` (styleKnobs.js, expandStyleKnobs). One file per group in
 * componentSpecs/styleKnobGroups/<group>.js:
 *
 *   module.exports = {
 *       since: 3,
 *       grantedBy: 'span',          // a knob the list already has, or '*' for every list
 *                                   // (every component type AND the section)
 *       knobs: { myKnob: { type: 'enum', values: ['none', 'a'], default: 'none', since: 3 } },
 *   };
 *
 * The knobs join STYLE_KNOBS after the base knobs, so canonicalize, validate and the catalogue
 * see them, and no per-type `styleKnobs` list is edited. A knob is never written out unless a
 * definition sets it: canonicalize fills only a type's `defaultStyle`, which an extension knob
 * may not be part of. The web draws a group with runtime/styleKnobs/<group>.ts. The directory
 * ships empty.
 */

'use strict';

const { listRegistryFiles, requireSince } = require('./registryDir');

/**
 * @typedef {import('./styleKnobs').StyleKnob & { since?: number }} ExtensionKnob  A knob as a group file declares it.
 * @typedef {{ since?: number, grantedBy?: string, knobs?: Record<string, ExtensionKnob> }} KnobGroupFile  A group file's export.
 */

/** The value kinds canonicalize/style.js and validate/nodes.js already know how to clean. */
const EXTENSION_KNOB_TYPES = Object.freeze(['enum', 'int', 'colorOrRole']);

/**
 * @param {string} name
 * @param {ExtensionKnob | null | undefined} knob
 * @param {Record<string, unknown>} taken
 * @param {string} where
 */
function checkKnob(name, knob, taken, where) {
    if (Object.prototype.hasOwnProperty.call(taken, name)) throw new Error(`${where}: style knob "${name}" already exists`);
    if (!knob || typeof knob !== 'object') throw new Error(`${where}: knob "${name}" must be an object`);
    requireSince(knob.since, `${where} (knob ${name})`);
    if (!EXTENSION_KNOB_TYPES.includes(knob.type)) throw new Error(`${where}: knob "${name}" has type ${JSON.stringify(knob.type)}; use one of ${EXTENSION_KNOB_TYPES.join(', ')}`);
    if (knob.type === 'enum' && (!Array.isArray(knob.values) || knob.values[0] !== knob.default)) {
        throw new Error(`${where}: enum knob "${name}" lists its values with the default (the identity) first`);
    }
}

/**
 * The extension knob groups in `dir`, in file-name order.
 * @param {string} dir
 * @param {{ styleKnobs: Record<string, unknown>, baseGroupNames: readonly string[] }} ctx
 * @returns {Array<{ name: string, since: number, grantedBy: string, knobs: string[], specs: Record<string, ExtensionKnob> }>}
 */
function loadKnobGroupExtensions(dir, ctx) {
    /** @type {Record<string, unknown>} */
    const taken = { ...ctx.styleKnobs };
    const out = [];
    for (const { name, file } of listRegistryFiles(dir)) {
        /** @type {KnobGroupFile | null | undefined} */
        const group = require(file);
        if (!group || typeof group !== 'object') throw new Error(`${file}: exports the group object`);
        if (ctx.baseGroupNames.includes(name)) throw new Error(`${file}: "${name}" is a base knob group`);
        const since = requireSince(group.since, file);
        const grantedBy = group.grantedBy;
        if (grantedBy !== '*' && !(typeof grantedBy === 'string' && Object.prototype.hasOwnProperty.call(ctx.styleKnobs, grantedBy))) {
            throw new Error(`${file}: grantedBy names a base style knob, or '*'`);
        }
        const specs = group.knobs;
        if (!specs || typeof specs !== 'object' || !Object.keys(specs).length) throw new Error(`${file}: knobs holds at least one knob`);
        for (const [knob, spec] of Object.entries(specs)) {
            checkKnob(knob, spec, taken, file);
            taken[knob] = spec;
        }
        out.push({ name, since, grantedBy, knobs: Object.keys(specs), specs });
    }
    return out;
}

module.exports = { loadKnobGroupExtensions, EXTENSION_KNOB_TYPES };
