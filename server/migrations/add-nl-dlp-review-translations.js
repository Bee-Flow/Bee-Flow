#!/usr/bin/env node
/**
 * Dutch for the Privacy Shield review dialog (the "check before it goes to the
 * AI" screen and its manual-marking affordances).
 *
 * WHY THIS FILE EXISTS AT ALL: these nine strings were written straight into
 * the ENGLISH dictionaries in Dutch. That is invisible on a Dutch install —
 * t() returns the English catalogue entry, which happened to be Dutch, and the
 * screen looked right — and it shipped Dutch to every English user. The fix is
 * the normal split: English lives in i18n/defaults/en.js, Dutch lives here.
 *
 * WHY DUTCH FIRST, same reason as add-nl-studio-fundament-translations.js: this
 * dialog is a consent surface. It is the moment a person decides whether their
 * customer's name and address may leave Bee Flow, and "Check this before it
 * goes to the AI" in a second language is not an informed decision. It is also
 * the one screen where a person can add a marking the detector missed, so the
 * hint that tells them they may has to read naturally.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated its
 * own wording keeps it. ADD, NEVER RENAME — a renamed key is a screen that
 * silently falls back to English. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-dlp-review-translations.js
 */

const NL_TRANSLATIONS = {
    // ── Kop van het reviewvenster ───────────────────────────────────────────
    'dlp.review_title': 'Controleer voordat dit naar de AI gaat',
    'dlp.review_title_attachment': 'Controleer deze bijlage voordat die naar de AI gaat',

    // ── Zelf markeren wat de detector miste ─────────────────────────────────
    'dlp.select_text_hint': 'Tip: selecteer tekst hierboven om zelf iets te markeren dat de detector miste.',
    'dlp.mark_as_pii': 'Markeer als persoonsgegevens',
    'dlp.unmark': 'Ongedaan maken',

    // ── Samenvatting van de bevindingen ─────────────────────────────────────
    'dlp.summary_none_found': 'Geen persoonsgegevens gedetecteerd. Zie je toch iets? Selecteer het hieronder.',
    'dlp.summary_with_manual': '{auto} gedetecteerd · {manual} door jou toegevoegd',
    'dlp.summary_auto_only': '{count} gedetecteerd',

    // ── De knop als er niets te verbergen valt ──────────────────────────────
    'dlp.action_confirm_send': 'Verzenden',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-dlp-review-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-dlp-review-translations failed:', e.message);
        process.exit(1);
    });
}
