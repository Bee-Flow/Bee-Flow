/**
 * BORROWED CONNECTIONS: the provider an app draws its credentials from, what
 * the agent owner has actually lent, and which apps that makes runnable "as
 * the owner".
 *
 * The provider→app translation lives here and nowhere else: `normaliseToolsConfig`
 * decides whether a stored `actAs: 'owner'` survives with it, and the picker
 * (routes/agents/toolLending.js) reads `lentAppsFor` rather than making the
 * same translation a second time — a second one is a second opinion, and then
 * the screen offers a choice the runtime refuses.
 */

'use strict';

const { actionsOfApp, _index } = require('./appIndex');
const log = require('../../../telemetry/log');

/** The connection provider an app id draws credentials from (for lend grants). */
function _providerForApp(appId) {
    const names = actionsOfApp(appId);
    if (!names.length) return appId;
    try {
        const { providerForTool } = require('../../integrations/connectionResolution');
        for (const n of names) {
            const p = providerForTool(n);
            if (p) return p;
        }
    } catch (err) { log.debug('fall through', err); }
    return appId;
}

/**
 * The providers the agent OWNER has actually lent for this agent, as a Set.
 *
 * Returns null (not an empty Set) when lending is off or the probe fails —
 * `normaliseToolsConfig` treats null as "could not check" and downgrades every
 * `owner`, which is the only safe reading.
 *
 * ── THE SAME GRANTS THAT DISPATCH HONOURS (A2 contradiction) ─────────
 * The filtering was in the SQL (`resourceType: 'agent', resourceId: id`), and that is a strict equality. Dispatch is broader:
 * `resolveConnectionForRun` also honours the grant WITHOUT a resource (`resource_type IS NULL AND resource_id IS NULL`) — the
 * org-wide loan that the API explicitly allows. This function did not read that, so it answered "nothing has been lent" for an
 * agent that DID run on the owner's mailbox: the card silently drew "As: the person asking" and `normaliseToolsConfig` kept
 * rolling back the one choice the owner could still make.
 *
 * Equally strict the other way: `listGrants` filters only on `revoked_at`, not on `expires_at`. An EXPIRED loan read here as a
 * live one — and because `normaliseToolsConfig` is the only thing that ever sets `actAs: 'owner'` back, that dead choice stayed and
 * became real again on its own at the next grant. The expiry is therefore recalculated here, with the same boundary as the SQL of
 * dispatch (`expires_at IS NULL OR expires_at > NOW()`).
 */
async function resolveLentProviders({ agentId, ownerId }) {
    try {
        const { isLendingEnabled } = require('../../integrations/connectionResolution');
        if (!isLendingEnabled()) return null;
        if (!agentId || !ownerId) return null;
        const store = require('../../../stores/integrationConnectionStore');
        // One reading of the owner's own grants; the two forms that dispatch honours
        // are filtered out here. Two loose queries would be two places that can drift apart.
        const grants = await store.listGrants({ grantorUserId: ownerId });
        const now = Date.now();
        const set = new Set();
        for (const g of grants || []) {
            if (!g || !g.provider) continue;
            const forThisAgent = g.resource_type === 'agent' && g.resource_id === agentId;
            const forEverything = (g.resource_type === null || g.resource_type === undefined)
                && (g.resource_id === null || g.resource_id === undefined);
            if (!forThisAgent && !forEverything) continue;
            if (g.revoked_at) continue;          // the store already filters, but this is a grant
            if (g.expires_at) {
                const until = new Date(g.expires_at).getTime();
                // An expiry date nobody can read counts as expired:
                // unknown narrows, here too.
                if (!Number.isFinite(until) || until <= now) continue;
            }
            set.add(g.provider);
        }
        return set;
    } catch (_) {
        return null;               // could not check ⇒ not a yes
    }
}

/**
 * Which APPS can run on a borrowed connection, given the providers
 * the owner has lent out?
 *
 * The translation step belongs HERE, and that is the whole reason this function exists.
 * `normaliseToolsConfig` decides further down with `lent.has(_providerForApp(appId))`
 * whether a stored `actAs: 'owner'` survives; a second place that makes that same
 * translation itself is a second place that could think differently, and then the
 * screen offers a choice the runtime refuses. The picker therefore reads this answer
 * (routes/agents/toolLending.js) instead of attaching providers to apps itself.
 *
 * `null`, not `[]`, as soon as something cannot be said: without a readable provider
 * list, or with a degraded index in which every app falls back to its own id, every
 * outcome is a guess. An empty list would read as "the owner has lent out nothing",
 * and that is an assertion: precisely the difference between "empty" and
 * "unreadable" that the rest of this module keeps everywhere.
 *
 * What is NOT in it: which connection it is. The question the picker asks is
 * "can this app run as the owner", and the answer to that is yes or no.
 * A label or a connection id would tell the editor, who need not be the owner,
 * which integrations that owner has.
 */
function lentAppsFor(lentProviders) {
    if (!(lentProviders instanceof Set)) return null;
    const idx = _index();
    if (!idx.ok) return null;
    const out = [];
    for (const appId of idx.byApp.keys()) {
        // An app whose grants run elsewhere (`grantsVia`) does NOT belong here:
        // `normaliseToolsConfig` refuses `actAs: 'owner'` on exactly that app, so
        // including it let the card offer a toggle that storage reverts one line
        // later, and `ownerRefused` never fired because the card thought it was
        // allowed. The identity question belongs with the app that owns the names;
        // that app is simply in here itself.
        if (idx.defersGrants instanceof Set && idx.defersGrants.has(appId)) continue;
        const provider = _providerForApp(appId);
        if (provider && lentProviders.has(provider)) out.push(appId);
    }
    return out;
}

module.exports = { resolveLentProviders, lentAppsFor, _providerForApp };
