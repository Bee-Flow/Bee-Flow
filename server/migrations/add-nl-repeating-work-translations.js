#!/usr/bin/env node
/**
 * Dutch for "Find repeating work" (Studio > Automations, 2026-10): the source
 * tiles (Mail, Calendar & meetings, Files, Bee Flow activity), the scan drawn
 * as a small flow (read, find templates, spot repeats, name patterns), the
 * pattern cards with their evidence pills, weekday strip, step preview and
 * "Why this ranks here", the Not now / Not repetitive feedback with its undo
 * notice, the empty states, the privacy footnote, and the launcher's tabs.
 *
 * This catalogue owns the `automations.repeating.` and `automations.tabs.` prefixes.
 * The keys under `automations.repeating.` that the earlier scan already had used
 * to be seeded by add-nl-builder-handoff5-translations; they moved here with
 * the same Dutch, so an install that ran that catalogue already holds them and
 * this one only fills what is new. One key, one owner: boot order never
 * decides the wording.
 *
 * Terminology follows the existing catalogue: koppelen (connect), scannen,
 * persoonsgegevens, sjabloon, trigger, Privacy Shield. A placeholder in a
 * template line is named after what it stands for (nummer, datum, kenmerk).
 *
 * SAME_AS_ENGLISH lists the keys whose Dutch is the English word itself
 * (Focus, Live, link, Runs). They are not seeded: the English default already
 * reads right, and a seeded copy would only hide a later rewording.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-repeating-work-translations.js
 */

const NL_TRANSLATIONS = Object.freeze({
    // Kept from the earlier scan screen (same Dutch as before).
    'automations.repeating.adjust': 'Eerst aanpassen',
    'automations.repeating.cooldown': 'Je hebt in korte tijd veel gescand. Over {seconds}s kun je weer scannen.',
    'automations.repeating.dismiss': 'Suggestie wegdoen',
    'automations.repeating.emptyTitle': 'Geen herhalend werk gevonden',
    'automations.repeating.emptyTry': 'Kies meer apps, geef een focus op zoals facturen of supporttickets, of scan over een week of twee opnieuw.',
    'automations.repeating.emptyWhy': 'Bee heeft {apps} gelezen maar niets gevonden dat vaak genoeg terugkomt om te automatiseren.',
    'automations.repeating.emptyWhyGeneric': 'Bee heeft niets gevonden dat vaak genoeg terugkomt om te automatiseren.',
    'automations.repeating.errorTitle': 'Bee kon de scan niet afmaken',
    'automations.repeating.focusLabel': 'Focus (optioneel)',
    'automations.repeating.focusPlaceholder': 'Optioneel: een focus, zoals facturen of supporttickets',
    'automations.repeating.hideDetails': 'Details verbergen',
    'automations.repeating.idea': 'Idee',
    'automations.repeating.intro': 'Bee leest je recente activiteit in de apps die je kiest en stelt werk voor dat je kunt automatiseren. Bee leest alleen, en er wordt niets gebouwd zonder jou.',
    'automations.repeating.logBlocked': 'tegengehouden door Privacy Shield',
    'automations.repeating.lookedAt': 'Gekeken in {apps}',
    'automations.repeating.needs': '{apps} moet nog gekoppeld worden',
    'automations.repeating.noAppsBody': 'Koppel eerst een app. Bee kan alleen kijken in apps die je hebt gekoppeld.',
    'automations.repeating.noAppsTitle': 'Nog niets om te scannen',
    'automations.repeating.noPersonalData': 'geen persoonsgegevens gevonden',
    'automations.repeating.observed': 'Gezien',
    'automations.repeating.oneRead': '1 keer gelezen',
    'automations.repeating.personalData': 'persoonsgegevens gevonden: {categories}',
    'automations.repeating.readCount': '{count} bronnen gelezen',
    'automations.repeating.readOne': '1 bron gelezen',
    'automations.repeating.reading': 'Bezig met {app} lezen…',
    'automations.repeating.reads': '{count} keer gelezen',
    'automations.repeating.reviewing': 'Bee zoekt patronen in wat het heeft gelezen…',
    'automations.repeating.scan': 'Mijn recente werk scannen',
    'automations.repeating.scanAgain': 'Opnieuw scannen',
    'automations.repeating.scanHint': 'Duurt ongeveer een minuut. Privacy Shield controleert alles wat Bee leest.',
    'automations.repeating.scannedAgo': 'Gescand {when}',
    'automations.repeating.showDetails': 'Details tonen',
    'automations.repeating.starting': 'De scan begint…',
    'automations.repeating.stop': 'Stoppen',
    'automations.repeating.title': 'Herhalend werk vinden',
    'automations.repeating.tryAgain': 'Opnieuw proberen',
    // Source tiles and the scan button.
    'automations.repeating.connectApps': 'Koppel een app',
    'automations.repeating.disabledNoSources': 'Zet minstens één bron aan om te scannen.',
    'automations.repeating.focusRemove': 'Focus weghalen',
    'automations.repeating.scanRunning': 'Scan loopt',
    'automations.repeating.sourceApps': '{count} apps gekoppeld',
    'automations.repeating.sourceAppsOne': '1 app gekoppeld',
    'automations.repeating.sourceBeeflow': 'Activiteit in Bee Flow',
    'automations.repeating.sourceCalendar': 'Agenda en vergaderingen',
    'automations.repeating.sourceConnect': 'Koppelen',
    'automations.repeating.sourceEyebrow': 'Bron',
    'automations.repeating.sourceFiles': 'Bestanden',
    'automations.repeating.sourceHistory': 'Geschiedenis',
    'automations.repeating.sourceInclude': '{source} meenemen',
    'automations.repeating.sourceMail': 'E-mail',
    'automations.repeating.sourceNotConnected': 'Nog niets gekoppeld',
    'automations.repeating.sourceReady': 'Klaar om te lezen',
    'automations.repeating.sourcesError': 'Bee kon je bronnen niet laden.',
    'automations.repeating.sourcesTitle': 'Bronnen',
    'automations.repeating.windowChip': 'Afgelopen {days} dagen',
    // The scan as a flow, and its details.
    'automations.repeating.errorGeneric': 'Er ging iets mis. Probeer het zo nog eens.',
    'automations.repeating.flowEvents': '{count} gebeurtenissen',
    'automations.repeating.flowEventsOne': '1 gebeurtenis',
    'automations.repeating.flowName': 'Patronen benoemen',
    'automations.repeating.flowNameSub': 'De AI ziet alleen patronen',
    'automations.repeating.flowPatternCount': '{count} patronen',
    'automations.repeating.flowPatternOne': '1 patroon',
    'automations.repeating.flowRead': 'Je werk lezen',
    'automations.repeating.flowRepeatCount': '{count} herhalingen',
    'automations.repeating.flowRepeatOne': '1 herhaling',
    'automations.repeating.flowRepeats': 'Herhalingen zoeken',
    'automations.repeating.flowRepeatsSub': 'Hoe vaak, hoe regelmatig',
    'automations.repeating.flowStep': 'Stap {n}',
    'automations.repeating.flowTemplateCount': '{count} sjablonen',
    'automations.repeating.flowTemplateOne': '1 sjabloon',
    'automations.repeating.flowTemplates': 'Sjablonen vinden',
    'automations.repeating.flowTemplatesSub': 'Namen en nummers afgeschermd',
    'automations.repeating.logReadApp': '{app} gelezen',
    'automations.repeating.logReadingApp': 'Bezig met {app} lezen',
    'automations.repeating.logSkippedApp': '{app} overgeslagen',
    'automations.repeating.progressMining': 'Zoeken naar wat terugkomt…',
    'automations.repeating.progressNaming': 'De patronen benoemen…',
    'automations.repeating.progressTemplating': 'Sjablonen zoeken…',
    'automations.repeating.skipAuth': 'moet opnieuw gekoppeld worden',
    'automations.repeating.skipBudget': 'de scan had geen tijd meer',
    'automations.repeating.skipError': 'kon niet worden gelezen',
    'automations.repeating.skipNotConnected': 'niet gekoppeld',
    'automations.repeating.skipTimeout': 'duurde te lang',
    'automations.repeating.skippedSources': 'Bee heeft {apps} deze keer overgeslagen. In de details staat waarom.',
    'automations.repeating.stopped': 'Scan gestopt. Er is niets nieuws opgeslagen.',
    // A pattern card.
    'automations.repeating.buildThis': 'Dit bouwen',
    'automations.repeating.cadenceIrregular': 'Onregelmatig',
    'automations.repeating.cadenceStrip': 'Per weekdag: {days}',
    'automations.repeating.cadenceWeekdays': 'Werkdagen',
    'automations.repeating.chooseTrigger': 'Trigger nog te kiezen',
    'automations.repeating.notNow': 'Nu niet',
    'automations.repeating.notNowHint': 'Dit patroon 30 dagen verbergen',
    'automations.repeating.notRepetitive': 'Niet herhalend',
    'automations.repeating.patternEyebrow': 'Patroon',
    'automations.repeating.previewMore': '+{count} meer',
    'automations.repeating.templateLabel': 'Lijkt op',
    'automations.repeating.whyToggle': 'Waarom dit hier staat',
    'automations.repeating.phDate': 'datum',
    'automations.repeating.phDomain': 'domein {tag}',
    'automations.repeating.phEmail': 'e-mailadres',
    'automations.repeating.phId': 'kenmerk',
    'automations.repeating.phName': 'naam',
    'automations.repeating.phNumber': 'nummer',
    'automations.repeating.phOrg': 'organisatie',
    'automations.repeating.pillEarly': 'Vroeg signaal',
    'automations.repeating.pillEarlyHint': 'Gebaseerd op weinig geschiedenis. Het wordt zekerder naarmate Bee meer weken ziet.',
    'automations.repeating.pillEstimated': 'geschat',
    'automations.repeating.pillHours': '≈{lo}–{hi} uur/maand',
    'automations.repeating.pillMeasured': 'gemeten',
    'automations.repeating.pillMinutes': '≈{lo}–{hi} min/maand',
    'automations.repeating.pillMinutesHint': 'De tijd die dit je per maand kost. Altijd een bandbreedte, nooit een exact getal.',
    'automations.repeating.pillTimes': '{count}× in {days} dagen',
    'automations.repeating.pillWeeks': '{present} van {window} weken',
    'automations.repeating.reasonEarly': 'Vroeg signaal: gebaseerd op weinig geschiedenis',
    'automations.repeating.reasonFrequent': 'Het gebeurt vaak',
    'automations.repeating.reasonMeasuredEffort': 'De tijd is gemeten in je eigen sessies',
    'automations.repeating.reasonMultiStep': 'Het kost elke keer meerdere stappen',
    'automations.repeating.reasonRecent': 'Het gebeurde de afgelopen weken nog',
    'automations.repeating.reasonRegular': 'Het volgt een vast ritme',
    'automations.repeating.reasonStructuredInput': 'Het begint met een voorspelbare invoer',
    'automations.repeating.wrongAlreadyAutomated': 'Dit is al geautomatiseerd',
    'automations.repeating.wrongDoMyself': 'Dit doe ik liever zelf',
    'automations.repeating.wrongGrouping': 'Dit zijn niet dezelfde taken',
    'automations.repeating.wrongPrivacy': 'Hier hoort Bee niet in te kijken',
    // Feedback, undo, results and empty states.
    'automations.repeating.feedbackFailed': 'Bee kon dat niet opslaan, dus het patroon staat er weer.',
    'automations.repeating.historyBody': 'Bee heeft een paar weken van je eigen activiteit nodig om te zien wat terugkomt. Scan over een week of twee opnieuw.',
    'automations.repeating.historyTitle': 'Nog niet genoeg geschiedenis',
    'automations.repeating.ideasLink': 'Liever ideeën voorstellen',
    'automations.repeating.ideasNone': 'Bee had deze keer geen ideeën.',
    'automations.repeating.ideasTitle': 'Ideeën · niet gezien in je activiteit',
    'automations.repeating.noSourcesBody': 'Zet hierboven minstens één bron aan, of koppel eerst een app.',
    'automations.repeating.noSourcesTitle': 'Geen bronnen om te lezen',
    'automations.repeating.privacyIdeas': 'Privacy Shield heeft alles wat Bee las gecontroleerd voordat de AI het zag.',
    'automations.repeating.privacyPatterns': 'Er is geen berichttekst naar de AI gestuurd, alleen patronen.',
    'automations.repeating.stale': 'Je bronnen of focus zijn veranderd sinds deze scan. Scan opnieuw om hem bij te werken.',
    'automations.repeating.undo': 'Ongedaan maken',
    'automations.repeating.undoClose': 'Sluiten',
    'automations.repeating.undoDismissed': 'Gemarkeerd als niet herhalend.',
    'automations.repeating.undoDismissedIdea': 'Suggestie weggedaan.',
    'automations.repeating.undoSnoozed': '30 dagen verborgen.',
    // The automations launcher's tabs.
    'automations.tabs.overview': 'Alle automatiseringen',
    'automations.tabs.repeating': 'Herhalend werk vinden',
    'automations.tabs.templates': 'Sjablonen',
});

/** Keys whose Dutch is the English text itself; deliberately not seeded. */
const SAME_AS_ENGLISH = Object.freeze([
    'automations.repeating.focusAdd',
   // Focus
    'automations.repeating.phUrl',
      // link
    'automations.repeating.sourceLive', // Live
    'automations.tabs.history',
         // Runs
]);

/** The mutation itself, on a copy of the 'nl' blob. Pure, so the store's mutator may run it more than once. */
function applyNl(merged) {
    let added = 0;
    for (const [key, value] of Object.entries(NL_TRANSLATIONS)) {
        if (!merged[key]) {
            merged[key] = value;
            added++;
        }
    }
    return { merged, added };
}

async function up() {
    const languageStore = require('../stores/languageStore');
    let added = 0;
    await languageStore.mutateGUITranslations('nl', (current) => {
        const result = applyNl(current);
        added = result.added;
        return result.merged;
    });
    if (added > 0) {
        console.log(`[Migration] add-nl-repeating-work-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, applyNl, NL_TRANSLATIONS, SAME_AS_ENGLISH };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
