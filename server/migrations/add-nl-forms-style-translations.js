#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for the look of a hosted form (forms.style.*): the grouped design
 * controls in the form editor (Uiterlijk, Indeling, Velden, Knop, Huisstijl,
 * Geavanceerd), the custom-CSS field with its cheat sheet and warnings, and
 * "Beschrijf het uiterlijk", which asks the AI for CSS.
 *
 * Terminology follows add-nl-forms-answers-translations (which lists these
 * keys for its catalogue test): a form is a "formulier", a question a "vraag";
 * "dit account", never "jij".
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-forms-style-translations.js
 */

const NL_TRANSLATIONS = {
    'forms.style.heading': 'Vormgeving',
    'forms.style.group_look': 'Uiterlijk',
    'forms.style.group_layout': 'Indeling',
    'forms.style.group_fields': 'Velden',
    'forms.style.group_button': 'Knop',
    'forms.style.group_brand': 'Huisstijl',
    'forms.style.group_advanced': 'Geavanceerd',
    'forms.style.default': 'Standaard',
    'forms.style.presets': 'Voorinstellingen',
    'forms.style.preset_clean': 'Strak',
    'forms.style.preset_corporate': 'Zakelijk',
    'forms.style.preset_friendly': 'Vriendelijk',
    'forms.style.preset_night': 'Nacht',
    'forms.style.preset_system': 'Zoals de bezoeker',
    'forms.style.primary': 'Hoofdkleur',
    'forms.style.primary_custom': 'Eigen hoofdkleur',
    'forms.style.accent': 'Knopkleur',
    'forms.style.canvas': 'Paginaachtergrond',
    'forms.style.card_color': 'Kaartkleur',
    'forms.style.text_color': 'Tekstkleur',
    'forms.style.reset_named': '{name} terugzetten',
    'forms.style.appearance': 'Weergave',
    'forms.style.appearance_light': 'Licht',
    'forms.style.appearance_dark': 'Donker',
    'forms.style.appearance_auto': 'Zoals de bezoeker',
    'forms.style.width': 'Breedte',
    'forms.style.width_narrow': 'Smal',
    'forms.style.width_medium': 'Middel',
    'forms.style.width_wide': 'Breed',
    'forms.style.align': 'Uitlijning titel',
    'forms.style.align_left': 'Links',
    'forms.style.align_center': 'Midden',
    'forms.style.radius': 'Hoeken',
    'forms.style.radius_none': 'Recht',
    'forms.style.radius_sm': 'Licht rond',
    'forms.style.radius_md': 'Middel',
    'forms.style.radius_lg': 'Rond',
    'forms.style.radius_xl': 'Extra rond',
    'forms.style.density': 'Ruimte',
    'forms.style.density_comfortable': 'Comfortabel',
    'forms.style.density_spacious': 'Ruim',
    'forms.style.text_size': 'Tekstgrootte',
    'forms.style.text_sm': 'Klein',
    'forms.style.text_md': 'Middel',
    'forms.style.text_lg': 'Groot',
    'forms.style.font': 'Lettertype',
    'forms.style.font_system': 'Systeem',
    'forms.style.font_serif': 'Schreef',
    'forms.style.font_rounded': 'Afgerond',
    'forms.style.label_above': 'Boven het veld',
    'forms.style.label_inside': 'In het veld',
    'forms.style.input_style': 'Invoerstijl',
    'forms.style.input_outlined': 'Omlijnd',
    'forms.style.input_filled': 'Gevuld',
    'forms.style.input_underlined': 'Onderstreept',
    'forms.style.label_color': 'Labelkleur',
    'forms.style.button_text': 'Knoptekst',
    'forms.style.button_width': 'Breedte',
    'forms.style.button_width_auto': 'Passend bij de tekst',
    'forms.style.button_width_full': 'Volle breedte',
    'forms.style.button_shape': 'Vorm',
    'forms.style.shape_square': 'Recht',
    'forms.style.shape_rounded': 'Afgerond',
    'forms.style.shape_pill': 'Pil',
    'forms.style.button_text_color': 'Tekstkleur van de knop',
    'forms.style.logo_hint': 'Een adres op deze server, beginnend met /. Afbeeldingen van andere sites worden niet geladen: die zouden die site vertellen wie het formulier opent.',
    'forms.style.logo_invalid': 'Gebruik een adres op deze server dat met één / begint. Dit adres wordt niet opgeslagen.',
    'forms.style.footer': 'Voettekst',
    'forms.style.footer_hint': 'Platte tekst onder het formulier, bijvoorbeeld de naam van de organisatie of een regel over privacy.',
    'forms.style.custom_css': 'Eigen CSS',
    'forms.style.custom_css_hint': 'Geldt alleen voor dit formulier. Gebruik de klassenamen hieronder.',
    'forms.style.removed_title': 'Weggelaten wanneer het formulier wordt getoond:',
    'forms.style.removed_outside_address': 'een adres op een andere site',
    'forms.style.removed_unbalanced': 'een accolade die niet klopt',
    'forms.style.removed_sibling': 'een selector die buiten het formulier reikt',
    'forms.style.removed_too_long': 'alles: de CSS is langer dan toegestaan',
    'forms.style.cheat_sheet': 'Klassenamen om op te maken',
    'forms.style.class_form': 'Het hele formulier (ook op het wacht- en het slotscherm)',
    'forms.style.class_card': 'De kaart waar alles op staat',
    'forms.style.class_logo': 'Het logo boven de titel',
    'forms.style.class_title': 'De titel',
    'forms.style.class_intro': 'De inleiding onder de titel',
    'forms.style.class_field': 'Eén vraag; [data-field="naam"] kiest er één uit',
    'forms.style.class_label': 'Het label van een vraag',
    'forms.style.class_hint': 'Hulptekst onder een vraag',
    'forms.style.class_input': 'Invoer voor tekst, e-mail, getal, datum, lange tekst en keuzelijst',
    'forms.style.class_choice': 'Een keuzevraag (knoppen, meerdere keuzes, een vinkje)',
    'forms.style.class_choice_option': 'Eén optie van een keuzevraag',
    'forms.style.class_file': 'Een bestandsupload',
    'forms.style.class_pick': 'Een vraag "kies uit een app"',
    'forms.style.class_error': 'Een foutmelding',
    'forms.style.class_actions': 'De rij met de knop',
    'forms.style.class_submit': 'De verzendknop',
    'forms.style.class_footer': 'De voettekst',
    'forms.style.class_progress': 'De voortgangsbalk terwijl de automatisering werkt',
    'forms.style.class_waiting': 'De kaart terwijl de automatisering werkt',
    'forms.style.class_ending': 'De kaart van de slotpagina',
    'forms.style.describe': 'Beschrijf het uiterlijk',
    'forms.style.describe_placeholder': 'Bijvoorbeeld: warm als een bakkerij, grotere invoervelden, een donkere glazen kaart',
    'forms.style.ask_ai': 'Vraag het AI',
    'forms.style.asking': 'Bezig met vragen…',
    'forms.style.undo': 'Ongedaan maken',
    'forms.style.ai_failed': 'De AI kon dit formulier niet opmaken. Probeer het opnieuw.',
    'forms.style.ai_unavailable': 'Sla de automatisering eerst op om de AI om een uiterlijk te vragen.',
    'forms.style.ai_applied': 'De CSS staat in het veld hieronder en in de voorbeeldweergave.',
    'forms.style.ai_removed': 'Uit het antwoord van de AI gehaald:',
};

/** Keys whose Dutch IS the English string: a placeholder pattern, a brand name, and words Dutch borrows as they are. */
const SAME_AS_ENGLISH = [
    'forms.style.swatch',
    'forms.style.density_compact',
    'forms.style.font_inter',
    'forms.style.font_mono',
    'forms.style.label_style',
    'forms.style.logo',
    'forms.style.css_count',
];

async function up() {
    const languageStore = require('../stores/languageStore');
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-forms-style-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS, SAME_AS_ENGLISH };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
