#!/usr/bin/env node
/**
 * One-time migration: Add Dutch translations for the large-upload PII scan
 * surfacing (page-cap overflow / scan timeout / degraded → passed unredacted
 * or held). Keeps the fail_open pass-through VISIBLE, never silent.
 *
 * Auto-runs from server boot (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-privacy-largescan-translations.js
 *
 * Merges into the existing i18n_gui_nl config without overwriting any
 * translations that already exist.
 */

const NL_TRANSLATIONS = {
    // ── Grote-upload scan-surfacing (geen stille onge-redigeerde lekken) ──
    'dlp.badge_scan_incomplete': 'Scan onvolledig',
    'dlp.badge_scan_incomplete_tooltip': 'Een deel van de geüploade inhoud kon niet worden gescand en is onge-redigeerd naar de AI gestuurd.',
    'dlp.attachment_scanned_partial': '{scanned} van {total} pagina’s gescand',
    'dlp.attachment_overflow_passed': 'te groot om volledig te scannen; de rest is onge-redigeerd verzonden',
    'dlp.attachment_timeout_passed': 'scan verlopen; de rest is onge-redigeerd verzonden',
    'dlp.attachment_degraded_passed': 'scannen niet beschikbaar; onge-redigeerd verzonden',
    'dlp.blocked_attachment_overflow': 'Bijlage vastgehouden: {filename} is te groot om volledig op gevoelige gegevens te scannen. Splits het bestand of verminder het aantal pagina’s en upload opnieuw.',
    'dlp.blocked_attachment_timeout': 'Bijlage vastgehouden: het scannen van {filename} op gevoelige gegevens is niet op tijd afgerond. Probeer het opnieuw of splits het document.',
    'dlp.blocked_attachment_degraded': 'Bijlage vastgehouden: het scannen van {filename} op gevoelige gegevens is tijdelijk niet beschikbaar. Probeer het zo dadelijk opnieuw.',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-privacy-largescan-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-privacy-largescan-translations failed:', e.message);
        process.exit(1);
    });
}
