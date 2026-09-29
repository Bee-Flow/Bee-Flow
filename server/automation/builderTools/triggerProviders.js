/**
 * Availability + ordering + catalog projection for app_event trigger providers.
 *
 * The providers themselves are no longer a list in this file: each integration
 * declares the events it emits, and automation/triggerSources discovers those
 * declarations (first-party manifests, bundled MCP servers, and anything
 * registered at runtime). Adding an integration therefore adds a trigger with
 * no core file edited.
 *
 * This module still owns the two things that are the platform's job rather than
 * the integration's: deciding whether THIS user may see a provider, and
 * projecting the declarations into the exact catalog shape the builder expects.
 *
 * `hidden` entries are never listed but stay resolvable, so an automation saved
 * against a withdrawn provider still renders a label (github: cross-tenant
 * fan-out gap — its webhook has no installation→org mapping — so it stays
 * hidden until that lands).
 */
const {
    listTriggerSources, listTriggerSourcesForOrg, getTriggerSource, canProduce,
} = require('../triggerSources');

/**
 * ctx = {
 *   availableAppIds: Set<string>,           // apps whose tools survived the tool gate
 *   availableMcpServerIds: Set<string>,     // MCP servers granted AND credentialled
 *   checks: { support: bool },
 *   publicBaseUrl: bool,
 *   orgId: string|null,                     // to include this org's own declarations
 * }
 * Fail-closed throughout: an unknown availability kind, a missing check or an
 * absent set all mean "not available".
 */
function providerIsAvailable(availability, ctx) {
    if (!availability) return false;
    if (availability.requiresPublicBaseUrl && !ctx.publicBaseUrl) return false;
    if (availability.kind === 'tools') {
        if (Array.isArray(availability.apps) && availability.apps.some(a => ctx.availableAppIds.has(a))) return true;
        if (availability.appPrefix) {
            for (const id of ctx.availableAppIds) {
                if (typeof id === 'string' && id.startsWith(availability.appPrefix)) return true;
            }
        }
        return false;
    }
    if (availability.kind === 'check') {
        return ctx.checks[availability.check] === true;
    }
    if (availability.kind === 'derived') {
        // Auto-derived providers are built from this user's own resolved tool
        // set, so reaching this point already means they are available.
        return true;
    }
    if (availability.kind === 'mcp') {
        // MCP servers have no TOOL_REGISTRY row, so they never appear in
        // availableAppIds. The set below is resolved from the same fail-closed
        // authority (the user's own tool set) plus a per-user credential check.
        return !!availability.serverId && ctx.availableMcpServerIds.has(availability.serverId);
    }
    return false;
}

const toSet = (v) => (v instanceof Set ? v : new Set(Array.isArray(v) ? v : []));

/**
 * The LISTABLE providers, catalog-ready:
 * [{ id, label, defaultEvent, events: [{ id, label, deliverability, deliverabilityNote? }] }]
 */
function buildAppEventProviders(ctx = {}) {
    const resolved = {
        availableAppIds: toSet(ctx.availableAppIds),
        availableMcpServerIds: toSet(ctx.availableMcpServerIds),
        checks: (ctx.checks && typeof ctx.checks === 'object') ? ctx.checks : {},
        publicBaseUrl: !!ctx.publicBaseUrl,
    };
    const out = [];
    // Declared sources first, then anything auto-derived from the user's tools.
    // deriveProviders already drops integrations that ship a real declaration,
    // so the two can never offer the same provider twice.
    const sources = [...listTriggerSourcesForOrg(ctx.orgId || null), ...(ctx.derivedProviders || [])];
    for (const def of sources) {
        if (def.hidden) continue;
        if (!providerIsAvailable(def.availability, resolved)) continue;
        // Honesty gate: never offer an event that nothing on this install can
        // produce. Checked here rather than at registration so module load
        // order can't decide whether an event is listed.
        const events = (def.events || []).filter(ev => !ev.hidden && canProduce(ev.source));
        if (events.length === 0) continue;
        out.push({
            id: def.id,
            label: def.label,
            defaultEvent: events.some(e => e.id === def.defaultEvent) ? def.defaultEvent : events[0].id,
            events: events.map(ev => ({
                id: ev.id,
                label: ev.label,
                deliverability: ev.deliverability || 'ok',
                ...(ev.deliverabilityNote ? { deliverabilityNote: ev.deliverabilityNote } : {}),
            })),
        });
    }
    return out;
}

/** Full registry lookup — INCLUDES hidden entries, for label resolution. */
function getProviderDef(id) {
    return getTriggerSource(id);
}

module.exports = { buildAppEventProviders, getProviderDef, providerIsAvailable };

// Back-compat: the ordered global declarations. A getter, not a snapshot, so
// sources registered after this module was first required are still visible.
Object.defineProperty(module.exports, 'TRIGGER_PROVIDERS', {
    get: () => listTriggerSources({ includeHidden: true }),
    enumerable: true,
});
