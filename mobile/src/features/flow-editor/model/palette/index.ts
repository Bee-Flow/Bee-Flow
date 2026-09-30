/**
 * The step picker's data: items, groups, gating and search — the port of the
 * web builder's flow/stepPalette.js (see each file). Pure; no icons are
 * rendered here, only their Lucide names.
 */

export { APP_CATEGORIES, INTEGRATION_CATEGORY_ORDER, OTHER_CATEGORY, appPlacement, resolveIntegrationFromTool } from './appCatalog';
export { actionLabelMap, shortAppLabel, uiDescription } from './appLabels';
export { CODE_OFF_REASONS, NEEDS_FORM_TRIGGER_REASON, NOT_INSIDE_A_LAYER, codeItemFor, gated, localised } from './gating';
export {
    CATEGORY_ORDER, blockItem, buildStepGroups, groupAppsByCategory, groupBlocksByCategory, inlineLayerItem,
    orderedAppCategories, pickItem, prettifyToolName,
} from './groups';
export {
    AI_ITEMS, AI_STEP, ALL_STATIC_ITEMS, CAN_BE_SECONDARY, CODE_ITEM, COLLECTION_ITEMS, CREATE_LAYER_ITEM, DATA_EXTRACTION,
    DATA_ITEMS, EDIT_DATA_ITEM, FLOW_CONTROL_ITEMS, INTEGRATION_ITEMS, LAYER_OUTPUT_ITEM, LOGIC_ITEMS, NOTE_ITEM,
    PALETTE_ICON_NAMES, PEOPLE_ITEMS, PRIVACY_SHIELD_ITEM, ROUTE_ITEM, SECONDARY_TRIGGERS, TRIGGERS, additionalTriggerItems,
} from './items';
export { buildSearchResults, itemForKey } from './search';
export { STEP_ICON_NAMES, isStepIcon } from './stepIcons';
export type {
    PaletteAction, PaletteApp, PaletteBlock, PaletteCatalog, PaletteGroup, PaletteItem, PaletteLayer, PaletteResult,
    PaletteScope, PaletteSection,
} from './types';
