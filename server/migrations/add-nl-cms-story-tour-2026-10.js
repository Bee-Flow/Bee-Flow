#!/usr/bin/env node
/**
 * Dutch for the website CMS scroll story and product tour blocks (2026-10).
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
    "cms_site.blocks.tour.add_step": "Stap toevoegen",
    "cms_site.blocks.tour.label_previous": "Knop Vorige",
    "cms_site.blocks.tour.label_next": "Knop Volgende",
    "cms_site.blocks.tour.label_step_of": "Stapteller",
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
