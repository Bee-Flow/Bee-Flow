/**
 * De voet van een agentkaart in het overzicht (A5, deel D): één regel, en
 * welke regel dat wordt.
 *
 * Drie vormen, en de keuze ertussen is de hele functie:
 *
 *   ⚠ Antwoordt uit het hoofd — koppel een kennisbank
 *   312 gesprekken · ook in 2 automations, 1 app
 *   Alleen jij · 4 testgesprekken
 *
 * ── DE WAARSCHUWING IS NIET VAN DIT BESTAND ────────────────────────────────
 *
 * "Antwoordt uit het hoofd" is een REGEL, en die staat op de server:
 * core/agentRuntime/agentGrounding.js `groundedOn` + `groundingVerdict`, waar
 * Studio's "Vraagt aandacht" (routes/studio/attentionChecks.js, bron
 * `agentNoKb`) hem ook uit leest. GET /agents/all hangt het antwoord als
 * `grounding.verdict` aan elke rij, en dit bestand LEEST dat woord — het leidt
 * niets af uit `config.knowledge_base_ids`.
 *
 * Waarom dat de moeite waard is: twee implementaties van dezelfde zin lopen
 * uit elkaar, en het eerste scherm waar dat opvalt is precies het scherm waar
 * iemand ze naast elkaar ziet — Start zegt "vraagt aandacht" over een agent
 * waar het overzicht niets over zegt. Hetzelfde argument dat
 * admin/Studio/attention/attentionChecks.js in zijn kop maakt over de andere
 * vijf bronnen.
 *
 * ── WAAR DE TELLINGEN OVER GAAN, EN WAAR NIET ──────────────────────────────
 *
 * `stats` komt uit stores/agent/agentStats.js `getAgentChatStats`: één
 * GROUP BY over `agent_conversations` op `agent_id`, ZONDER filter op
 * gebruiker. `conversationCount` is dus "gesprekken MET DEZE AGENT, door
 * iedereen" en `userCount` is `COUNT(DISTINCT user_id)`. Twee gevolgen:
 *
 *   1. De zin mag nooit "jouw gesprekken" zeggen — dat zou een getal van
 *      collega's onder jouw naam zetten.
 *   2. "Alleen jij" is een BEWERING over bereik en heeft BEWIJS nodig, en
 *      `userCount` is dat bewijs niet: dat is `COUNT(DISTINCT user_id)` over
 *      álle gesprekken, dus één telt net zo goed als een collega die er
 *      veertig voerde terwijl jij er nul voerde. Precies dat gebeurt: je
 *      publiceert een agent, een collega gebruikt hem, je zet hem terug op
 *      concept (`setAgentPublished` doet één UPDATE — de rijen in
 *      `agent_conversations` blijven staan), en de kaart zou "Alleen jij · 40
 *      gesprekken" zeggen over gesprekken die niet van jou zijn.
 *      Het bewijs dat het wél draagt is `othersConversationCount`
 *      (`COUNT(*) FILTER (WHERE user_id <> jij)`), en dat rijdt sinds A5 mee op
 *      de lijst — geen extra query, dezelfde GROUP BY met één parameter erbij.
 *      `null` daar betekent "de server kon niet zien wie er kijkt", en dan
 *      verschijnt de vorm niet.
 *
 * ── EEN TELLING DIE NIET GELEZEN KON WORDEN IS GEEN 0 ──────────────────────
 *
 * `stats: null` is het antwoord van de server op een mislukte lezing, en een
 * rij zonder het veld is hetzelfde. Allebei worden ze `null` — nooit 0. "312
 * gesprekken" en "het aantal kon niet gelezen worden" zijn verschillende
 * zinnen, en de tweede mag niet als de eerste met een nul lezen. Zelfde regel
 * als `countOrNothing` in builderSplit/AgentEditorHeader.jsx en als
 * `summariseDeleteBlock` hiernaast.
 *
 * Voor "gebruikt door" geldt dezelfde regel twee keer:
 *   - zonder `?usage=1` is het veld AFWEZIG, en dan zegt de voet er niets
 *     over (afwezig ≠ "door niets gebruikt");
 *   - `usage.partial` noemt de soorten die niemand kon controleren, en die
 *     tellen niet als nul — ze krijgen hun eigen halve zin.
 *
 * Zuiver en zonder rendering, zoals ./deleteBlock.js: de woorden staan in
 * AgentCardFooter.jsx, waar de i18n-guard de sleutels kan lezen.
 */

// Dezelfde zes soorten in dezelfde volgorde als de verwijderdialoog, uit
// dezelfde spiegel van stores/agent/agentUsage.js KINDS. Eén lijst voor beide
// schermen; een zevende soort die de server later toevoegt komt via `counts`
// binnen en wordt onder zijn eigen naam gemeld in plaats van weggelaten.
import { USAGE_KINDS } from './deleteBlock';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Een eindig, niet-negatief geheel getal, of `null`. Nooit een 0 uit niets.
 *
 * De zeef vooraf is het hele punt: `Number(null)`, `Number('')` en
 * `Number(false)` zijn alle drie `0` — eindig en ≥ 0 — dus zonder die zeef
 * leest een per-veld-null (een LEFT JOIN die wegvalt, een COALESCE die
 * verdwijnt) als de BEWERING "0 gesprekken" in plaats van "kon niet gelezen
 * worden". Dezelfde zeef die `documentCountOf` in
 * server/routes/studio/attentionChecks.js voor zet.
 */
function countOrNull(value) {
    // Alleen een getal, of een string die er een is. Alles wat `Number()`
    // buiten die twee soorten stilzwijgend 0 noemt (`null`, `''`, `false`,
    // `[]`) is hier ONBEKEND.
    const numeric = typeof value === 'number'
        || (typeof value === 'string' && value.trim() !== '');
    if (!numeric) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * Het oordeel van de server over waar deze agent op gegrond is.
 *
 * ALLEEN het woord dat de server stuurde telt. `grounding` afwezig (een
 * oudere client, een lijst die het veld niet draagt), geen object, of een
 * `verdict` die dit bestand niet kent ⇒ `null` = "niet vastgesteld", en daar
 * hoort zwijgen bij, geen waarschuwing. De assen (`kb`/`tables`/`web`) reizen
 * mee voor context maar worden hier NIET opnieuw tot een oordeel verwerkt —
 * dat zou de tweede implementatie zijn die dit bestand vermijdt.
 *
 * @returns {'grounded'|'ungrounded'|null}
 */
export function groundingVerdictOf(agent) {
    const g = isObj(agent) ? agent.grounding : null;
    if (!isObj(g)) return null;
    return g.verdict === 'grounded' || g.verdict === 'ungrounded' ? g.verdict : null;
}

/** De volgorde waarin een mens de soorten leest. Onbekende soort: achteraan. */
function kindOrder(kind) {
    const i = USAGE_KINDS.indexOf(kind);
    return i === -1 ? USAGE_KINDS.length : i;
}

const byKind = (a, b) => kindOrder(a) - kindOrder(b) || String(a).localeCompare(String(b));

/**
 * De "gebruikt door"-helft: wat er gevonden is, en wat niemand kon
 * controleren.
 *
 * Drie uitkomsten, niet twee. Het veld is er alleen met `?usage=1`, en
 * afwezig ⇒ er wordt niets over gezegd; een leeg object zou "door niets
 * gebruikt" beweren over een pass die nooit liep. Een soort in `partial` is
 * geen nul, en een `partial` die zelf geen lijst is, is een onleesbaar
 * antwoord over ALLE soorten — dezelfde smalle lezing die
 * `summariseDeleteBlock` hiernaast maakt.
 */
function usageHalf(usage) {
    if (!isObj(usage)) return { usageAsked: false, usedBy: [], unchecked: [] };
    const counts = isObj(usage.counts) ? usage.counts : {};
    return {
        usageAsked: true,
        usedBy: Object.entries(counts)
            .map(([kind, n]) => ({ kind, count: countOrNull(n) }))
            .filter(u => u.count !== null && u.count > 0)
            .sort((a, b) => byKind(a.kind, b.kind)),
        unchecked: Array.isArray(usage.partial)
            ? usage.partial.filter(k => typeof k === 'string' && k).sort(byKind)
            : [...USAGE_KINDS],
    };
}

/**
 * Mag deze voet "alleen jij" zeggen?
 *
 * Vier voorwaarden, en alle vier zijn bewijs voor die ene bewering: de agent is
 * niet gepubliceerd (niemand anders kan er nu bij), jij bent de eigenaar, en er
 * staat GEEN gesprek van iemand anders in — geteld, niet aangenomen.
 * `is_published` mag niet ONTBREKEN: afwezig is onbekend, en onbekend versmalt
 * naar de neutrale vorm.
 *
 * `others === null` blokkeert de vorm. Dat is het geval waarin de server niet
 * wist wie er keek (geen `excludeUserId`), en dan is de FILTER over álle rijen
 * gelopen: een 0 zou daar "niemand anders" beweren zonder bewijs.
 */
function onlyYou(row, viewerId, others) {
    const published = row?.is_published ?? row?.isPublished;
    const owner = row?.owner_id ?? row?.ownerId;
    const mine = !!viewerId && !!owner && String(owner) === String(viewerId);
    return published === false && mine && others === 0;
}

/**
 * Mag de waarschuwing "antwoordt uit het hoofd" op deze rij?
 *
 * Het CRITERIUM staat op de server (core/agentRuntime/agentGrounding.js) en
 * wordt hier alleen gelezen. Wat hier staat is de AFBAKENING, en die is een
 * spiegel van de `WHERE` van Studio's aandachtslijst
 * (routes/studio/attentionChecks.js: `owner_id NOT IN ('system','swarm') AND
 * is_published = TRUE`). Twee redenen om hem over te nemen:
 *
 *   - een concept zonder kennisbank is een agent die GEBOUWD wordt, en dat
 *     melden levert ruis op elke net aangemaakte kaart. Zonder deze grens
 *     schreeuwde het overzicht over agents waar Start bewust over zwijgt;
 *   - `is_published` mag niet ONTBREKEN: onbekend versmalt naar zwijgen.
 *
 * En één afbakening die H3 niet heeft maar deze kaart wél nodig heeft: de
 * grounding is berekend over de CONCEPT-config. Voor een rij met
 * `published_version > 0` serveert de runtime `published_config`, en die blob
 * verlaat de store nooit (`agentCrud._stripPublishedBlobs`). Pal onder een pil
 * die "LIVE v8" zegt een uitspraak doen over een versie die niet draait is een
 * tegenspraak op één kaart, dus daar zwijgt de voet. Voor H3 — een werklijst
 * voor de bouwer — is het concept juist de goede kolom; vandaar het verschil.
 */
function warnsUngrounded(row) {
    if (groundingVerdictOf(row) !== 'ungrounded') return false;
    const published = row?.is_published ?? row?.isPublished;
    if (published !== true) return false;
    const version = Number(row?.published_version ?? row?.publishedVersion ?? 0);
    return !(Number.isFinite(version) && version > 0);
}

/**
 * Wat er in de voet van deze kaart staat.
 *
 * @param {unknown} agent  één rij van GET /agents/all
 * @param {string|null} viewerId  wie er kijkt; zonder dat kan "alleen jij"
 *   niet waar zijn en verschijnt die vorm niet
 * @returns {{
 *   variant: 'ungrounded'|'private'|'counts',
 *   statsAsked: boolean,
 *   conversations: number|null,
 *   people: number|null,
 *   usageAsked: boolean,
 *   usedBy: Array<{kind: string, count: number}>,
 *   unchecked: string[],
 * }}
 */
export function summariseCardFooter(agent, viewerId = null) {
    const row = isObj(agent) ? agent : null;

    // DRIE ANTWOORDEN, NIET TWEE. Een rij ZONDER het veld `stats` komt van een
    // route die de tellingen nooit uitrekende (/agents/system) — daar valt
    // niets over te zeggen. `stats: null` is een route die het WEL probeerde en
    // faalde, en dat verdient woorden. Een 0 die de server geteld heeft blijft
    // een 0.
    const statsAsked = !!row && 'stats' in row;
    const stats = isObj(row?.stats) ? row.stats : null;
    const conversations = stats ? countOrNull(stats.conversationCount) : null;
    const people = stats ? countOrNull(stats.userCount) : null;
    const others = stats ? countOrNull(stats.othersConversationCount) : null;
    const facts = { statsAsked, conversations, people, ...usageHalf(row?.usage) };

    // De waarschuwing gaat vóór: het is de enige van de drie die om iets
    // vraagt. Alleen een HARD 'ungrounded' van de server telt, en alleen binnen
    // de afbakening hierboven; "niet vastgesteld" waarschuwt niet.
    if (warnsUngrounded(row)) return { variant: 'ungrounded', ...facts };
    if (onlyYou(row, viewerId, others)) return { variant: 'private', ...facts };
    return { variant: 'counts', ...facts };
}
