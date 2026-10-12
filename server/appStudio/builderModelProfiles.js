/**
 * App Studio builder — model capability profiles.
 *
 * The classification bands, capability ranking and per-profile knobs are
 * model-generic and already centralised in automation/builderModelProfiles.js —
 * RE-EXPORTED here (never duplicated) so both builders stay in lockstep. The
 * app-specific pieces are the reduced tool menu for small models, the
 * profile→menu selection, and the "auto" tier policy (most capable configured
 * model wins — see selectAutoBuilderTier).
 */

'use strict';

const {
    classifyModel,
    parseClaudeModel,
    rankModelCapability,
    getProfile,
    getProfileForModel,
    effortForIteration,
} = require('../automation/builderModelProfiles');

// The 'core' toolset for small (Haiku/mini/Ministral/Gemma-class) models: an
// 18-tool menu instead of 38, so tool selection stays reliable. Everything a
// small model needs to assemble a working app end to end; the read/inspect
// tools are dropped (the owner's automations list and the live draft state are
// already in the prompt) along with the rarer structural edits
// (update_screen / remove_screen / add_section / remove_action) and the
// vision loop (app_screenshot — a small model can't see the image anyway).
//
// The five data-side entries: app_link_datatable puts a table that already
// exists (a Nextcloud mirror an automation fills) into the app; app_upsert_table
// and app_seed_records create and fill the app's OWN tables — measured
// 2026-09-13: without them a model asked for "an app with tables" invented
// tbl_ ids and every action against them was refused for a whole turn;
// app_query_data lets the model peek at five real rows before it binds;
// app_set_plan is the checklist the canvas shows. A linked table is safe from
// the two creators: dataTools.mergeTableOp refuses its fields and a `source`
// on create, and seeding it is refused outright (linkedTableRefusal).
//
// app_inspect_catalog (2026-09-17): the core prompt carries the COMPACT
// catalog — every component type on one line — so a read tool serves the full
// entry of a type or step kind on demand. It is the one read tool on the menu.
const APP_CORE_TOOL_NAMES = new Set([
    'app_search_documents', 'app_read_document',
    'app_inspect_catalog',
    'app_set_meta',
    'app_set_theme',
    'app_add_screen',
    'app_add_components',
    'app_update_component',
    'app_move_node',
    'app_remove_node',
    'app_set_action',
    'app_bind_action',
    'app_link_datatable',
    'app_upsert_table',
    'app_seed_records',
    'app_query_data',
    'app_set_plan',
    'app_finalize',
]);

/**
 * The tool menu for a capability profile. Small models ('core' toolset) get
 * the reduced APP_CORE_TOOL_NAMES subset in its CORE PROJECTION (pruned
 * schemas — builderTools/schemasCore.js); EVERY capable model — mid,
 * reasoning, frontier, i.e. Claude-4.5-class and up — gets the FULL schema
 * list, app_screenshot included. Pure: filters the list it is given, so the
 * route stays the single owner of TOOL_SCHEMAS. The projection is cached per
 * filtered list, and the filter is cached per input, so two turns of one
 * session see the identical object graph (prompt-cache discipline).
 */
const _coreMenus = new WeakMap();
function selectToolMenu(profile, toolSchemas) {
    const list = Array.isArray(toolSchemas) ? toolSchemas : [];
    if (profile && profile.toolset === 'core') {
        const hit = _coreMenus.get(list);
        if (hit) return hit;
        const { projectCoreToolSchemas } = require('./builderTools/schemasCore');
        const menu = projectCoreToolSchemas(list.filter((t) => APP_CORE_TOOL_NAMES.has(t?.function?.name)));
        _coreMenus.set(list, menu);
        return menu;
    }
    return list;
}

// Deterministic tie-break when two configured tiers score identically
// (e.g. the same model configured twice): prefer the tier that admins
// conventionally point at the stronger model. Unknown keys sort after the
// known ones, alphabetically.
const AUTO_TIER_TIEBREAK = ['deep_thinking', 'smart', 'pro', 'thinking', 'standard', 'writer', 'fast'];

/**
 * "auto" model policy for the APP builder: pick the MOST CAPABLE configured
 * model, with the newest Claude generation ranked on top when several are
 * configured (rankModelCapability). Building an app is always a hard,
 * tool-heavy, multi-step task, so prompt-based tier classification (which
 * routes short messages to a fast/small tier) is the wrong instrument here.
 *
 * Ranks ONLY what the org configured — never invents a model. Skips
 * 'custom:*' (separate routing semantics) and 'swarm' (multi-agent runtime),
 * matching the tier filter the chat classifier applies.
 *
 * @param {Object} tiers - tier map from getEUAwareTiers ({ [tier]: { modelId } })
 * @returns {{ tier: string, modelId: string } | null} null when nothing is configured
 */
function selectAutoBuilderTier(tiers) {
    const candidates = [];
    for (const [tier, cfg] of Object.entries(tiers || {})) {
        if (typeof tier !== 'string' || tier.startsWith('custom:') || tier === 'swarm') continue;
        const modelId = cfg && typeof cfg.modelId === 'string' ? cfg.modelId : null;
        if (!modelId) continue;
        candidates.push({ tier, modelId, score: rankModelCapability(modelId) });
    }
    if (!candidates.length) return null;
    const pref = (t) => {
        const i = AUTO_TIER_TIEBREAK.indexOf(t);
        return i === -1 ? AUTO_TIER_TIEBREAK.length : i;
    };
    candidates.sort((a, b) => (b.score - a.score)
        || (pref(a.tier) - pref(b.tier))
        || (a.tier < b.tier ? -1 : a.tier > b.tier ? 1 : 0));
    return { tier: candidates[0].tier, modelId: candidates[0].modelId };
}

module.exports = {
    classifyModel,
    parseClaudeModel,
    rankModelCapability,
    getProfile,
    getProfileForModel,
    effortForIteration,
    APP_CORE_TOOL_NAMES,
    selectToolMenu,
    selectAutoBuilderTier,
    AUTO_TIER_TIEBREAK,
};
