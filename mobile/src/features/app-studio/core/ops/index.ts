/**
 * The definition ops: pure, immutable operations over an App Studio
 * definition, with structural sharing (an op that changes nothing returns the
 * SAME definition, so callers can `!==`-check for dirtiness).
 *
 * The port of agent-hub/src/components/admin/Studio/AppStudio/state/
 * definitionOps.js, split by concern. Every name that file exports is exported
 * here under the same name; ops.lockstep.test.ts runs both on the same
 * fixtures and fails when the lists or the results drift. The few extra names
 * (walkNodes, visitTree, LOGIC_KEYS, NODE_ACTION_LISTS, DEFAULT_SCREEN_NAME
 * and the NodeLocation extras on findNode) are the phone's additions.
 */

export { ID_PREFIXES, ID_RE, deepClone, newId, subtreeIds, type IdKind } from './ids';
export {
    collectIds,
    findAction,
    findNode,
    findScreen,
    findSection,
    visitTree,
    walkNodes,
    type NodeLocation,
    type WalkEntry,
} from './tree';
export { NODE_ACTION_LISTS, NODE_EVENTS, removeAction, setAction } from './actions';
export {
    LOGIC_KEYS,
    duplicateNode,
    insertNode,
    moveNode,
    reIdSubtree,
    removeNode,
    setNodeComputed,
    setNodeEvent,
    updateNodeLogic,
    updateNodeProps,
    updateNodeStyle,
    type InsertNodeArgs,
} from './nodes';
export {
    getVisibleToRoles,
    isVisibleToRole,
    listDefinitionRoles,
    setDefinitionRoles,
    setVisibleToRoles,
} from './roles';
export { listVariables, removeVariable, renameVariable, setVariable } from './variables';
export { updateAiBrowsing, updateDesign, updateMeta, updateNav, updateTheme } from './theme';
export { DEFAULT_SCREEN_NAME, addScreen, removeScreen, updateScreen } from './screens';
export { addSection, removeSection } from './sections';
export { ensureIds } from './ensureIds';
