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
    } catch (_) { /* fall through */ }
    return appId;
}

/**
 * The providers the agent OWNER has actually lent for this agent, as a Set.
 *
 * Returns null (not an empty Set) when lending is off or the probe fails —
 * `normaliseToolsConfig` treats null as "could not check" and downgrades every
 * `owner`, which is the only safe reading.
 *
 * ── DEZELFDE GRANTS DIE DISPATCH HONOREERT (A2-tegenspraak) ─────────
 * De filtering stond in de SQL (`resourceType: 'agent', resourceId: id`), en
 * dat is een strikte gelijkheid. Dispatch is ruimer: `resolveConnectionForRun`
 * honoreert óók de grant ZONDER resource (`resource_type IS NULL AND
 * resource_id IS NULL`) — de org-brede lening die de API expliciet toestaat.
 * Deze functie las die niet, dus zij antwoordde "er is niets uitgeleend" op een
 * agent die wél op de postbus van de eigenaar draaide: de kaart tekende
 * stilzwijgend "As: the person asking" en `normaliseToolsConfig` draaide de
 * enige keuze die de eigenaar nog kon maken telkens terug.
 *
 * Andersom net zo streng: `listGrants` filtert alleen op `revoked_at`, niet op
 * `expires_at`. Een VERLOPEN lening las hier als een levende — en omdat
 * `normaliseToolsConfig` het enige is dat `actAs: 'owner'` ooit terugzet, bleef
 * die dode keuze staan en werd hij vanzelf weer echt bij de volgende grant. De
 * vervaldatum wordt daarom hier nagerekend, met dezelfde grens als de SQL van
 * dispatch (`expires_at IS NULL OR expires_at > NOW()`).
 */
async function resolveLentProviders({ agentId, ownerId }) {
    try {
        const { isLendingEnabled } = require('../../integrations/connectionResolution');
        if (!isLendingEnabled()) return null;
        if (!agentId || !ownerId) return null;
        const store = require('../../../stores/integrationConnectionStore');
        // Eén lezing over de eigen grants van de eigenaar; de twee vormen die
        // dispatch honoreert worden er hier uit gefilterd. Twee losse queries
        // zouden twee plekken zijn die uit elkaar kunnen lopen.
        const grants = await store.listGrants({ grantorUserId: ownerId });
        const now = Date.now();
        const set = new Set();
        for (const g of grants || []) {
            if (!g || !g.provider) continue;
            const forThisAgent = g.resource_type === 'agent' && g.resource_id === agentId;
            const forEverything = (g.resource_type === null || g.resource_type === undefined)
                && (g.resource_id === null || g.resource_id === undefined);
            if (!forThisAgent && !forEverything) continue;
            if (g.revoked_at) continue;          // de store filtert al, maar dit is een grant
            if (g.expires_at) {
                const until = new Date(g.expires_at).getTime();
                // Een vervaldatum die niemand kan lezen telt als verlopen:
                // onbekend versmalt, ook hier.
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
 * Welke APPS kunnen op een geleende verbinding draaien, gegeven de providers
 * die de eigenaar heeft uitgeleend?
 *
 * De vertaalslag hoort HIER, en dat is de hele reden dat deze functie bestaat.
 * `normaliseToolsConfig` beslist verderop met `lent.has(_providerForApp(appId))`
 * of een opgeslagen `actAs: 'owner'` overleeft; een tweede plek die diezelfde
 * vertaling zelf maakt is een tweede plek die er anders over kan denken — en
 * dan biedt het scherm een keuze aan die de runtime weigert. De kiezer leest
 * daarom dit antwoord (routes/agents/toolLending.js) in plaats van zelf
 * providers aan apps te knopen.
 *
 * `null`, niet `[]`, zodra er iets niet te zeggen valt: zonder leesbare
 * providerlijst, of met een degraded index waarin elke app op haar eigen id
 * terugvalt, is elke uitkomst een gok. Een lege lijst zou lezen als "de
 * eigenaar heeft niets uitgeleend", en dat is een bewering — precies het
 * verschil tussen "leeg" en "onleesbaar" dat de rest van deze module
 * overal aanhoudt.
 *
 * Wat er NIET in zit: welke verbinding het is. De vraag die de kiezer stelt is
 * "kan deze app als de eigenaar draaien", en het antwoord daarop is ja of nee.
 * Een label of een connection-id zou de bewerker — die de eigenaar niet hoeft
 * te zijn — vertellen welke integraties die eigenaar heeft.
 */
function lentAppsFor(lentProviders) {
    if (!(lentProviders instanceof Set)) return null;
    const idx = _index();
    if (!idx.ok) return null;
    const out = [];
    for (const appId of idx.byApp.keys()) {
        // Een app die zijn grants elders laat lopen (`grantsVia`) hoort hier
        // NIET in: `normaliseToolsConfig` weigert `actAs: 'owner'` op precies
        // die app, dus hem meesturen liet de kaart een schakelaar aanbieden die
        // de opslag een regel later terugdraait — en `ownerRefused` vuurde niet
        // eens, want de kaart dacht dat het mocht. De identiteitsvraag hoort bij
        // de app die de namen bezit; die staat hier gewoon zelf in.
        if (idx.defersGrants instanceof Set && idx.defersGrants.has(appId)) continue;
        const provider = _providerForApp(appId);
        if (provider && lentProviders.has(provider)) out.push(appId);
    }
    return out;
}

module.exports = { resolveLentProviders, lentAppsFor, _providerForApp };
