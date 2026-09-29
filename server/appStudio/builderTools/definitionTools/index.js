/**
 * App Studio builder tools — the DEFINITION side: meta/theme, screens &
 * sections, components (incl. the batch forms), actions, variables and the
 * public-access surface. Every mutating tool applies a pure op from
 * definitionOps.js, then runs the result through adoptCanonical (../shared).
 *
 * This file is the ENTRY POINT of the folder: it wires the modules below and
 * re-exports exactly the surface definitionTools.js had as one file, so
 * `require('./definitionTools')` keeps resolving to the same thing.
 *
 *   metaTheme.js           the app as a whole: meta, theme/design/presets, nav groups
 *   screens.js             screens and the sections inside them
 *   componentPlacement.js  which parent a batch lands under, and the page_header hoist
 *   componentEntries.js    reading raw call entries: debris, wrapper groups, call paths
 *   componentNodes.js      building ONE node from an entry, and the entry-key vocabulary
 *   batchIdentity.js       what "the same batch"/"the same entry" means across resends
 *   addComponents.js       app_add_components: the partial apply and its bookkeeping
 *   patchBatch.js          the ARRAY form shared by update_component/set_action/bind_action
 *   nodeEditing.js         update, move and remove a component that already exists
 *   actions.js             actions and the events they hang off
 *   variables.js           the app-wide variables
 *   publicAccess.js        the screens an anonymous visitor may open
 */

'use strict';

const { applySetMeta, applySetTheme, applySetNavGroups } = require('./metaTheme');
const {
    applyAddScreen, applyUpdateScreen, applyRemoveScreen, applyAddSection, applyUpdateSection,
} = require('./screens');
const { resolveParent } = require('./componentPlacement');
const { COMPONENT_ENTRY_KEYS, buildComponentNode } = require('./componentNodes');
const { applyAddComponents } = require('./addComponents');
const { readBatchArg, runPatchBatch } = require('./patchBatch');
const { applyUpdateComponentTool, applyMoveNode, applyRemoveNode } = require('./nodeEditing');
const { applySetActionTool, applyRemoveAction, applyBindActionTool } = require('./actions');
const { applySetVariables } = require('./variables');
const { applySetPublicAccess } = require('./publicAccess');

module.exports = {
    applySetMeta,
    applySetTheme,
    applySetNavGroups,
    applyAddScreen,
    applyUpdateScreen,
    applyRemoveScreen,
    applyAddSection,
    applyUpdateSection,
    applyAddComponents,
    applyUpdateComponentTool,
    applyMoveNode,
    applyRemoveNode,
    applySetActionTool,
    applyRemoveAction,
    applyBindActionTool,
    applySetVariables,
    applySetPublicAccess,
    // internals re-exported through ../../builderTools.js _test
    resolveParent,
    buildComponentNode,
    readBatchArg,
    runPatchBatch,
    COMPONENT_ENTRY_KEYS,
};
