#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for the automation builder's assistant column in plain words
 * (handover.*, 2026-11): the card after the assistant saved an automation
 * (ready, saved, not switched on yet, and what to do next), the preview of a
 * change, the activity rows, and the vocabulary table that names the
 * builder's own terms (agent-hub Builder/chat/plainVocabulary.ts).
 *
 * Terminology follows the builder's catalogues: the person's word for a dry
 * run is the same as the test run elsewhere, Activate reads as switching it
 * on (the header's word), the trigger is how it starts, and Settings →
 * Connections uses the Dutch menu name. The reader is addressed informally.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-handover-translations.js
 */

const NL_TRANSLATIONS = Object.freeze({
    // ── Activity rows ──────────────────────────────────────────────────
    'handover.act.dry_run': 'Een testrun gedaan',
    'handover.act.finalize': 'Opgeslagen, nog niet aangezet',
    'handover.act.read_mapping': 'Nagekeken welke gegevens elke stap gebruikt',
    'handover.act.trigger': 'Ingesteld hoe het begint',

    // ── The card after a save: what to do next ────────────────────────
    'handover.card.activate': 'Aanzetten',
    'handover.card.activate_hint': 'Tot dan gebeurt er niets vanzelf.',
    'handover.card.activate_text': 'Zet het aan',
    'handover.card.active': 'Aangezet',
    'handover.card.active_hint': 'Vanaf nu draait het vanzelf.',
    'handover.card.aria': 'Wat je nu kunt doen',
    'handover.card.connect': '{app} koppelen',
    'handover.card.connect_hint': 'Het gebruikt deze app, en die is voor jou nog niet gekoppeld. Koppel hem onder Instellingen → Koppelingen.',
    'handover.card.connect_open': 'Koppelingen openen',
    'handover.card.connect_unnamed': 'De app koppelen die het gebruikt',
    'handover.card.share': 'Formulierlink kopiëren',
    'handover.card.share_copied': 'Link gekopieerd',
    'handover.card.share_failed': 'De link kon niet worden gekopieerd.',
    'handover.card.share_hint_live': 'Collega\'s openen het met deze link nadat ze zijn ingelogd.',
    'handover.card.share_hint_off': 'De link gaat voor anderen open zodra het is aangezet.',
    'handover.card.share_no_link': 'Het formulier heeft nog geen link.',
    'handover.card.share_settings': 'Wie het mag openen',
    'handover.card.share_tab': 'Open het tabblad Delen van het formulier',
    'handover.card.share_text': 'Deel de formulierlink',
    'handover.card.test': 'Testrun starten',
    'handover.card.test_hint': 'Er wordt niets verstuurd of geschreven; formulieren en goedkeuringen wachten op jou.',
    'handover.card.test_text': 'Probeer het eerst',
    'handover.card.title_live': 'Klaar en aangezet. Zo gebruik je het:',
    'handover.card.title_ready': 'Klaar: opgeslagen, nog niet aangezet. Zo gebruik je het:',

    // ── The preview of a change ────────────────────────────────────────
    'handover.proposal.apply': 'Voer de wijziging door',
    'handover.proposal.apply_hint': 'Ja zeggen in de chat voert deze wijziging niet door. Druk op Voer de wijziging door om hem toe te passen, of op Verwerpen om hem te laten vallen. De assistent hoort welke van de twee je koos.',
    'handover.proposal.step_id': 'Stap-id',
    'handover.proposal.title': 'Voorbeeld van de wijziging',

    // ── The vocabulary table ───────────────────────────────────────────
    'handover.vocab.a_step': 'een eerdere stap',
    'handover.vocab.apply': 'de wijziging doorvoeren',
    'handover.vocab.dry_run': 'testrun',
    'handover.vocab.each_item': 'elk item',
    'handover.vocab.each_named': 'elke {item}',
    'handover.vocab.field_from': '{field} uit {source}',
    'handover.vocab.finalize': 'opgeslagen, nog niet aangezet',
    'handover.vocab.formula': 'berekend: {text}',
    'handover.vocab.proposal': 'voorbeeld',
    'handover.vocab.trigger': 'hoe het begint',
    'handover.vocab.trigger_title': 'Hoe het begint',
    'handover.vocab.uses_all_from': 'gebruikt wat {source} opleverde',
    'handover.vocab.uses_from': 'gebruikt {field} uit {source}',
});

/** Dutch that is the same word as the English, on purpose. */
const SAME_AS_ENGLISH = Object.freeze(['handover.proposal.details']);

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
        console.log(`[Migration] add-nl-handover-translations applied (+${added} keys)`);
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
