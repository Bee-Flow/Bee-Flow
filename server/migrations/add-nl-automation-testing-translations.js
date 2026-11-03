#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for testing an automation in the builder (automation_testing.*,
 * 2026-11): the dry run and the live test in the header, the run phases, the
 * toasts when a run finishes or waits, the confirmations before real actions,
 * and the overlay that shows a test form or a waiting approval. Only those
 * prefixes (header., run_live., execute_confirm., run_phase., start., toast.,
 * overlay.); the code-step test cases elsewhere in the namespace are not here.
 * Also the run bar's automations.canvas.run_* keys of the same round, here
 * rather than in add-nl-builder-redesign-translations, which is at its line
 * ceiling.
 *
 * Terminology follows the builder's catalogues: a dry run is a "proefrun"
 * (nothing is sent), a test run a "testrun", a run stays "run", the working
 * copy is the "werkversie", an approver in the builder a "goedkeurder", and
 * Approvals / Runs are the section names ("Goedkeuringen", "Runs"). The
 * reader is "je".
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-automation-testing-translations.js
 */

const NL_TRANSLATIONS = Object.freeze({
    // ── Header: the two ways to try the working copy ───────────────────
    'automation_testing.header.dry_run': 'Proefrun (niets verstuurd)',
    'automation_testing.header.dry_run_from_title': 'Proefrun vanaf "{label}": er wordt niets verstuurd',
    'automation_testing.header.dry_run_hint': 'Schrijven wordt nagebootst; formulieren en goedkeuringen wachten op jou',
    'automation_testing.header.dry_run_title': 'Proefrun van de werkversie: er wordt niets verstuurd',
    'automation_testing.header.run_blocked': 'Er loopt al een run. Wacht erop, of stop hem eerst.',
    'automation_testing.header.run_live': 'Echt draaien (test, echte acties)',
    'automation_testing.header.run_live_hint': 'Elke stap voert echt uit; goedkeuringen gaan naar jou',

    // ── Confirmations before real actions ──────────────────────────────
    'automation_testing.run_live.confirm': 'Uitvoeren',
    'automation_testing.run_live.confirm_description': 'Elke stap voert zijn actie uit: berichten versturen, gegevens schrijven en alles wat de flow verder doet. Goedkeuringen erin gaan alleen naar jou.',
    'automation_testing.run_live.confirm_title': 'Deze automatisering echt uitvoeren?',
    'automation_testing.execute_confirm.confirm': 'Uitvoeren',
    'automation_testing.execute_confirm.description': 'Geen eerdere run heeft de uitvoer van {steps}, dus die draaien eerst, en ze versturen of schrijven iets buiten Bee Flow. Echt uitvoeren?',
    'automation_testing.execute_confirm.title': 'De eerdere stappen echt uitvoeren?',

    // ── Run phases ─────────────────────────────────────────────────────
    'automation_testing.run_phase.cancelled': 'Gestopt',
    'automation_testing.run_phase.done': 'Klaar',
    'automation_testing.run_phase.failed': 'Mislukt',
    'automation_testing.run_phase.paused_approval': 'Wacht op een beslissing',
    'automation_testing.run_phase.paused_form': 'Wacht op een formulier',
    'automation_testing.run_phase.running': 'Draait',

    // ── Why a run did not start ────────────────────────────────────────
    'automation_testing.start.another_run': 'Er loopt nog een andere run. Wacht erop, of stop hem eerst.',
    'automation_testing.start.form_needs_question': 'Voeg eerst minstens één vraag toe aan dit formulier.',
    'automation_testing.start.needs_steps': 'Voeg eerst een trigger en minstens één stap toe.',
    'automation_testing.start.no_run': 'De run is niet gestart.',
    'automation_testing.start.nothing_to_run': 'Nog niets om mee te draaien.',

    // ── Toasts ─────────────────────────────────────────────────────────
    'automation_testing.toast.done': 'Run voltooid. Open een stap om de uitvoer te zien.',
    'automation_testing.toast.done_dry': 'Proefrun voltooid. Open een stap om de uitvoer te zien.',
    'automation_testing.toast.done_test': 'Testrun voltooid. Open een stap om de uitvoer te zien.',
    'automation_testing.toast.waiting_decision': 'Wacht op een beslissing bij "{step}"',
    'automation_testing.toast.waiting_form': 'Wacht op het formulier bij "{step}"',

    // ── The run bar on the canvas: a run that waits for a form page or a
    // decision, or a test that started on an older version. The rest of
    // automations.canvas.* is add-nl-builder-redesign's; its test skips these.
    'automations.canvas.run_waiting_form_title': 'Wacht op het formulier',
    'automations.canvas.run_waiting_decision': 'Wacht op je beslissing',
    'automations.canvas.run_waiting_decision_test': 'Wacht op je beslissing (test)',
    'automations.canvas.run_waiting_decision_any': 'Wacht op een beslissing',
    'automations.canvas.run_visitor_on_page': 'Een bezoeker is bij “{page}”',
    'automations.canvas.run_review_decide': 'Bekijken en beslissen',
    'automations.canvas.run_stop_test': 'Deze test stoppen',
    'automations.canvas.run_discard': 'Weggooien',
    'automations.canvas.run_version_behind': 'Deze test is op een oudere versie gestart',
    'automations.canvas.run_keep_version': 'Doorgaan op de oude versie',
    'automations.canvas.run_restart_current': 'Opnieuw starten met de huidige versie',

    // ── The overlay: a test form, a waiting approval, the end of a run ─
    'automation_testing.overlay.answer_this_page': 'Deze pagina beantwoorden',
    'automation_testing.overlay.answers_text': 'Het testformulier sluiten en kwijtraken wat je op deze pagina hebt getypt?',
    'automation_testing.overlay.answers_title': 'Je antwoorden weggooien?',
    'automation_testing.overlay.approval_elsewhere': 'De run wacht op een beslissing. Beslis op het canvas of onder Goedkeuringen.',
    'automation_testing.overlay.check_again': 'Opnieuw controleren',
    'automation_testing.overlay.chip_dry': 'Proefrun',
    'automation_testing.overlay.chip_live': 'Echte test',
    'automation_testing.overlay.close': 'Sluiten',
    'automation_testing.overlay.decide': 'Beslissen',
    'automation_testing.overlay.decide_failed': 'De beslissing kon niet worden verstuurd.',
    'automation_testing.overlay.discard_answers': 'Weggooien',
    'automation_testing.overlay.discard_failed': 'De testrun kon niet worden weggegooid.',
    'automation_testing.overlay.discard_run': 'Deze testrun weggooien',
    'automation_testing.overlay.dry_run_instead': 'Liever een proefrun',
    'automation_testing.overlay.failed_text': 'De run stopte op een fout. Het canvas toont welke stap en waarom.',
    'automation_testing.overlay.first_page_hint_dry': 'Wat je verstuurt, start een proefrun met deze antwoorden als trigger: er wordt niets verstuurd of geschreven, en formulieren en goedkeuringen wachten hier op jou.',
    'automation_testing.overlay.keep_editing': 'Terug',
    'automation_testing.overlay.keep_waiting': 'Laten wachten',
    'automation_testing.overlay.later_page_file': 'Een bestandsvraag op een latere pagina kun je proberen via de testlink van het formulier.',
    'automation_testing.overlay.nothing_started': 'Er is niets gestart.',
    'automation_testing.overlay.parked_text': 'De testrun wacht hier tot iemand antwoordt. Laten wachten, of weggooien?',
    'automation_testing.overlay.parked_title': 'Deze testrun wacht',
    'automation_testing.overlay.run_for_real': 'Echt uitvoeren',
    'automation_testing.overlay.runs_approval_hint': 'Deze run wacht op een beslissing.',
    'automation_testing.overlay.runs_form_hint': 'Deze run wacht tot iemand een pagina invult.',
    'automation_testing.overlay.save_partial': 'De run is niet afgerond, dus alleen de pagina’s die je hebt beantwoord blijven bewaard.',
    'automation_testing.overlay.slow_budget': 'Dit duurt even. Volg het op het canvas of onder Runs.',
    'automation_testing.overlay.slow_title': 'Nog bezig',
    'automation_testing.overlay.slow_unreadable': 'Dit venster kan de run niet meer lezen. Volg hem op het canvas of onder Runs.',
    'automation_testing.overlay.stopped_text': 'De run is gestopt voordat hij klaar was.',
    'automation_testing.overlay.waiting_for_approver': 'Wacht op de goedkeurder',
    'automation_testing.overlay.waiting_for_people': 'Wacht op {count} goedkeurders',
    'automation_testing.overlay.waiting_for_stage': 'Wacht op {stage} ({count})',
    'automation_testing.overlay.withdraw': 'Intrekken',
    'automation_testing.overlay.withdraw_failed': 'De goedkeuring kon niet worden ingetrokken.',
});

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
        console.log(`[Migration] add-nl-automation-testing-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, applyNl, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
