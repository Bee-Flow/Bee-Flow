// @typecheck
/**
 * Who is asking, in the shape `kbVisibility.filterKbIdsForUser` needs.
 *
 * The retrieval surfaces run OUTSIDE a request — inside a stream, a tool
 * round, a background responder — so `auth.resolveUserOrgIds`, which is
 * request-shaped, is not available. Every one of them needs the same two
 * facts about the same person, and each resolving them its own way is how
 * one of them ends up passing `null` for orgIds, which
 * `canUserAccessKB` reads as super-admin.
 *
 * So: one resolver, always a Set, and a failure that NARROWS.
 */

/** `{ orgIds: Set, userGroups: string[] }` for a user id. Never throws. */
const log = require('../../telemetry/log');
async function askerContext(userId) {
    if (!userId) return { orgIds: new Set(), userGroups: [] };
    let orgIds = new Set();
    let userGroups = [];
    try {
        const { resolveUserGroups } = require('../../auth');
        const g = await resolveUserGroups(userId);
        userGroups = Array.isArray(g) ? g : [];
    } catch (_) {
        userGroups = [];
    }
    try {
        const userStore = require('../../stores/userStore');
        const user = await userStore.getUser(userId);
        const ids = [];
        if (user?.organizationId) ids.push(user.organizationId);
        /**
         * ── ÉÉN ORG-RESOLUTIE, TWEE KANTEN VAN DEZELFDE VRAAG ─────────
         * Hier stond `user.organizationIds` — een veld dat nergens in
         * stores/ bestaat (`getUser` is `SELECT *` op users; de kolommen
         * zijn organizationId en groups), dus die tak leverde altijd
         * niets op. Het LEESPAD dat de gebruiker de notitie of de
         * kennisbank überhaupt laat openen is `auth.resolveUserOrgIds`,
         * en dat voegt juist wél elke org toe die uit de GROEPEN van de
         * gebruiker volgt.
         *
         * Zolang de twee uiteenliepen weigerde deze kant legitieme
         * schrijvers: iemand met `users.organizationId = ''` die org X
         * alleen via een groep bereikt kon een gepubliceerde vergadering
         * van org X gewoon openen, maar kreeg op "file deze regel" een
         * `transcription_not_visible` — een 400 op een vergadering die op
         * dat moment op zijn scherm stond. Versmallend, dus geen lek, maar
         * wel een kapotte functie voor een echte populatie.
         *
         * Bewust GEEN kopie van `resolveUserOrgIds`: die geeft `null` voor
         * een super-admin ("geen filter"), en `null` leest
         * `canUserAccessKB` als volledige toegang. Hier blijft het altijd
         * een Set — een super-admin krijgt op dit pad dus gewoon zijn
         * eigen orgs, en dat is de kant die versmalt.
         */
        let groupIds = userGroups;
        if (!groupIds.length) {
            if (Array.isArray(user?.groups)) groupIds = user.groups;
            else if (typeof user?.groups === 'string') {
                try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { groupIds = []; }
            }
        }
        /**
         * ── DE GROEPS-UITBREIDING HEEFT ZIJN EIGEN VANGNET ────────────
         * Deze lookup is ADDITIEF: hij voegt orgs toe die de gebruiker via
         * een groep bereikt. Faalt hij, dan is de juiste uitkomst "de orgs
         * die ik wél zeker weet", niet "geen enkele org".
         *
         * Zonder deze aparte catch viel de hele resolutie terug op een lege
         * Set zodra `getAllGroups` omviel — inclusief de `organizationId`
         * die al gewoon uit de gebruiker was gelezen. Dat kostte een
         * ingelogde org-genoot zijn eigen organisatiekennisbanken door een
         * databasehapering in een lookup die daar niets mee te maken heeft,
         * en het is precies hoe deze wijziging bij binnenkomst twee tests in
         * de zichtbaarheidslaag rood zette: een stub zonder `getAllGroups`.
         *
         * Versmallen blijft de regel — de buitenste catch hieronder doet dat
         * nog steeds voor een mislukte GEBRUIKERSlezing, waar we werkelijk
         * niets weten. Het verschil is dat een deelfout nu een deel kost.
         */
        if (Array.isArray(groupIds) && groupIds.length) {
            try {
                const allGroups = typeof userStore.getAllGroups === 'function'
                    ? await userStore.getAllGroups()
                    : [];
                for (const gid of groupIds) {
                    const group = (allGroups || []).find((g) => g.id === gid);
                    if (group?.organizationId) ids.push(group.organizationId);
                }
            } catch (e) {
                log.warn('[askerContext] kon de groepen niet uitbreiden naar organisaties:', e.message);
            }
        }
        orgIds = new Set(ids.filter(Boolean));
    } catch (_) {
        // A failed resolve must narrow, never widen: an empty Set drops
        // everything org-scoped, which is the safe direction.
        orgIds = new Set();
    }
    return { orgIds, userGroups };
}

module.exports = { askerContext };
