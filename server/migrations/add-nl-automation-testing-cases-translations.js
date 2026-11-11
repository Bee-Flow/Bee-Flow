#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for the test cases of a code step (automation_testing.*, the part
 * add-nl-automation-testing-translations leaves out): the Tests tab and its
 * panel, the test editor (name, input, what should happen, the checks on the
 * result), the sentences a check reads as, why a check failed or a test could
 * not run, saving a run's input as a test case, and the line changes in
 * version compare. Together with that catalogue every automation_testing key
 * has Dutch.
 *
 * Terminology follows the builder's catalogues: a check on the result is a
 * "controle" (the code editor's Checks tab is "Controles"), a test case a
 * "testgeval", a run stays "run" and running a test is "draaien". The reader
 * is "je". SAME_AS_ENGLISH lists keys whose Dutch is the English text itself;
 * they are not seeded.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-automation-testing-cases-translations.js
 */

const NL_TRANSLATIONS = Object.freeze({
    // ── The Tests tab and its panel ────────────────────────────────────
    'automation_testing.unsaved': 'Sla de automatisering eerst op. Tests horen bij een opgeslagen stap.',
    'automation_testing.panel.delete_failed': 'De test kon niet worden verwijderd. Probeer het zo nog eens.',
    'automation_testing.panel.empty': 'Nog geen tests. Voeg er een toe met getypte waarden, of bewaar de invoer van een echte run als test, en zeg dan hoe het resultaat eruit moet zien.',
    'automation_testing.panel.intro': 'Een test draait deze code met een invoer en controleert het resultaat. Tests draaien de code zoals die in de editor staat, in de afgesloten sandbox; er wordt niets verstuurd.',
    'automation_testing.panel.limit': 'Deze stap heeft {n} tests, het maximum dat hij kan bewaren.',
    'automation_testing.panel.load_failed': 'De tests konden nu niet worden geladen.',
    'automation_testing.panel.loading': 'Tests laden…',
    'automation_testing.panel.new': 'Nieuwe test',
    'automation_testing.panel.run_all': 'Alle tests draaien',
    'automation_testing.panel.run_failed': 'De tests konden nu niet draaien. Probeer het zo nog eens.',
    'automation_testing.panel.summary': '{passed} geslaagd, {failed} mislukt, {errored} met een fout, {unusable} konden niet draaien',

    // ── One test in the list ───────────────────────────────────────────
    'automation_testing.case.delete': 'Verwijderen',
    'automation_testing.case.delete_confirm': 'Ja, verwijderen',
    'automation_testing.case.delete_named': '{name} verwijderen',
    'automation_testing.case.edit': 'Bewerken',
    'automation_testing.case.edit_named': '{name} bewerken',
    'automation_testing.case.keep': 'Houden',
    'automation_testing.case.run': 'Draaien',
    'automation_testing.case.run_named': '{name} draaien',
    'automation_testing.source.lost': 'De run waar deze invoer vandaan kwam is verwijderd',
    'automation_testing.source.run': 'Uit een run overgenomen',
    'automation_testing.source.typed': 'Getypte waarden',
    'automation_testing.status.error': 'Fout',
    'automation_testing.status.fail': 'Mislukt',
    'automation_testing.status.never': 'Nog niet gedraaid',
    'automation_testing.status.pass': 'Geslaagd',
    'automation_testing.status.unusable': 'Kan niet draaien',

    // ── The test editor ────────────────────────────────────────────────
    'automation_testing.editor.cancel': 'Annuleren',
    'automation_testing.editor.from_run_hint': 'De invoer van deze stap in deze run wordt bewaard als testgegevens. Voeg hieronder controles toe, zodat de test kan zien wanneer het resultaat fout is.',
    'automation_testing.editor.save': 'Test opslaan',
    'automation_testing.editor.title_edit': 'Test bewerken',
    'automation_testing.editor.title_new': 'Nieuwe test',
    'automation_testing.name.help': 'Een korte naam die zegt waar deze test over gaat.',
    'automation_testing.name.label': 'Naam',
    'automation_testing.name.needed': 'Geef de test een naam.',
    'automation_testing.name.placeholder': 'Bijvoorbeeld: kleine bestelling',
    'automation_testing.name.too_long': 'Gebruik hoogstens {max} tekens.',

    // ── The input: typed, or taken from a recorded run ─────────────────
    'automation_testing.input.label': 'Invoer',
    'automation_testing.input.lost': 'De run waar deze invoer vandaan kwam is verwijderd. Kies een andere run, of typ waarden.',
    'automation_testing.input.none': 'Deze code leest geen invoer, dus de test draait hem zoals hij is.',
    'automation_testing.input.other_run': 'Een andere run gebruiken',
    'automation_testing.input.recorded': 'Deze invoer komt uit een run en kan hier niet worden bewerkt.',
    'automation_testing.input.run': 'De invoer van een vastgelegde run gebruiken',
    'automation_testing.input.run_help': 'De waarden die deze stap in die run kreeg, worden bij de test bewaard. Ze worden verwijderd als de run wordt verwijderd.',
    'automation_testing.input.run_needed': 'Kies de run waar de invoer vandaan komt.',
    'automation_testing.input.typed': 'Waarden typen',
    'automation_testing.input.typed_help': 'Laat een vak leeg voor de standaardwaarde. Lijsten en objecten kun je als JSON typen.',
    'automation_testing.run.cancelled': 'Gestopt',
    'automation_testing.run.choose': 'Kies een run…',
    'automation_testing.run.current': 'De eerder gekozen run',
    'automation_testing.run.failed': 'Mislukt',
    'automation_testing.run.loading': 'Runs laden…',
    'automation_testing.run.none': 'Nog geen afgeronde runs. Draai de automatisering één keer, of typ waarden.',
    'automation_testing.run.pick': 'Run om de invoer uit te halen',
    'automation_testing.run.succeeded': 'Geslaagd',
    'automation_testing.run.unknown_time': 'Onbekend tijdstip',

    // ── What should happen, and the checks on the result ───────────────
    'automation_testing.expect.error': 'De code mislukt met een fout',
    'automation_testing.expect.error_help': 'Voor een test van wat er gebeurt bij foute invoer. De controles hieronder lezen de foutmelding.',
    'automation_testing.expect.label': 'Wat er moet gebeuren',
    'automation_testing.expect.success': 'De code slaagt',
    'automation_testing.expect.success_help': 'De controles hieronder lezen wat de code teruggeeft.',
    'automation_testing.assertion.remove': 'Deze controle verwijderen',
    'automation_testing.assertions.add': 'Controle toevoegen',
    'automation_testing.assertions.help': 'Elke controle zegt iets wat waar moet zijn over het resultaat. Een test slaagt als de code doet wat je verwacht en elke controle klopt.',
    'automation_testing.assertions.label': 'Controles op het resultaat',
    'automation_testing.assertions.too_many': 'Een test kan hoogstens {max} controles hebben.',
    'automation_testing.path.help': 'Laat leeg om het hele resultaat te controleren. Noem anders een veld, zoals order.total of items[0].name.',
    'automation_testing.path.invalid': 'Dat is geen pad dat de controle kan lezen. Gebruik veldnamen met punten, zoals order.total, en [0] voor het eerste item van een lijst.',
    'automation_testing.path.label': 'Waar in het resultaat',
    'automation_testing.path.placeholder': 'het hele resultaat',
    'automation_testing.path.whole': 'het hele resultaat',
    'automation_testing.op.contains': 'bevat',
    'automation_testing.op.count_is': 'heeft zoveel items',
    'automation_testing.op.equals': 'is precies',
    'automation_testing.op.has_key': 'heeft het veld',
    'automation_testing.op.label': 'Controle',
    'automation_testing.op.not_equals': 'is niet',
    'automation_testing.op.type_is': 'is van het type',
    'automation_testing.value.bad_number': 'Gebruik een geheel getal vanaf 0.',
    'automation_testing.value.cmp': 'Vergelijking',
    'automation_testing.value.count': 'Aantal items',
    'automation_testing.value.key': 'Veldnaam',
    'automation_testing.value.label': 'Waarde',
    'automation_testing.value.needed': 'Vul de waarde in waarmee deze controle vergelijkt.',
    'automation_testing.value_help.count': 'Hoeveel items een lijst heeft, hoeveel tekens een tekst heeft, of hoeveel velden een object heeft.',
    'automation_testing.value_help.json': 'Typ een getal, true of false, een lijst of een object zoals het is. Al het andere wordt als tekst gelezen; zet tekst die op een getal lijkt tussen aanhalingstekens.',
    'automation_testing.value_help.key': 'De naam van een veld dat het resultaat moet hebben.',
    'automation_testing.value_help.type': 'Wat voor waarde er moet staan.',
    'automation_testing.cmp.eq': 'precies',
    'automation_testing.cmp.gte': 'minstens',
    'automation_testing.cmp.lte': 'hoogstens',
    'automation_testing.type.array': 'een lijst',
    'automation_testing.type.boolean': 'waar of onwaar',
    'automation_testing.type.null': 'leeg',
    'automation_testing.type.number': 'een getal',
    'automation_testing.type.object': 'een object',
    'automation_testing.type.string': 'tekst',

    // ── A check read as a sentence, and the outcome of a run ───────────
    'automation_testing.sentence.contains': '{path} bevat {value}',
    'automation_testing.sentence.count_is': '{path} heeft {count}',
    'automation_testing.sentence.equals': '{path} is precies {value}',
    'automation_testing.sentence.has_key': '{path} heeft het veld {value}',
    'automation_testing.sentence.not_equals': '{path} is niet {value}',
    'automation_testing.count.eq': 'precies {n} items',
    'automation_testing.count.gte': 'minstens {n} items',
    'automation_testing.count.lte': 'hoogstens {n} items',
    'automation_testing.outcome.error': 'mislukt met een fout',
    'automation_testing.outcome.none': 'niet gedraaid',
    'automation_testing.outcome.success': 'geslaagd',
    'automation_testing.result.check_ok': 'Controle geslaagd',
    'automation_testing.result.expectation': 'Verwacht: {expected}. Resultaat: {got}.',

    // ── Why a check failed ─────────────────────────────────────────────
    'automation_testing.fail.equal': 'Verwacht dat {path} niet {expected} is, maar dat is het wel.',
    'automation_testing.fail.key_missing': 'Verwacht dat {path} het veld {expected} heeft, maar dat ontbreekt.',
    'automation_testing.fail.not_contained': 'Verwacht dat {path} {expected} bevat, maar kreeg {actual}.',
    'automation_testing.fail.not_countable': 'Kan de items van {path} niet tellen: het is {actual}.',
    'automation_testing.fail.not_equal': 'Verwacht dat {path} {expected} is, maar kreeg {actual}.',
    'automation_testing.fail.other': 'De controle op {path} klopte niet.',
    'automation_testing.fail.path_missing': 'Verwacht iets op {path}, maar daar staat niets.',
    'automation_testing.fail.wrong_count': 'Verwacht dat {path} {count} heeft, maar kreeg {actual}.',
    'automation_testing.fail.wrong_type': 'Verwacht dat {path} {expected} is, maar kreeg {actual}.',

    // ── Why a test could not run ───────────────────────────────────────
    'automation_testing.reason.code_blocked': 'Een controle houdt deze code tegen. Het tabblad Controles zegt welke.',
    'automation_testing.reason.code_param_invalid': 'Een waarde in deze test past niet bij wat de code vraagt: {message}',
    'automation_testing.reason.code_syntax_error': 'De code bevat een syntaxfout, dus er kon niets draaien. Het tabblad Controles laat zien waar.',
    'automation_testing.reason.fixture_expired': 'De run waar deze invoer vandaan kwam is verwijderd, dus de test kan niet draaien. Bewerk hem om waarden te typen of kies een andere run.',
    'automation_testing.reason.other': 'De test kon niet draaien.',
    'automation_testing.reason.sandbox_missing': 'De sandbox die code draait, is niet beschikbaar op deze server.',

    // ── Why a test could not be saved ──────────────────────────────────
    'automation_testing.error.caller_run_not_capturable': 'Die run gebruikte de koppelingen van de persoon die hem startte, dus de gegevens ervan kunnen niet als testgegevens worden bewaard.',
    'automation_testing.error.fixture_too_large': 'De invoer van deze stap in die run is te groot om als testgegevens te bewaren.',
    'automation_testing.error.fixture_truncated': 'De invoer van deze stap was te groot om in die run volledig te worden vastgelegd, dus hij kan niet worden gebruikt.',
    'automation_testing.error.run_not_finished': 'Die run is nog niet klaar. Kies een afgeronde run.',
    'automation_testing.error.run_not_found': 'Die run is niet gevonden.',
    'automation_testing.error.save': 'De test kon niet worden opgeslagen. Probeer het zo nog eens.',
    'automation_testing.error.step_not_in_run': 'Deze stap heeft in die run geen vastgelegde invoer. Kies een run waarin hij draaide.',
    'automation_testing.error.test_case_limit': 'Deze stap heeft het maximale aantal tests dat hij kan bewaren. Verwijder er eerst een.',
    'automation_testing.error.test_data_not_on_prd': 'Voor automatiseringen in productie worden geen testgegevens bewaard.',

    // ── Saving a run's input as a test case ────────────────────────────
    'automation_testing.save_as.action': 'Opslaan als testgeval',
    'automation_testing.save_as.close': 'Sluiten',
    'automation_testing.save_as.saved': 'Opgeslagen. Je vindt het in het tabblad Tests van de code-editor.',
    'automation_testing.save_as.title': 'Opslaan als testgeval',

    // ── Line changes in version compare ────────────────────────────────
    'automation_testing.diff.added': 'Toegevoegde regel',
    'automation_testing.diff.empty': 'Beide kanten zijn leeg.',
    'automation_testing.diff.hide': 'Regelwijzigingen verbergen',
    'automation_testing.diff.label': 'Regelwijzigingen',
    'automation_testing.diff.removed': 'Verwijderde regel',
    'automation_testing.diff.show': 'Regelwijzigingen tonen',
    'automation_testing.diff.show_unchanged': '{n} ongewijzigde regels tonen',
    'automation_testing.diff.summary': 'Regels toegevoegd: {added}. Regels verwijderd: {removed}.',
    'automation_testing.diff.truncated': 'Deze tekst is langer dan wat hier wordt vergeleken, dus het einde wordt niet getoond.',
});

/** Keys whose Dutch is the English text itself; deliberately not seeded. */
const SAME_AS_ENGLISH = Object.freeze([
    'automation_testing.tab', // "Tests"
    'automation_testing.run.test', // "test", the tag on a test run in the run picker
    'automation_testing.sentence.type_is', // "{path} is {type}"
    'automation_testing.value.type', // "Type"
]);

/**
 * The mutation itself, on a copy of the 'nl' blob. Pure, so the store's mutator may run it more than once.
 * @param {Record<string, string>} merged
 */
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
    await languageStore.mutateGUITranslations('nl', (/** @type {Record<string, string>} */ current) => {
        const result = applyNl(current);
        added = result.added;
        return result.merged;
    });
    if (added > 0) {
        console.log(`[Migration] add-nl-automation-testing-cases-translations applied (+${added} keys)`);
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
