'use strict';

/**
 * Builder catalog: the apps (and their actions), the reusable steps and the
 * form pick sources of GET /catalog. Extracted from catalog.js; each function
 * reads its arguments and returns what the route puts in the response.
 */

const log = require('../../telemetry/log');
const automationStore = require('../../stores/automationStore');
const { TOOL_REGISTRY, loadTools } = require('../../automation/toolRegistry');
const { isSideEffect, effectOf } = require('../../automation/sideEffectMap');
const { getOutputSchema, producesList, iterableFieldsOf } = require('../../automation/outputSchemas');
const { resolveIntegration } = require('../../core/integrations/integrationToolMap');

/**
 * What a person reads for an action, next to the app's name: `nextcloud_mail_list_mailboxes`
 * under "Nextcloud Mail" is "List mailboxes", `gmail_search` under "Gmail" is "Search". The
 * leading words the app's name already says are dropped (at least one word stays), the rest
 * is sentence case. It used to be the tool id with spaces ("nextcloud mail list mailboxes").
 */
function actionLabel(name, appLabels) {
    const words = String(name).split('_').filter(Boolean);
    const said = new Set(appLabels.filter(Boolean).flatMap(l => String(l).toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean));
    let i = 0;
    while (i < words.length - 1 && said.has(words[i].toLowerCase())) i += 1;
    const rest = words.slice(i).join(' ');
    return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/**
 * The integration tools this user's strict gate exposes, as names and as
 * definitions. Best effort: present everything, mark `available: true` if
 * integrationTools.js would expose it.
 * @returns {Promise<{ userToolNames: Set<string>, userToolDefs: any[] }>}
 */
async function loadUserTools(req, userId) {
    const session = req.session;
    const { getIntegrationTools } = require('../../core/integrations/integrationTools');
    // `available` is computed STRICTLY from getIntegrationTools — the same
    // authoritative gate the runtime uses (org grant ∩ group grant ∩
    // personal toggle ∩ credentials). An app counts as available only when a
    // tool it owns is actually in the user's resolved tool set, so the picker
    // never advertises an integration the user's org/group hasn't enabled.
    // Do NOT broaden this with getUserPermittedApps(): that helper fails OPEN
    // (no explicit org list → AUTO_ENABLED_APPS lets nearly everything
    // through) and would expose the whole server catalog. See memory
    // reference_automations_catalog_strict_gating.
    let userToolNames = new Set();
    // Kept alongside the names so app_event can auto-derive watchable
    // sources for integrations that ship no trigger declaration.
    let userToolDefs = [];
    try {
        const result = await getIntegrationTools({ userId, session, isAdmin: !!req.session?.isAdmin, automationStep: true });
        userToolDefs = result.tools || [];
        for (const t of userToolDefs) {
            if (t?.function?.name) userToolNames.add(t.function.name);
        }
    } catch (err) { log.debug('user might not be fully set up', err); }
    return { userToolNames, userToolDefs };
}

/** Is the webpages beta on for this user? */
async function isWebpagesAvailable(req, userId) {
    // Webpages availability is gated on the beta feature — the same gate
    // getIntegrationTools now uses to actually provision the tools (so the
    // "available" flag here matches what the running agent/automation receives),
    // and the same gate the direct webpage chat uses. Check it directly
    // rather than inferring from userToolNames so the flag is correct even
    // if the tool-name derivation changes.
    let webpagesAvailable = false;
    try {
        const { userHasBetaFeature } = require('../../core/entitlements/betaFeatures');
        webpagesAvailable = await userHasBetaFeature(userId, 'webpages', req.session);
    } catch (err) { log.debug('default false', err); }
    return webpagesAvailable;
}

/** The apps with their actions, and which of them this user can use. */
function buildApps({ userToolNames, webpagesAvailable }) {
    return TOOL_REGISTRY.map(entry => {
        const tools = loadTools(entry);
        const actions = tools.map(t => {
            const name = t?.function?.name;
            if (!name) return null;
            // Resolve the integration that owns this tool so the visual
            // builder can render the brand logo on each action chip /
            // node. Falls back to the app id when no prefix matches.
            const resolved = resolveIntegration(name) || null;
            const os = getOutputSchema(name);
            return {
                name,
                label: actionLabel(name, [resolved?.label, entry.label]),
                description: t.function?.description || '',
                inputSchema: t.function?.parameters || null,
                outputSchema: os,
                // useUpstreamVariables (frontend) reads outputSample to seed
                // the variable picker with realistic field names.
                outputSample: os?.sample || null,
                // Does this action hand back a LIST of records? App Studio
                // connectors badge those (a list is what can fill a table) and
                // `listField` is the key the rows sit under, so a caller can
                // pick the rows path without running the tool first. Both are
                // declaration-derived, so they are false/null for the ~300
                // tools with no OUTPUT_SCHEMAS entry — a live sample settles
                // those (appStudio/connectorSchema.js).
                producesList: producesList(name),
                listField: iterableFieldsOf(name)[0] || null,
                sideEffect: isSideEffect(name),
                // The three-way split the agent tool picker labels and
                // defaults its confirmation on: 'reads' | 'writes' |
                // 'sends'. `sideEffect` stays exactly what it was (the
                // dry-run question) — this is the "does it leave the
                // building" question, and the two genuinely differ:
                // renaming a file and mailing a customer are both side
                // effects, only one of them is unrecallable.
                effect: effectOf(name),
                integrationId: resolved?.integration || entry.app,
                integrationLabel: resolved?.label || entry.label,
            };
        }).filter(Boolean);
        // For webpages, "available" is the beta feature OR the fact that
        // getIntegrationTools actually provisioned the webpage tools for
        // this user (which now also happens when they have access to a
        // webpage even without the beta toggle — see getIntegrationTools).
        // ORing keeps the design-time palette flag in lockstep with what
        // the running automation will actually receive.
        const available = entry.app === 'webpages'
            ? (webpagesAvailable || actions.some(a => userToolNames.has(a.name)))
            : actions.some(a => userToolNames.has(a.name));
        return { id: entry.app, label: entry.label, available, actions };
    });
}

/**
 * The reusable steps this user may add, each flagged with whether every
 * integration it touches is available.
 */
async function buildSteps(req, userId, apps) {
    // Reusable Steps (kind='block') the user may add to this automation.
    // A Step is available only when every integration it touches is
    // available to the user — otherwise the call_block would fail at run
    // time, so we hide it (matching the apps availability gate).
    let steps = [];
    try {
        const { resolveAudienceContext } = require('../../auth/audience');
        const { orgIds, userGroups } = await resolveAudienceContext(req);
        const orgIdList = orgIds === null ? [] : [...orgIds];
        const callable = await automationStore.getCallableStepsForUser(userId, { orgIds: orgIdList, userGroups: userGroups || [] });
        // Build the set of integration ids the user can use right now.
        const availableIntegrationIds = new Set();
        for (const app of apps) {
            if (!app.available) continue;
            availableIntegrationIds.add(app.id);
            for (const a of app.actions) if (a.integrationId) availableIntegrationIds.add(a.integrationId);
        }
        steps = callable.map(s => ({
            id: s.id,
            title: s.title,
            description: s.description,
            icon: s.icon || null,
            category: s.category || null,
            params: s.params,
            outputFields: s.outputFields,
            requiredIntegrations: s.requiredIntegrations,
            available: (s.requiredIntegrations || []).every(i => availableIntegrationIds.has(i)),
        }));
    } catch (e) { log.warn('[automation/catalog] steps load failed:', e.message); }
    return steps;
}

/** The `app_pick` sources, each flagged with whether THIS author could try it. */
function buildFormPickSources(userToolNames) {
    // What an `app_pick` form question may ask for. Served from the
    // registry rather than mirrored in the builder, so the list an author
    // chooses from and the list the submit route accepts cannot drift.
    //
    // `available` is about THIS AUTHOR — whether they could try the picker
    // themselves — and deliberately does NOT gate the choice. The person
    // who fills the form in is usually somebody else, and it is THEIR
    // access that decides what the picker shows; refusing an author the
    // ability to ask their colleagues for a Fireflies transcript because
    // the author has no Fireflies of their own would be the wrong rule.
    const { catalog: pickCatalog, toolsFor, getSource } = require('../../automation/formPickSources');
    const formPickSources = pickCatalog().map(src => ({
        ...src,
        available: src.internal || toolsFor(getSource(src.id)).every(t => userToolNames.has(t)),
    }));
    return formPickSources;
}

module.exports = { actionLabel, loadUserTools, isWebpagesAvailable, buildApps, buildSteps, buildFormPickSources };
