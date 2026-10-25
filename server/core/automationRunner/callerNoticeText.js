// @typecheck strict
const { resolveRunPolicy } = require('./runPolicy');

const LABELS = Object.freeze({ google: 'Google', microsoft: 'Microsoft', nextcloud: 'Nextcloud', withings: 'Withings' });

const NOTICE_REQUIRED_CLASS = 'caller_notice_required';

const NOTICE_REQUIRED_MESSAGE = 'Open this automation once and confirm which of your connections it uses, then try again.';

/**
 * Stable keys for the acknowledged set: `app:google`, `dest:knowledge_base`.
 * @param {{ providers: string[], destinations: string[] }} found
 */
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
    const { collectRequirements } = require('./callerRequirements');
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
        providers: found.providers.map((p) => /** @type {Record<string, string>} */ (LABELS)[p] || p),
        destinations: found.destinations,
        items,
    };
}

module.exports = { NOTICE_REQUIRED_CLASS, NOTICE_REQUIRED_MESSAGE, itemsOf, describeCallerNotice };
