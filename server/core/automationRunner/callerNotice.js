// @typecheck
/**
 * The one-time notice before somebody's first run of an automation that uses
 * THEIR OWN connections (runPolicy.connections = 'caller'): which apps it will
 * act in, and which places the OWNER controls it writes to (the owner's
 * knowledge base, tables, document library copies, generated files).
 *
 * What was acknowledged is the SET of those items, not a flag: the notice shows
 * again when the automation later grows an app or a destination. The same walk
 * as the run's pre-check (callerConnections.collectRequirements, with the same
 * lookups) decides the items, and the run itself enforces the notice for every
 * start that names a person (callerConnections.applyCallerOnly), so a start that
 * has no dialog (an agent call, a skill) fails with a clear sentence instead.
 */

'use strict';

const { resolveRunPolicy } = require('./runPolicy');

const LABELS = Object.freeze({ google: 'Google', microsoft: 'Microsoft', nextcloud: 'Nextcloud', withings: 'Withings' });
const NOTICE_REQUIRED_CLASS = 'caller_notice_required';
const NOTICE_REQUIRED_MESSAGE = 'Open this automation once and confirm which of your connections it uses, then try again.';

/** Stable keys for the acknowledged set: `app:google`, `dest:knowledge_base`. */
const itemsOf = ({ providers, destinations }) => [...providers.map((p) => `app:${p}`), ...destinations.map((d) => `dest:${d}`)].sort();

/**
 * @param {{ automation: { id: string, userId?: string, organizationId?: string|null, definition?: object }, userId: string,
 *           store: { getCallerNoticeAck: (u: string, a: string) => Promise<string[]|null>, getAutomation?: any, getVersionDefinition?: any },
 *           providerForTool?: (tool: string) => string|null,
 *           loadBlockDefinition?: (id: string) => Promise<object|null>,
 *           stepProviders?: (aiStep: object) => Promise<string[]> }} args
 * @returns {Promise<{ applies: boolean, seen: boolean, providers: string[], destinations: string[], items: string[] }>}
 */
async function describeCallerNotice({ automation, userId, store, providerForTool, loadBlockDefinition, stepProviders }) {
    const policy = resolveRunPolicy(automation.definition);
    if (policy.connections !== 'caller' || !userId || userId === automation.userId) {
        return { applies: false, seen: false, providers: [], destinations: [], items: [] };
    }
    const { collectRequirements } = require('./callerConnections');
    const lookups = require('./callerLookups');
    const found = await collectRequirements(automation.definition, {
        providerForTool: providerForTool || require('../integrations/connectionResolution').providerForTool,
        loadBlockDefinition: loadBlockDefinition || (store.getAutomation ? lookups.blockDefinitionLoader(/** @type {any} */ (store)) : undefined),
        stepProviders: stepProviders || ((step) => lookups.stepProvidersLoader()(step, { orgId: automation.organizationId || null, userId: automation.userId })),
    });
    const items = itemsOf(found);
    const ack = await store.getCallerNoticeAck(userId, automation.id);
    const acknowledged = new Set(ack || []);
    return {
        applies: true,
        seen: ack !== null && items.every((i) => acknowledged.has(i)),
        providers: found.providers.map((p) => LABELS[p] || p),
        destinations: found.destinations,
        items,
    };
}

/**
 * The notice a viewer is shown for a stored automation row. Someone who can edit
 * also runs the WORKING copy (a Test), so for them the items are the union of
 * the live and the working copy: one confirmation covers both and a test run
 * can never loop on a notice that only its own copy has.
 */
async function describeNoticeFor({ automation, userId, store, canEdit = false }) {
    const { automationForRun } = require('./definitionForRun');
    const live = await describeCallerNotice({ automation: automationForRun(automation, { mode: 'live' }), userId, store });
    if (!canEdit || !live.applies) return live;
    const work = await describeCallerNotice({ automation: automationForRun(automation, { mode: 'live', triggerKind: 'manual', isTest: true }), userId, store });
    if (!work.applies) return live;
    const union = (a, b) => [...new Set([...a, ...b])];
    const items = union(live.items, work.items).sort();
    const ack = await store.getCallerNoticeAck(userId, automation.id);
    const seen = ack !== null && items.every((i) => ack.includes(i));
    return { applies: true, seen, providers: union(live.providers, work.providers), destinations: union(live.destinations, work.destinations).sort(), items };
}

module.exports = { describeNoticeFor, describeCallerNotice, itemsOf, NOTICE_REQUIRED_CLASS, NOTICE_REQUIRED_MESSAGE };
