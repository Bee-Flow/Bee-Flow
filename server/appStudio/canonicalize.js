/**
 * App Studio — canonicalize a (possibly sloppy) app definition.
 *
 * Philosophy mirrors automation/builderTools.js: tolerate the AI's common
 * mistakes, repair what is unambiguous, and surface every repair as a hint
 * record so the builder loop can teach the model the right shape. Anything
 * that cannot be repaired safely is left in place for validate.js to flag.
 *
 * canonicalizeAppDefinition(def) → { def, repairs: [{ code, path, message }] }
 *
 * NEVER mutates its input — the canonical definition is rebuilt from scratch,
 * and any complex values that are kept are deep-copied first.
 *
 * componentSpecs.js is the single source of truth for every default, range
 * and legal key used here.
 */

'use strict';

// The canonicalizer itself is split by concern under canonicalize/ — shared
// leaf helpers, id allocation, style, bindings, props, nodes, screens, action
// and step field maps, the AI and approval blocks, pass-2 reference rewriting,
// variables and the definition shell. This file stays the single import path.
const { canonicalizeAppDefinition } = require('./canonicalize/definition');

module.exports = { canonicalizeAppDefinition };
