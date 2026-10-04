/**
 * Auto-derived trigger sources.
 *
 * A declaration (see ./README.md) is the precise way to expose an event, but it
 * means someone has to write a file before a newly enabled integration can
 * trigger anything. This module removes that step: any integration the user has
 * enabled that exposes a READ-ONLY tool taking no required arguments is offered
 * as a watchable source — "when the result of this changes".
 *
 * Listing is free. Nothing is polled until someone actually builds and activates
 * an automation on one of these, so offering a candidate costs no API quota.
 *
 * Two properties make this work without user context at poll time:
 *   - the event id encodes the tool (`auto.<tool>.changed`), so a subscription
 *     row is enough to rebuild the source spec on the polling tick;
 *   - the source is `auto`, so the runtime infers the item list, the identity
 *     field and the change fields from the first response instead of needing
 *     an output schema the tool may not have (MCP tools never do).
 *
 * Precedence: a hand-written declaration always wins. Auto-derivation only
 * covers integrations that have none, so improving an integration later is
 * purely additive — write the manifest and the guessed entries disappear.
 */
const { isSideEffect } = require('../sideEffectMap');
const { listTriggerSources } = require('./index');

const AUTO_PREFIX = 'auto.';
const AUTO_SUFFIX = '.changed';

// Deliberately conservative: we know nothing about the API behind an
// auto-derived tool, so poll it rarely and take small bites.
const AUTO_MIN_INTERVAL_MS = 900_000;   // 15 minutes
const AUTO_MAX_ITEMS_PER_TICK = 10;
const AUTO_MAX_TRACKED = 100;

// A tool must look like it returns a COLLECTION — a single record has nothing
// to diff against. Either an explicit listing verb, or a plural object.
const COLLECTION_RE = /(^|_)(list|search|recent|feed|history|browse|all)(_|$)|s$/;
// Read and write verbs, used only for MCP tools (see isWatchable).
const READ_VERB_RE = /(^|_)(list|search|get|fetch|read|find|query|recent|feed|history|browse)(_|$)/;
const WRITE_VERB_RE = /(^|_)(create|update|delete|remove|send|set|add|move|share|revoke|upload|trigger|switch|start|stop|cancel|approve|reply|post|write|append|replace|export|run|execute|toggle|enable|disable|rename|assign|invite|archive|merge)(_|$)/;

function isAutoEventId(eventId) {
    return typeof eventId === 'string' && eventId.startsWith(AUTO_PREFIX) && eventId.endsWith(AUTO_SUFFIX);
}

function toolFromEventId(eventId) {
    if (!isAutoEventId(eventId)) return null;
    return eventId.slice(AUTO_PREFIX.length, -AUTO_SUFFIX.length) || null;
}

const eventIdForTool = (tool) => `${AUTO_PREFIX}${tool}${AUTO_SUFFIX}`;

/**
 * The capability the subscriber must hold for this tool. Derived from the name
 * so the polling tick can re-check it without a user session: MCP tools are
 * `mcp_<server>_<tool>` and gate on `mcp:<server>`; everything else gates on the
 * integration that owns the tool.
 */
function capabilityForTool(tool, integrationId = null) {
    const server = mcpServerFromTool(tool);
    if (server) return `mcp:${server}`;
    return integrationId || null;
}

/**
 * The MCP server a tool belongs to, or null.
 *
 * Only single-token server ids are recognised. getAllToolsAsOpenAI sanitises the
 * whole tool name ([^A-Za-z0-9_] → _), so `my-server` and `my_server` both
 * become `mcp_my_server_…` and the id can no longer be read back out
 * unambiguously. Guessing would mean listing a trigger whose capability check
 * then fails and which therefore never fires — so such servers are simply not
 * auto-derived, and can ship an events manifest instead.
 */
function mcpServerFromTool(tool) {
    const m = /^mcp_([a-z0-9]+)_/.exec(tool || '');
    return m ? m[1] : null;
}

/**
 * A tool is watchable when it reads a collection and needs no arguments.
 *
 * Read-only is decided differently per tool family, because the authoritative
 * map cannot speak for MCP:
 *   - first-party tools → sideEffectMap, which is fail-closed and curated;
 *   - MCP tools → the name, since sideEffectMap lists none of them and would
 *     therefore reject every one. A read verb is required AND any write verb
 *     disqualifies, so `list_devices` passes and `switch_device` does not.
 *
 * The name test is a heuristic, so it is deliberately paired with the
 * no-required-arguments rule: a tool that mutates something usually needs to be
 * told what to mutate.
 */
function isWatchable(toolDef) {
    const fn = toolDef?.function;
    const name = fn?.name;
    if (!name) return false;
    if (!COLLECTION_RE.test(name)) return false;
    if (name.startsWith('mcp_')) {
        if (WRITE_VERB_RE.test(name) || !READ_VERB_RE.test(name)) return false;
    } else if (isSideEffect(name)) {
        return false;
    }
    const required = fn.parameters?.required;
    // A tool we cannot call blind is no use as a generic watcher.
    return !Array.isArray(required) || required.length === 0;
}

function humanizeTool(tool) {
    return tool
        .replace(/^mcp_[a-z0-9-]+_/, '')
        .replace(/_/g, ' ')
        .replace(/^\w/, c => c.toUpperCase());
}

/** The source spec for one auto-derived event. Pure function of the tool name. */
function autoSource(tool, capability) {
    return {
        kind: 'poll_diff',
        auto: true,               // the runtime infers shape from the response
        tool,
        args: {},
        requiresIntegration: capability,
        itemsPath: '__auto',
        idPath: '__auto',
        changePaths: [],
        emitOnAppear: true,       // "something new showed up" is the common want
        firstRun: 'anchor',
        minIntervalMs: AUTO_MIN_INTERVAL_MS,
        cacheTtlMs: 15_000,
        maxItemsPerTick: AUTO_MAX_ITEMS_PER_TICK,
        maxTrackedItems: AUTO_MAX_TRACKED,
        trackValues: true,
        emit: { mode: 'item', map: {}, includeChanges: true },
    };
}

/**
 * The output contract for an auto-derived event.
 *
 * We genuinely do not know the item's shape before the first poll, and saying
 * otherwise would fill the variable picker with fields that resolve to nothing.
 * So the whole item is exposed under `item` and the builder's real-run overlay
 * fills in the detail once the automation has been tested once.
 */
function autoEventDef(tool, capability) {
    return {
        id: eventIdForTool(tool),
        label: `${humanizeTool(tool)} — when the result changes`,
        fields: ['item', 'itemId', 'changedKeys', 'previous', 'current', 'changedAt'],
        sample: {
            item: { id: 'item-1', name: 'Example item' },
            itemId: 'item-1',
            changedKeys: ['name'],
            previous: { name: 'Old name' },
            current: { name: 'Example item' },
            changedAt: '2026-08-02T10:14:03.115Z',
        },
        scope: 'user',
        source: autoSource(tool, capability),
    };
}

/**
 * Rebuild one auto-derived event from its id alone — the polling tick has only
 * a subscription row, no user and no catalog.
 */
function deriveEventDef(eventId) {
    const tool = toolFromEventId(eventId);
    if (!tool) return null;
    let integrationId = null;
    try {
        integrationId = require('../../core/integrations/integrationToolMap').resolveIntegration(tool)?.integration || null;
    } catch { /* name-based capability still works for MCP */ }
    const capability = capabilityForTool(tool, integrationId);
    if (!capability) return null;   // nothing to re-check ⇒ refuse to poll
    return autoEventDef(tool, capability);
}

/**
 * Build provider declarations for the watchable tools in this user's resolved
 * tool set. Integrations that ship a real declaration are skipped entirely.
 *
 *   toolDefs     — OpenAI-shaped tool definitions (getIntegrationTools().tools)
 *   labels       — optional Map<integrationId, label> for nicer names
 *   mcpServerIds — optional Set of the MCP servers this user really has, so a
 *                  tool whose server cannot be identified is skipped rather
 *                  than guessed at
 */
function deriveProviders(toolDefs = [], { labels = new Map(), mcpServerIds = null } = {}) {
    let declaredIds = new Set();
    try {
        declaredIds = new Set(listTriggerSources({ includeHidden: true }).map(s => s.id));
    } catch { /* derive for everything */ }

    let resolveIntegration = null;
    try { ({ resolveIntegration } = require('../../core/integrations/integrationToolMap')); } catch { /* optional */ }

    const knownServers = mcpServerIds instanceof Set ? mcpServerIds : null;

    const byProvider = new Map();
    for (const toolDef of toolDefs) {
        if (!isWatchable(toolDef)) continue;
        const tool = toolDef.function.name;
        const resolved = resolveIntegration ? resolveIntegration(tool) : null;
        const server = mcpServerFromTool(tool);

        // `resolveIntegration` answers 'mcp' for any server it has no specific
        // prefix entry for, which would fold every MCP server into one provider.
        // Prefer the server's own id whenever the resolved one is that generic.
        const resolvedId = resolved?.integration && resolved.integration !== 'mcp'
            ? resolved.integration : null;
        const providerId = (resolvedId || server || '').toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]*$/.test(providerId)) continue;    // unusable as a provider id
        if (declaredIds.has(providerId)) continue;                 // a real declaration wins
        // An id we could not read back unambiguously would produce a trigger
        // that lists but never fires.
        if (tool.startsWith('mcp_') && !server) continue;
        if (server && knownServers && !knownServers.has(server)) continue;

        const capability = capabilityForTool(tool, providerId);
        if (!capability) continue;

        if (!byProvider.has(providerId)) {
            byProvider.set(providerId, {
                id: providerId,
                label: labels.get(providerId) || (resolvedId ? resolved?.label : null) || humanizeTool(providerId),
                order: 900,                                        // after everything declared
                defaultEvent: null,
                availability: { kind: 'derived' },                 // already user-scoped by construction
                derived: true,
                events: [],
            });
        }
        byProvider.get(providerId).events.push(autoEventDef(tool, capability));
    }

    const out = [];
    for (const provider of byProvider.values()) {
        provider.events.sort((a, b) => a.label.localeCompare(b.label));
        provider.defaultEvent = provider.events[0].id;
        out.push(provider);
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
}

module.exports = {
    deriveProviders,
    deriveEventDef,
    isAutoEventId,
    toolFromEventId,
    eventIdForTool,
    capabilityForTool,
    isWatchable,
    AUTO_MIN_INTERVAL_MS,
};
