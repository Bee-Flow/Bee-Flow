/**
 * The pieces every /api/studio aggregate shares.
 *
 * counts.js and search.js were written to the same three rules and grew the
 * same two helpers twice: a lazily-memoised dependency object, and the four
 * non-middleware twins of the mount gates. attention.js is the third aggregate
 * asking the same question ("what may this caller see"), and a third copy is
 * how the three quietly start answering it differently — one file learns that
 * a licence check must be awaited before the module check, another does not.
 *
 * So the answer lives here once. Nothing about it is new: every function below
 * is the body it had in counts.js, moved.
 *
 * The gate helpers stay HELPERS rather than middleware on purpose. Middleware
 * refuses the whole request; these three routes must instead OMIT what the
 * caller may not see, because a 403 on the aggregate would tell a Community org
 * there is something behind the door.
 *
 * ── DE GATES GEVEN DRIE ANTWOORDEN, GEEN TWEE ──────────────────────────────
 *
 * `true` = mag, `false` = mag niet, en een `GateUndecidable`-worp = we hebben
 * het niet kunnen vaststellen. Die derde is de reden dat dit blok bestaat.
 * Alle drie de onderliggende controles FALEN DICHT ZONDER TE GOOIEN, en een
 * dichte gate is op deze schermen "niet van jou" — een bekende, permanente
 * afwezigheid die géén gat heet. Zonder onderscheid wordt een storing dus
 * stilletjes tot een gerustgesteld "die soort heb jij niet" gepromoveerd:
 *
 *   license/middleware.js:228   `resolution.error === 'tier_unavailable'` →
 *                               { allowed: false }. requireFeature maakt daar
 *                               zelf een 503 van, juist omdat het geen 403 is.
 *   entitlements.js:648-657     hasCapability geeft false bij een worp én bij
 *                               een `degraded` snapshot ("FAILS CLOSED … rather
 *                               than throwing, because it runs in hot paths").
 *   permissions.js:676-686      getUserPermissions geeft ['page_chat'] bij een
 *                               DB-fout en zet `_lastPermLookupFailedAt`, met
 *                               in het commentaar de opdracht dat een route die
 *                               een hard antwoord wil `isPermissionLookupDegraded()`
 *                               moet raadplegen. Dat gebeurt hier.
 *
 * De aanroepers verwerken de worp elk op hun eigen manier, en alle drie op de
 * kant van "onbekend versmalt": counts.js laat de sleutel weg en markeert het
 * antwoord partial, search.js zet de soort in `errors[]`, attention.js in
 * `unavailable[]` (nooit in `gated[]`).
 */

'use strict';

/**
 * "Deze poort kon niet beantwoord worden." Een eigen type zodat een aanroeper
 * hem kan herkennen; elke aanroeper vandaag behandelt hem hetzelfde als elke
 * andere worp, en dat is precies goed.
 */
class GateUndecidable extends Error {
    constructor(what) {
        super(`gate undecidable: ${what}`);
        this.name = 'GateUndecidable';
        this.gate = what;
    }
}

/**
 * A dependency object whose modules are required on first touch.
 *
 * @param {Record<string, () => any>} loaders  name → require thunk
 */
function makeLazyDeps(loaders) {
    const memo = {};
    const deps = {};
    for (const [name, load] of Object.entries(loaders)) {
        Object.defineProperty(deps, name, {
            enumerable: true,
            get() { if (!(name in memo)) memo[name] = load(); return memo[name]; },
        });
    }
    return deps;
}

const userIdOf = (req) => req.session?.user?.id || null;
const orgIdOf = (req) => req.session?.user?.organizationId || req.session?.user?.orgId || null;

// ── Gate helpers — the non-middleware twins of the mount gates ─────────────

/** Modules: isModuleActive gooit zelf als de statuslezing omvalt. */
const moduleActive = (d, id) => d.modules.isModuleActive(id);

/**
 * Licentie. `tier_unavailable` is de tier-resolutie die NIET kon lezen — geen
 * "deze org heeft het niet".
 */
const licenceAllows = async (d, req, feature) => {
    const { allowed, resolution } = (await d.license.featureAllowedForRequest(req, feature)) || {};
    if (resolution && resolution.error === 'tier_unavailable') {
        throw new GateUndecidable(`licence:${feature}`);
    }
    return !!allowed;
};

/**
 * Capability. `resolveCapabilitySet` is dezelfde resolutie als hasCapability
 * (zijn `has()` doet letterlijk dezelfde alias-uitbreiding), maar hij MELDT
 * `degraded` in plaats van hem als "nee" te verkopen. Een deps-object dat de
 * batch-helper niet meelevert valt terug op hasCapability — dan is er niets
 * verloren behalve het onderscheid dat die helper nu juist draagt.
 */
const capability = async (d, req, capId) => {
    const ctx = { userId: userIdOf(req), orgId: orgIdOf(req), session: req.session, req };
    if (typeof d.entitlements.resolveCapabilitySet === 'function') {
        const set = await d.entitlements.resolveCapabilitySet(ctx);
        if (!set || set.degraded) throw new GateUndecidable(`capability:${capId}`);
        return !!set.has(capId);
    }
    return !!(await d.entitlements.hasCapability(capId, ctx));
};

/**
 * Rechten. `hasPermission` false is dubbelzinnig zolang de rechtenlezing
 * degraded is; permissions.js exporteert de vlag daar zelf voor.
 */
const permission = async (d, req, perm) => {
    const ok = await d.permissions.hasPermission(userIdOf(req), perm, req.session);
    if (ok) return true;
    if (typeof d.permissions.isPermissionLookupDegraded === 'function'
        && d.permissions.isPermissionLookupDegraded()) {
        throw new GateUndecidable(`permission:${perm}`);
    }
    return false;
};

// ── Scoping helpers — WELKE rijen, niet WELKE soort ────────────────────────

/**
 * De kennisbanken die deze beller mag zien.
 *
 * Stond woordelijk in counts.js ('knowledge'), in search.js ('knowledge') én
 * in attentionChecks.js (knowledgeBasesToActOn) — drie keer dezelfde zeven
 * regels. De gate zegt "mag deze soort", dit zegt "welke RIJEN", en die tweede
 * is de duurste helft om te laten uiteenlopen: een vierde
 * zichtbaarheidsvoorwaarde die maar op twee van de drie plekken landt laat het
 * aandachtsscherm kennisbanken noemen die de kennislijst niet toont.
 *
 * `resolveUserOrgIds` staat hier STRIKT: een onleesbare userStore geeft
 * anders een lege Set, en die is niet te onderscheiden van "lid van geen
 * enkele organisatie" (permissions.js:832-866 zegt dat in zijn eigen kop).
 * Hier gooit hij dus, en elke aanroeper heeft al een plek voor een worp.
 */
async function visibleKnowledgeBasesFor(req, d) {
    const userId = userIdOf(req);
    const orgIds = await d.auth.resolveUserOrgIds(req, { strict: true });
    const isOrgAdmin = await d.kbShared.resolveIsOrgAdmin(req);
    const systemSlugs = await d.kbShared.resolveEnabledSystemSlugs(req);
    const filter = d.kbShared.listFilterFromQuery({ query: {} });
    const kbs = await d.kbStore.listKBs(userId, orgIds, { ...filter, systemSlugs, isOrgAdmin });
    const userGroups = await d.kbShared.resolveUserGroups(req);
    return d.kbStore.filterByGroupAccess(kbs, userId, userGroups, { orgIds, isOrgAdmin });
}

module.exports = {
    GateUndecidable,
    makeLazyDeps,
    userIdOf,
    orgIdOf,
    moduleActive,
    licenceAllows,
    capability,
    permission,
    visibleKnowledgeBasesFor,
};
