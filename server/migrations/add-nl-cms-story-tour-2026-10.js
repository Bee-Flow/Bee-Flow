#!/usr/bin/env node
/**
 * Dutch for the website CMS scroll story and product tour blocks and the A/B test card (2026-10). The card sits
 * under every block editor.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated its
 * own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-cms-story-tour-2026-10.js
 */

const NL_TRANSLATIONS = {
    "cms_site.blocks.story_media.image": "Schermafbeelding",
    "cms_site.blocks.story_media.upload": "Afbeelding uploaden",
    "cms_site.blocks.story_media.alt": "Alt-tekst",
    "cms_site.blocks.story_media.alt_placeholder": "Beschrijf wat de schermafbeelding laat zien",
    "cms_site.blocks.scroll_story.hint": "De stappen lopen door de pagina; de afbeelding ernaast wisselt mee met de stap in beeld. Op telefoons en bij beperkte beweging staat elke afbeelding onder zijn stap.",
    "cms_site.blocks.scroll_story.steps": "Stappen",
    "cms_site.blocks.scroll_story.no_title": "(geen titel)",
    "cms_site.blocks.scroll_story.step_title": "Titel",
    "cms_site.blocks.scroll_story.step_body": "Tekst",
    "cms_site.blocks.scroll_story.add_step": "Stap toevoegen",
    "cms_site.blocks.tour.hint": "Eén schermafbeelding per stap. Hotspots zijn genummerde stippen op de afbeelding; een bezoeker klikt erop om de uitleg te lezen. De positie is een percentage van de afbeelding, van 0 tot 100.",
    "cms_site.blocks.tour.steps": "Stappen",
    "cms_site.blocks.tour.no_title": "(geen titel)",
    "cms_site.blocks.tour.step_title": "Titel",
    "cms_site.blocks.tour.step_body": "Tekst",
    "cms_site.blocks.tour.hotspots": "Hotspotpunten",
    "cms_site.blocks.tour.hotspot_n": "Punt {n}",
    "cms_site.blocks.tour.hotspot_label": "Kop",
    "cms_site.blocks.tour.hotspot_body": "Uitleg",
    "cms_site.blocks.tour.hotspot_x": "Links (%)",
    "cms_site.blocks.tour.hotspot_y": "Boven (%)",
    "cms_site.blocks.tour.add_hotspot": "Hotspot toevoegen",
    "cms_site.blocks.tour.default_previous": "Vorige stap",
    "cms_site.blocks.tour.default_next": "Volgende stap",
    "cms_site.blocks.tour.default_step_of": "Stap {n} van {total}",
    "cms_site.blocks.tour.add_step": "Stap toevoegen",
    "cms_site.blocks.tour.label_previous": "Knop Vorige",
    "cms_site.blocks.tour.label_next": "Knop Volgende",
    "cms_site.blocks.tour.label_step_of": "Stapteller",
    "cms_site.blocks.experiment.title": "A/B-test",
    "cms_site.blocks.experiment.hint": "Laat een deel van de paginaweergaven een alternatieve versie van dit blok zien en vergelijk hoe vaak bezoekers doorklikken. Er wordt niets in de browser van de bezoeker bewaard, geen cookies en geen identificatie; de resultaten tellen paginaweergaven, geen personen.",
    "cms_site.blocks.experiment.enable": "Een alternatief voor dit blok testen",
    "cms_site.blocks.experiment.name": "Naam van de test",
    "cms_site.blocks.experiment.name_hint": "Staat in het analyticsrapport. Letters, cijfers, - en _.",
    "cms_site.blocks.experiment.share": "Aandeel dat het alternatief ziet (%)",
    "cms_site.blocks.experiment.goal": "Naam van de doelgebeurtenis",
    "cms_site.blocks.experiment.goal_hint": "Telt mee wanneer een bezoeker in dit blok op een knop of link klikt, of er een formulier verstuurt.",
    "cms_site.blocks.experiment.original": "Origineel",
    "cms_site.blocks.experiment.alternative": "Alternatief",
    "cms_site.blocks.experiment.alt_hint": "Pas aan wat anders moet zijn. Velden die je laat staan volgen het origineel.",
};

async function up() {
    const languageStore = require('../stores/languageStore');
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-cms-story-tour-2026-10: added ${added} NL keys`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(({ added }) => {
        console.log(`Done (${added} added).`);
        process.exit(0);
    }).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
