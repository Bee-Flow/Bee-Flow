/**
 * CONSENT, not capability: must a person say yes before this call runs, and
 * WHOSE connection does it run on?
 *
 * `confirmForTool` is the hold-back verdict; `actAsForTool` is the raw `actAs`
 * reader and `mayLendOwnerConnection` is the gate both dispatch sites ask —
 * deliberately two functions, because the raw reader cannot tell "the owner
 * chose viewer" from "nobody wrote anything down" and the gate must.
 */

'use strict';

const { effectOf } = require('../../../automation/sideEffectMap');
const { _plainObject, toolsConfigOf, CONFIRM_MODES, ACT_AS_MODES } = require('./configShape');
const { appIdForTool, isAttributionAvailable, _decidingApps, _warnDegraded } = require('./appIndex');
const { hasCuratedGrants } = require('./grantResolution');

/**
 * `direct` or `ask` for one tool.
 *
 *   reads  → always direct (there is nothing to approve)
 *   sends  → always ask    (whatever the config says)
 *   writes → the app entry's `confirm`, else `legacyDefault`
 *
 * `legacyDefault` is 'direct' on purpose: an agent that predates the picker
 * must not start asking for confirmation on writes it has always just done.
 */
function confirmForTool(toolName, toolsConfig, { legacyDefault = 'direct' } = {}) {
    const effect = effectOf(toolName);          // sideEffectMap — no registry involved
    if (effect === 'reads') return 'direct';
    if (effect === 'sends') return 'ask';
    // De opt-in-grens, ook hier: een agent zonder grants-map heeft geen
    // beslissing die opgezocht kan worden, dus de registry wordt niet eens
    // aangeraakt. Zonder deze afslag raakt elke oude agent hem alsnog op elke
    // beurt — precies wat "onzichtbaar shipbaar" uitsluit.
    if (!_plainObject(toolsConfig)) return CONFIRM_MODES.includes(legacyDefault) ? legacyDefault : 'direct';
    const appId = appIdForTool(toolName);
    // Same rule as isToolAllowed: with attribution degraded, the owner's
    // `confirm` for this app cannot be found, and "I could not find the
    // decision" is not "there was none". Only for an agent that has grants —
    // an agent without one has no decision to lose.
    if (!appId && !isAttributionAvailable() && hasCuratedGrants(toolsConfig)) return 'ask';
    if (!appId) return CONFIRM_MODES.includes(legacyDefault) ? legacyDefault : 'direct';
    // Levert meer dan één app deze tool, dan telt de SMALSTE keuze: één 'ask'
    // ergens is een bevestiging die iemand heeft aangezet, en de andere rij mag
    // hem niet wegdrukken. Zonder dit gold alleen de keuze van de eigenaar van
    // de naam en was de `confirm` op de andere rij opslaanbaar en dood.
    let sawDirect = false;
    for (const id of _decidingApps(appId, toolName)) {
        const entry = toolsConfig[id];
        if (!_plainObject(entry) || !CONFIRM_MODES.includes(entry.confirm)) continue;
        if (entry.confirm === 'ask') return 'ask';
        sawDirect = true;
    }
    if (sawDirect) return 'direct';
    return CONFIRM_MODES.includes(legacyDefault) ? legacyDefault : 'direct';
}

/**
 * 'viewer' | 'owner' for one tool — only ever 'owner' on a normalised config.
 *
 * The RAW reader: it answers with the module default ('viewer') whether the
 * owner chose that or said nothing at all. Dispatch must not use it directly —
 * see `mayLendOwnerConnection`, which keeps those two apart.
 *
 * Sinds A2-2 geven de twee op een GECUREERDE agent hetzelfde antwoord, en dat
 * maakt ze nog steeds niet uitwisselbaar: op een agent die niemand cureerde
 * zegt deze functie 'viewer' terwijl de poort (de opt-in-grens) juist wél
 * leent. Wie hier zijn dispatchvraag stelt, stelt hem aan de verkeerde.
 */
function actAsForTool(toolName, toolsConfig) {
    const appId = appIdForTool(toolName);
    const entry = appId && toolsConfig ? toolsConfig[appId] : null;
    if (_plainObject(entry) && ACT_AS_MODES.includes(entry.actAs)) return entry.actAs;
    return 'viewer';
}

/**
 * May this call borrow the OWNER's connection? The `actAs` question in the
 * shape the dispatch sites need it, so both of them ask it the same way.
 *
 * ── ALLEEN EEN OPGESLAGEN JA LEENT (A2-2) ───────────────────────────
 * Op een gecureerde agent leent dit uitsluitend waar de eigenaar `actAs:
 * 'owner'` heeft OPGESLAGEN. Geen entry voor deze app, een entry zonder
 * `actAs`, of een `actAs` die niemand kan lezen: alle drie "er is niets
 * opgeschreven", en niets opgeschreven is geen ja.
 *
 * Tot A2-2 gaf de ontbrekende entry hier `true`, met het argument dat
 * "Gmail cureren geen uitspraak over Outlook is" — hetzelfde argument dat bij
 * `actions` klopt. Bij `actAs` klopt het niet, en het verschil zit in wat er
 * misgaat als je je vergist:
 *
 *   `actions`  is een VERMOGEN-vraag. Een ontbrekende entry breed lezen geeft
 *              de agent de toolbelt die hij gisteren ook had — niemand krijgt
 *              iets wat hij nog niet had, en te smal lezen zou een agent stil
 *              uitkleden. Breed is daar de voorzichtige kant.
 *   `actAs`    is een IDENTITEIT-vraag. Breed lezen zet de LIVE verbinding van
 *              de eigenaar (mailbox, Drive, agenda) onder de vingers van een
 *              ANDERE persoon die de agent draait. Onbekend moet daar
 *              versmallen — dezelfde regel die deze functie twee regels
 *              hierboven al toepast (attributie stuk ⇒ false) en in haar catch
 *              (onleesbare config ⇒ false), en die `normaliseToolsConfig` op
 *              `lentProviders === null` toepast ("ik kon het niet nagaan" is
 *              geen ja).
 *
 * En het scherm zei het al: de Tools-kaart tekent "As: the person asking"
 * zodra er geen `actAs` is opgeslagen (agent-hub canUse/toolGrants.js →
 * `storedActAsOf` is null ⇒ ACT_AS.VIEWER), en `actAsForTool` hierboven
 * antwoordt op diezelfde toestand ook 'viewer'. Twee van de drie lezers zeiden
 * dus al "de vrager"; alleen deze poort leende. De kant die de eigenaar op zijn
 * scherm leest is de kant die waar moet zijn — de andere kant kost het meest en
 * is onzichtbaar.
 *
 * ── WELKE AGENTS DIT MERKEN ─────────────────────────────────────────
 * Alleen waar ALLE vijf tegelijk gelden:
 *   1. `INTEGRATION_CONNECTION_LENDING_ENABLED` staat aan (default UIT, zie
 *      integrations/connectionResolution.js);
 *   2. de agent heeft een GECUREERDE map (`hasCuratedGrants`);
 *   3. de app van deze tool heeft daarin geen entry, of geen leesbare `actAs`
 *      (normalisatie schrijft er een op elke entry die zij uitgeeft, dus dit is
 *      een app die de eigenaar nooit opende — of een map die de route oversloeg);
 *   4. de agent wordt gedraaid door iemand anders dan de eigenaar
 *      (`resolveEffectiveIdentity` leent nooit van jezelf);
 *   5. er is een levende leen-grant van de eigenaar voor de provider van die app.
 * Die aanroep liep op de verbinding van de EIGENAAR en loopt nu op die van de
 * vrager zelf — met, als de vrager die app niet gekoppeld heeft, een "niet
 * verbonden" in plaats van stilzwijgend andermans postbus. De Tools-kaart zegt
 * dat per rij hardop (`ownerLendingUnset` in canUse/toolGrants.js), zodat dit
 * geen stille gedragswijziging is maar een zichtbare.
 *
 * ── WAT ONVERANDERD BLIJFT ──────────────────────────────────────────
 *   VERSTUURT ⇒ nee, altijd. Zie de eerste regel van de functie: dat is geen
 *   grant-vraag maar de bodem onder alle drie de takken, en hij geldt dus ook
 *   op de niet-gecureerde agent hieronder.
 *
 *   NIET GECUREERD ⇒ ja. De fence is `hasCuratedGrants`, niet de aanwezigheid
 *   van de sleutel. `{}` — wat `_clampRuntimeTools` en `applyConfigValidation`
 *   allebei WEGSCHRIJVEN zodra een geweigerde sectie het enige was wat een map
 *   hield — en junk-only maps zijn overal hier "precies als geen map"; de poort
 *   aan de kale sleutel hangen zette lenen uit voor al die agents. Een agent die
 *   niemand cureerde leent dus nog steeds als vóór deze laag, en de kaart meldt
 *   dát op zijn beurt (`ownerLendsUncurated`).
 *
 *   NIET TE ZEGGEN WELKE APP ⇒ nee, voor een agent met grants. Zelfde regel als
 *   `isToolAllowed` en `confirmForTool`: met de attributie stuk lijkt elke naam
 *   onbekend, en "ik kon het antwoord van de eigenaar niet vinden" is geen
 *   "de eigenaar zei ja". Met een gezonde index blijft een naam die GEEN app
 *   claimt wél lenen: een grant op een app kan niets zeggen over een naam die
 *   geen app bezit. Let op — dat is niet inert: `providerForTool` herkent een
 *   provider op PREFIX, dus een dynamisch geïnjecteerde naam buiten het
 *   registry (`n8n_run_<slug>`) leent hier nog steeds terwijl de kiezer er geen
 *   rij voor heeft om ja te zeggen. Dat gat hoort bij de tools-die-de-kiezer-
 *   niet-kan-tonen, niet bij deze poort, en het wordt daar gedicht.
 *
 * Total: it is read inside a dispatch path, so it never throws. An agentConfig
 * that cannot even be read at all lands on `false`, the closed side.
 */
function mayLendOwnerConnection(toolName, agentConfig) {
    try {
        // ── EEN VERZENDENDE TOOL LEENT NOOIT (A2-tegenspraak) ───────
        // `normaliseToolsConfig` weigert `actAs: 'owner'` zodra de grant een
        // sends-actie bevat ("een geleende verbinding verstuurt nooit zonder de
        // eigenaar erbij"), en de kaart weigert de eigenaar-optie op dezelfde
        // grond. Die regel gold alleen op de GECUREERDE tak; de wijdste tak —
        // een agent die niemand cureerde, wat elke agent van vóór deze laag is
        // — leende ook `signrequest_send_document` en `linkedin_create_post`,
        // onder de naam van de eigenaar, gestuurd door een ander. Niemand kan
        // dat AANvinken, dus het hoort ook niet te kunnen gebeuren.
        //
        // Vóór de opt-in-grens, want het is geen grant-vraag: het is dezelfde
        // bodem als `confirmForTool`'s `sends ⇒ ask`, en die kent ook geen
        // uitzondering voor een agent zonder map.
        if (effectOf(toolName) === 'sends') return false;
        const cfg = toolsConfigOf(agentConfig);
        if (!hasCuratedGrants(cfg)) return true;
        const appId = appIdForTool(toolName);
        if (!appId) {
            if (isAttributionAvailable()) return true;
            _warnDegraded(`refusing the owner's connection for "${toolName}" on an agent with stored grants`);
            return false;
        }
        // Bewust ALLEEN de entry van de app die de naam bezit, ook wanneer een
        // tweede registry-entry dezelfde tool levert (`_decidingApps`). Bij
        // `actions` en `confirm` spreken die twee allebei mee omdat elk van hen
        // kan VERSMALLEN; identiteit is één vraag over één credential, en
        // `normaliseToolsConfig` weigert `actAs: 'owner'` daarom op de app die
        // zijn grants elders laat lopen (`appDefersGrants`). Haar `viewer` is
        // dus geen keuze maar de afwezigheid ervan, en die als veto lezen zou
        // de rij van de eigenaar onbruikbaar maken.
        const entry = cfg[appId];
        // Alleen een opgeslagen ja. Geen entry, geen `actAs` en een onleesbare
        // `actAs` zijn hetzelfde antwoord: er staat niets, dus er wordt niets
        // geleend — precies wat de kaart voor deze toestand tekent.
        return _plainObject(entry) && entry.actAs === 'owner';
    } catch (_) {
        return false;
    }
}

module.exports = { confirmForTool, actAsForTool, mayLendOwnerConnection };
