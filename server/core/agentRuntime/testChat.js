/**
 * De TESTCHAT (A4 deel A).
 *
 * `POST /agents/:id/chat/stream` met `{ test: true }` is één gewone beurt in
 * een EFEMERE conversatie, gedraaid op het CONCEPT van de agent. Dit bestand
 * is de enige plek die vastlegt wát dat betekent, zodat de route, de runtime
 * en de kostenrapportage niet elk hun eigen antwoord verzinnen.
 *
 * ── EEN TESTGESPREK IS GEEN GESPREK ─────────────────────────────────
 * Overal waar conversaties opduiken moet een testgesprek hetzelfde betekenen,
 * anders is de telling op de andere plek onwaar. Er is precies één mechanisme
 * dat dat garandeert: er wordt GEEN RIJ geschreven. `ephemeral: true` slaat de
 * hele persistentie over (chatStream maakt een in-memory `ephemeral-<ts>`), en
 * daarmee is het testgesprek per constructie afwezig in:
 *
 *   • de historie      — `listConversations` / `listAllConversations` /
 *                        `searchConversations` / `GET /:id/history`;
 *   • de kaartvoet A5  — `getAgentChatStats` telt rijen van
 *                        `agent_conversations`;
 *   • de Used-by-tab   — dezelfde teller, via `gatherUsage`;
 *   • de DSR-export    — die leest conversaties (nu nog niet, later wel) uit
 *                        dezelfde tabel.
 *
 * Een `is_test`-kolom zou het tegenovergestelde doen: dan bestaat de rij wél
 * en moet ELKE lezer een filter krijgen dat een nieuwe lezer volgend jaar
 * vergeet. Afwezigheid heeft geen lezers nodig.
 *
 * ── BEHALVE IN DE KOSTEN, EN DAAR KRIJGT HET ZIJN EIGEN NAAM ────────
 * `usageStore.logUsage` schrijft óók voor een efemere beurt — dat is juist,
 * een testbeurt kost echt geld op iemands sleutel. Maar hij schreef
 * `source: 'agent_stream'` / `'agent_chat'`, en dáár telde een testgesprek dus
 * wél mee als gewoon gesprek. Dat is de ene plek die de telling elders onwaar
 * maakte. Een testbeurt draagt vanaf nu zijn eigen bron, zoals de
 * testset-run dat al deed met `agent_test_grade`. `COUNT(DISTINCT
 * conversation_id)` over die bron is de eerlijke lezing van "n testgesprekken":
 * één efemere conversatie = één id = één testgesprek.
 *
 * Die laatste zin is een EIS aan de id, geen waarneming. Een efemere
 * conversatie kreeg zijn id per REQUEST (`ephemeral-<Date.now()>`), dus
 * `COUNT(DISTINCT …)` telde beurten en een testgesprek van zes berichten
 * rapporteerde er zes. `ephemeralConversationId` hieronder maakt de id
 * STABIEL over de beurten van één testgesprek: de client draagt zijn
 * sessiesleutel mee en de server hasht die samen met de gebruiker en de agent.
 * Zonder sleutel is het antwoord willekeurig-en-nieuw — dat telt te HOOG
 * (elke beurt een gesprek), en dat is de kant waar niemand een gesprek
 * ziet dat niet bestond.
 *
 * ── EN IN DE AUDIT-RIJEN, MET DEZELFDE NAAM ÉN EEN DROOGLOOPVLAG ────
 * Verbruik was niet het enige dat een testbeurt wegschrijft. De
 * input-guardrails, de PII-events rond een tool en het egress-logboek
 * schreven allemaal hard `source: 'agent_stream'`, dus een experiment van de
 * bouwer stond in de org-privacy-shield-activiteit tussen de productiebeurten
 * — gekoppeld aan een conversation_id die nergens bestaat. Die vijf plekken
 * lopen nu door `usageSourceFor` én zetten `isDryRunTurn`, precies zoals de
 * automation-runner dat voor een droogloop doet: `guardrail_events.is_dry_run`
 * bestaat al en de org-shield filtert er al op.
 *
 * ── HET DRAAIT OP HET CONCEPT ───────────────────────────────────────
 * `chatWithAgentStream` laadt normaal via `getForRuntime`, en dat serveert de
 * GEPUBLICEERDE config zodra er een publicatie is — precies wat R2 voor een
 * AI-stap vastlegde. Een testchat doet het omgekeerde, met opzet: je test wat
 * je aan het maken bent. Het verschil is geen detail dat je mag verzwijgen —
 * wie zijn concept test en denkt dat hij de live agent ziet, test iets anders
 * dan er draait. Daarom stuurt de runtime `test_chat` over de lijn met wat er
 * werkelijk geladen is (`source`), wat er live staat (`publishedVersion`) en
 * hoever het concept daarop vooruit loopt (`unpublishedChanges`).
 *
 * ── WAT NIET VANZELF MAG WEGGAAN ────────────────────────────────────
 * Een testchat draait ECHTE tools op ECHTE verbindingen. Daarom wordt in een
 * testchat alles wat niet leest vastgehouden voor een mens (`holdsEffect`),
 * óók wanneer de agentconfig er `direct` van maakt. Dat is alleen maar
 * strenger dan een gewone chat — het kan nooit een call vrijgeven die anders
 * werd tegengehouden — en het maakt de beslisknoppen op de kaart het echte
 * werk in plaats van decoratie.
 *
 * Run: cd server && node --test core/agentRuntime/testChat.test.js
 */

'use strict';

const crypto = require('crypto');
const { effectOf } = require('../../automation/sideEffectMap');

/** De bron waaronder een testbeurt in `ai_usage_log` terechtkomt. */
const TEST_CHAT_USAGE_SOURCE = 'agent_test_chat';

/** Foutcodes van de poort. Zelfde vorm als TEST_AS_CODES. */
const TEST_CHAT_CODES = {
    notAllowed: 'test_chat_not_allowed',
    checkFailed: 'test_chat_check_failed',
};

/** Hoeveel beslissingen één verzoek mag meedragen. */
const MAX_TOOL_DECISIONS = 20;
/** Lengte van de sleutel die de kaart terugstuurt (hex). */
const ARGS_KEY_LENGTH = 32;
/**
 * Het voorvoegsel van elke efemere conversatie-id. Een echte rij-id is een
 * uuid/nanoid, dus deze vorm kan er nooit één aanwijzen — dat is precies wat
 * hem veilig maakt om uit clientinvoer af te leiden.
 */
const EPHEMERAL_PREFIX = 'ephemeral-';

/**
 * Vroeg de client een testchat?
 *
 * Alleen een letterlijke `true` telt. `'false'`, `0` en `''` zijn geen
 * testchat — een string uit een querystring die als waarheid wordt gelezen is
 * precies hoe een gewone beurt per ongeluk efemeer wordt en uit de historie
 * verdwijnt.
 */
function wantsTestChat(body) {
    return !!body && body.test === true;
}

/** Draait DEZE beurt als testchat? Leest de metadata die de route zette. */
function isTestChat(messageMetadata) {
    return !!messageMetadata && messageMetadata.testChat === true;
}

/**
 * De poort: mag deze aanvrager een testchat draaien?
 *
 * Hetzelfde recht dat "Test als" vraagt (A1c) en dat `PUT /agents/:id` vraagt:
 * testen hoort bij het bouwen. Een chatter die de agent mag gebruiken hoort
 * niet stiekem het ongepubliceerde concept te kunnen uitlezen — dat is een
 * lek van werk-in-uitvoering, niet alleen een gemak.
 *
 * Weigert; degradeert nooit naar een gewone beurt. Een testchat die stilletjes
 * de gepubliceerde config draait is het ene antwoord dat deze route nooit mag
 * geven.
 *
 * @returns {{ok:true, testChat:boolean}|{ok:false, status:number, error:string, code:string}}
 */
function gateTestChatRequest({ test, canEdit } = {}) {
    if (test !== true) return { ok: true, testChat: false };
    if (!canEdit) {
        return {
            ok: false, status: 403, code: TEST_CHAT_CODES.notAllowed,
            error: 'Only someone who can edit this agent can test it.',
        };
    }
    return { ok: true, testChat: true };
}

/**
 * De bron waaronder deze beurt zijn verbruik wegschrijft.
 *
 * @param {object} messageMetadata
 * @param {string} fallback  wat de call-site schreef toen dit nog niet bestond
 */
function usageSourceFor(messageMetadata, fallback) {
    return isTestChat(messageMetadata) ? TEST_CHAT_USAGE_SOURCE : fallback;
}

/**
 * Is deze beurt een DROOGLOOP voor elke audit-lezer?
 *
 * Zelfde woord als de automation-runner gebruikt voor een droge run
 * (`core/automationRunner/execution.js`), zodat `guardrail_events.is_dry_run`
 * één betekenis houdt: er is echt gerekend, er is echt gescand, maar dit was
 * geen productiebeurt en een dashboard dat naar productie kijkt hoort hem niet
 * te tellen. De kolom bestaat al en de org-shield filtert er al op — dit zet
 * hem alleen ook voor de testchat.
 *
 * Bewust een aparte naam naast `isTestChat`: de call-sites hieronder gaan over
 * AUDIT, niet over runtimegedrag, en een lezer die `is_dry_run: isTestChat(m)`
 * ziet staan moet niet hoeven raden of dat een toevalligheid is.
 */
function isDryRunTurn(messageMetadata) {
    return isTestChat(messageMetadata);
}

/**
 * De id van een EFEMERE conversatie: stabiel over de beurten van één sessie.
 *
 * Waarom dit niet gewoon `ephemeral-${Date.now()}` mag zijn: `usageStore`
 * telt testgesprekken met `COUNT(DISTINCT conversation_id)`. Met een id per
 * REQUEST telt dat BEURTEN, en een testgesprek van zes berichten rapporteert
 * er zes. De sleutel maakt de id stabiel zolang de client dezelfde
 * testsessie draait.
 *
 * Waarom de sleutel van de client NIET rechtstreeks de id wordt:
 *
 *   • de id reist mee in `guardrail_events.conversation_id`, in het
 *     egress-logboek en in de PII-tokenmap-memo (die op conversation-id
 *     hangt). Een client die een ECHTE conversatie-id opgeeft zou daarmee de
 *     tokenmap van dat gesprek aanspreken. Daarom wordt er gehasht, en met
 *     het `ephemeral-`-voorvoegsel ervoor: die vorm kan per constructie geen
 *     bestaande rij aanwijzen.
 *   • twee gebruikers die toevallig dezelfde sleutel kiezen mogen niet in
 *     dezelfde efemere conversatie belanden. Daarom zitten `userId` en
 *     `agentId` in de hash — de sleutel alleen is geen adres.
 *
 * Zonder bruikbare sleutel: willekeurig en nieuw. Dat telt te HOOG (elke beurt
 * een gesprek), en te hoog tellen laat niemand een gesprek missen dat er wel
 * was — de omgekeerde fout, twee sessies op één id, zou dat wél doen.
 *
 * @param {object} p
 * @param {string} [p.sessionKey] wat de client meestuurt voor deze testsessie
 * @param {string} [p.userId]
 * @param {string} [p.agentId]
 */
function ephemeralConversationId({ sessionKey, userId, agentId } = {}) {
    const key = typeof sessionKey === 'string' ? sessionKey.trim() : '';
    if (key.length >= 8 && key.length <= 200) {
        const digest = crypto.createHash('sha256')
            .update(`ephemeral|${String(userId || '')}|${String(agentId || '')}|${key}`)
            .digest('hex')
            .slice(0, 32);
        return `${EPHEMERAL_PREFIX}${digest}`;
    }
    return `${EPHEMERAL_PREFIX}${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * De sessiesleutel zoals hij van een request af mag komen.
 *
 * Een opake string van de client, meer niet — hij wordt gehasht en nooit
 * ergens tegenaan gehouden. Te kort of te lang telt als "geen sleutel", en dat
 * levert een verse id op in plaats van een gedeelde.
 */
function normaliseSessionKey(raw) {
    if (typeof raw !== 'string') return null;
    const key = raw.trim();
    if (key.length < 8 || key.length > 200) return null;
    if (!/^[A-Za-z0-9._:-]+$/.test(key)) return null;
    return key;
}

/**
 * Wat er op het scherm moet staan over WELKE agent er zojuist draaide.
 *
 * `runtimeSource` komt uit de store-projectie en is het enige eerlijke
 * antwoord: 'draft' is het concept, 'published' de gepubliceerde blob, 'live'
 * een agent die nooit gepubliceerd is (concept en live zijn dan hetzelfde).
 *
 * Een projectie die niets zei is NIET stilzwijgend het concept: dan komt er
 * `source: 'unknown'` uit en mag het scherm geen geruststelling tonen. De
 * omgekeerde fout — "je test je concept" zeggen terwijl de gepubliceerde blob
 * draaide — is precies de leugen die deze hele functie bestaat om te
 * voorkomen.
 *
 * WAT DIE TAK VANDAAG WEL EN NIET IS: op het testchatpad stempelt
 * `agentCrud.projectDraft` onvoorwaardelijk `runtimeSource: 'draft'`, en een
 * rij die niet bestaat gooit al eerder 'Agent not found'. 'published' en
 * 'unknown' zijn daar dus niet te bereiken — ze staan hier als
 * FAIL-CLOSED-default voor de tweede call-site die de JSDoc van
 * `ruleAttribution.attributeTurn` uitnodigt (`versionInfo(views)`), en voor
 * een projectie die morgen wél iets anders kan zeggen. Ze zijn niet getest op
 * dit pad omdat ze op dit pad niet voorkomen; dat is iets anders dan
 * "getoetst".
 */
function testChatConfigInfo(agent) {
    const src = agent && agent.runtimeSource;
    const source = (src === 'draft' || src === 'published' || src === 'live') ? src : 'unknown';
    const publishedVersion = Number(agent && agent.published_version) || 0;
    const rev = Number(agent && agent.rev) || 0;
    const publishedRev = Number(agent && agent.published_rev) || 0;
    return {
        source,
        // Draait wat je aan het maken bent? Alleen 'draft' en 'live' zijn dat;
        // bij 'unknown' weten we het niet, en dat is geen ja.
        runsDraft: source === 'draft' || source === 'live',
        publishedVersion,
        agentRev: rev,
        // Hoe ver het concept voorloopt op wat er live staat. Zonder publicatie
        // is er niets om op voor te lopen.
        unpublishedChanges: publishedVersion > 0
            ? Math.max(0, (rev || 1) - publishedRev)
            : 0,
    };
}

/**
 * De sleutel van één vastgehouden call: de naam plus exact deze argumenten.
 *
 * Dit is de sleutel die `toolRoundExecutor` al gebruikt om één kaart per actie
 * per beurt te tonen (`toolName|stableStringify(args)`), maar gehasht — de
 * ruwe argumenten mogen niet over de lijn en al helemaal niet terug van een
 * client. Wat de kaart terugstuurt is dus een bewering over EEN actie, niet
 * over een tool: dezelfde naam met andere argumenten matcht niet.
 *
 * @param {string} toolName
 * @param {string} stableArgs  het resultaat van `_stableStringify(args)`
 */
function argsKeyFor(toolName, stableArgs) {
    return crypto.createHash('sha256')
        .update(`${String(toolName)}|${String(stableArgs)}`)
        .digest('hex')
        .slice(0, ARGS_KEY_LENGTH);
}

/**
 * De beslissingen die de client meestuurt, opgeschoond.
 *
 * Een beslissing is één `{ toolName, argsKey, decision }`. Onbekend versmalt:
 * alles wat niet letterlijk 'approve' of 'decline' is, telt niet mee — dus
 * ook geen `decision: 'approve '` of `true`. Meer dan MAX_TOOL_DECISIONS
 * worden afgekapt, want dit is een kaartje dat een mens aanklikte, geen batch.
 *
 * @returns {Map<string, 'approve'|'decline'>} argsKey → beslissing
 */
function normaliseToolDecisions(raw) {
    const out = new Map();
    if (!Array.isArray(raw)) return out;
    for (const d of raw) {
        if (out.size >= MAX_TOOL_DECISIONS) break;
        if (!d || typeof d !== 'object') continue;
        const decision = d.decision;
        if (decision !== 'approve' && decision !== 'decline') continue;
        const key = typeof d.argsKey === 'string' ? d.argsKey.trim() : '';
        if (!/^[0-9a-f]{8,64}$/.test(key)) continue;
        // Eerste beslissing over een sleutel wint. Een tweede regel met een
        // andere uitkomst voor dezelfde actie is geen nieuwe toestemming.
        if (!out.has(key)) out.set(key, decision);
    }
    return out;
}

/**
 * Moet een testchat deze call vasthouden ook al zegt de config 'direct'?
 *
 * Alles wat niet aantoonbaar leest. `effectOf` valt zelf al terug op 'writes'
 * voor een naam die hij niet kent, dus een onbekende tool wordt vastgehouden
 * — de kant die niets laat gebeuren.
 */
function holdsEffect(toolName, knownEffect) {
    const effect = knownEffect || (() => {
        try { return effectOf(toolName); } catch (_) { return 'writes'; }
    })();
    return effect !== 'reads';
}

module.exports = {
    TEST_CHAT_USAGE_SOURCE, TEST_CHAT_CODES, MAX_TOOL_DECISIONS, ARGS_KEY_LENGTH,
    EPHEMERAL_PREFIX,
    wantsTestChat, isTestChat, gateTestChatRequest, usageSourceFor, isDryRunTurn,
    testChatConfigInfo, argsKeyFor, normaliseToolDecisions, holdsEffect,
    ephemeralConversationId, normaliseSessionKey,
};
