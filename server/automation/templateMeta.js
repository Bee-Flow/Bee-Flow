// @typecheck
'use strict';
/**
 * What the gallery shows about a template without opening it: the integrations
 * it touches and whether its trigger fires today. Split out of templates.js,
 * which is the data.
 */

// Coarse integration id from a tool name (for the gallery "requires" tags).
function coarseIntegrationFromTool(tool) {
    if (!tool) return null;
    if (tool.startsWith('nextcloud')) return 'nextcloud';
    if (tool.startsWith('gmail')) return 'gmail';
    if (tool.startsWith('drive')) return 'google-drive';
    if (tool.startsWith('gcal') || tool.startsWith('calendar')) return 'google-calendar';
    if (tool.startsWith('webpage')) return 'webpages';
    if (tool.startsWith('knowledge_base')) return 'kb-ingest';
    if (tool.startsWith('support_')) return 'support';
    if (tool.startsWith('scaleway_')) return 'scaleway-billing';
    return String(tool).split('_')[0] || null;
}

// Derive which integrations a template touches + whether its trigger fires
// today (poller-backed / schedule) or needs the pending Bee Flow ExApp
// connector (push-pending). Used for honest gallery badges — visual only.
function deriveTemplateMeta(t) {
    const { isPollerBacked, isWebhookBacked, isBotBacked, isPushPending } = require('./deliverableEvents');
    const def = t.definition || {};
    const integrations = new Set();
    const provider = def.trigger?.appEvent?.provider;
    const event = def.trigger?.appEvent?.event;
    if (provider) integrations.add(provider);
    for (const s of (def.steps || [])) {
        if (s.type === 'integration_action' && s.tool) {
            const id = coarseIntegrationFromTool(s.tool);
            if (id) integrations.add(id);
        }
    }
    let triggerReadiness = 'ready';
    if (def.trigger?.kind === 'app_event' && provider === 'nextcloud' && event) {
        // Webhook-backed counts as ready: Nextcloud pushes those to the
        // connector. Without this branch every Forms/Tables/Calendar-mutation
        // template would render as 'unsupported' in the gallery even though it
        // fires — they are neither poller-backed nor producer-less.
        if (isPollerBacked('nextcloud', event) || isWebhookBacked('nextcloud', event) || isBotBacked('nextcloud', event)) {
            triggerReadiness = 'ready';
        } else if (isPushPending('nextcloud', event)) {
            // Nextcloud exposes no producer for this event at all (Share, Deck,
            // Talk). The template installs but can never fire.
            triggerReadiness = 'push-pending';
        } else {
            triggerReadiness = 'unsupported';
        }
    }
    // For the card's quiet "starts with … · n steps" line.
    const triggerKind = typeof def.trigger?.kind === 'string' ? def.trigger.kind : null;
    const stepCount = Array.isArray(def.steps) ? def.steps.length : 0;
    return { requiredIntegrations: [...integrations], triggerReadiness, triggerKind, triggerApp: provider || null, stepCount };
}

module.exports = { deriveTemplateMeta, coarseIntegrationFromTool };
