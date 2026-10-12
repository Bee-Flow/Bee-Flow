#!/usr/bin/env node
/**
 * Dutch for the App Studio AI builder FILM (2026-09-13): the typed activity
 * rows in the chat column, the canvas build banner, the ghost cell of the
 * component being typed, the chat column's own chrome and its error copy.
 *
 * The routine builder got the same surfaces a few days earlier
 * (add-nl-builder-redesign-translations); this catalogue mirrors its wording
 * where the two say the same thing, so a presenter switching between the two
 * builders reads one vocabulary ("Bezig met bouwen", "Gestopt — concept
 * bewaard", "Volg het bouwen"). The activity verbs are past tense, as the
 * English is: what the AI DID, in the product's words, never the tool's name.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-app-studio-builder-translations.js
 */

const NL_TRANSLATIONS = {
    // ── Activiteitsrijen: wat de AI deed ─────────────────────────────────────
    'app_studio.builder.act.add_component_one': '1 component toegevoegd',
    'app_studio.builder.act.add_components': '{n} componenten toegevoegd',
    'app_studio.builder.act.add_components_some': 'Componenten toegevoegd',
    'app_studio.builder.act.add_screen': 'Scherm toegevoegd',
    'app_studio.builder.act.building': 'Bezig met bouwen',
    'app_studio.builder.act.built': 'Gebouwd',
    'app_studio.builder.act.add_section': 'Sectie toegevoegd',
    'app_studio.builder.act.apply_template': 'Sjabloon toegepast',
    'app_studio.builder.act.bind_action': 'Knop gekoppeld',
    'app_studio.builder.act.dry_run': 'Gegevens gecontroleerd',
    'app_studio.builder.act.finalize': 'App gecontroleerd en opgeslagen',
    'app_studio.builder.act.find_nodes': 'In de app gezocht',
    'app_studio.builder.act.get_data_model': 'Datamodel gelezen',
    'app_studio.builder.act.get_draft': 'App opnieuw gelezen',
    'app_studio.builder.act.inspect_automation': 'Automatisering bekeken',
    'app_studio.builder.act.kind_action': 'Actie',
    'app_studio.builder.act.kind_screen': 'Scherm',
    'app_studio.builder.act.kind_table': 'Tabel',
    'app_studio.builder.act.link_datatable': 'Tabel gekoppeld',
    'app_studio.builder.act.list_automations': 'Automatiseringen opgezocht',
    'app_studio.builder.act.list_connectors': 'Connectors opgesomd',
    'app_studio.builder.act.list_templates': 'Sjablonen opgesomd',
    'app_studio.builder.act.mark_phase': 'Fase gestart',
    'app_studio.builder.act.move_node': 'Indeling herschikt',
    'app_studio.builder.act.propose_plan': 'Plan voorgesteld',
    'app_studio.builder.act.query_data': 'Gegevens bekeken',
    'app_studio.builder.act.refused': 'Niet toegepast',
    'app_studio.builder.act.remove_action': 'Actie verwijderd',
    'app_studio.builder.act.remove_node': 'Component verwijderd',
    'app_studio.builder.act.remove_screen': 'Scherm verwijderd',
    'app_studio.builder.act.remove_table': 'Tabel verwijderd',
    'app_studio.builder.act.save_as_template': 'Als sjabloon opgeslagen',
    'app_studio.builder.act.screenshot': 'Schermafbeelding gemaakt',
    'app_studio.builder.act.seed_records': 'Voorbeeldrijen toegevoegd',
    'app_studio.builder.act.set_action': 'Actie ingesteld',
    'app_studio.builder.act.set_meta': 'App benoemd',
    'app_studio.builder.act.set_nav_groups': 'Menu hergroepeerd',
    'app_studio.builder.act.set_plan': 'Plan bijgewerkt',
    'app_studio.builder.act.set_public_access': 'Publieke toegang ingesteld',
    'app_studio.builder.act.set_roles': 'Rollen ingericht',
    'app_studio.builder.act.set_theme': 'Uiterlijk gekozen',
    'app_studio.builder.act.set_variables': 'Variabelen aangemaakt',
    'app_studio.builder.act.tool': 'Toolaanroep',
    'app_studio.builder.act.update_component': 'Component aangepast',
    'app_studio.builder.act.update_screen': 'Scherm aangepast',
    'app_studio.builder.act.update_section': 'Sectie opnieuw vormgegeven',
    'app_studio.builder.act.upsert_dataset': 'Dataset aangemaakt',
    'app_studio.builder.act.upsert_table': 'Tabel aangemaakt',
    // ── De bouwbanner op het canvas ──────────────────────────────────────────
    'app_studio.builder.banner.build_done': 'Gebouwd · {n} componenten · {s} schermen · {t}',
    'app_studio.builder.banner.build_live': 'Bezig met bouwen',
    'app_studio.builder.banner.build_saved': 'Bewaard · {n} componenten',
    'app_studio.builder.banner.build_skipped': 'Overgeslagen: {reason}',
    'app_studio.builder.banner.build_stopped': 'Gestopt — concept bewaard',
    'app_studio.builder.banner.checking': 'App controleren…',
    'app_studio.builder.banner.follow': 'Volg het bouwen',
    'app_studio.builder.banner.on_screen': 'op {screen}',
    'app_studio.builder.act.calls': '{n} aanroepen',
    'app_studio.builder.act.refused_count': '{n} geweigerd',
    'app_studio.builder.act.refused_title': 'Aanroepen die de bouwer weigerde — elke regel zegt waarom',
    'app_studio.builder.quick.use_data': 'Mijn data gebruiken',
    'app_studio.builder.quick.use_data_title': 'Koppel het geselecteerde component aan data uit een van de tabellen van deze app',
    'app_studio.builder.quick.new_screen': 'Nieuw scherm',
    'app_studio.builder.quick.new_screen_title': 'Ontwerp en voeg een nieuw scherm toe dat past bij wat deze app al doet',
    'app_studio.builder.quick.fix_errors': 'Fouten herstellen',
    'app_studio.builder.quick.fix_errors_title': 'Vraag de AI de huidige problemen te herstellen',
    'app_studio.builder.quick.fix_errors_none': 'Geen problemen om te herstellen',
    'app_studio.builder.validation.fixing': 'De AI herstelt {n} problemen…',
    'app_studio.builder.validation.fixing_one': 'De AI herstelt 1 probleem…',
    'app_studio.builder.validation.to_review': '{n} problemen om na te kijken',
    'app_studio.builder.validation.to_review_one': '1 probleem om na te kijken',
    'app_studio.builder.validation.times': '{n} plekken',
    'app_studio.builder.validation.fix': 'Herstel',
    'app_studio.builder.validation.technical_detail': 'Technische details',
    'app_studio.builder.validation.more': '+{n} meer',
    'app_studio.builder.banner.phase': 'Fase {i}/{n}',
    // ── De ghost-cel ─────────────────────────────────────────────────────────
    'app_studio.builder.draft.component_of': 'Component {i} van {n}',
    'app_studio.builder.draft.typing': '{type} toevoegen…',
    // ── De chatkolom ─────────────────────────────────────────────────────────
    'app_studio.builder.chat.attach': 'Afbeelding toevoegen',
    'app_studio.builder.chat.attach_limit': 'Je kunt maximaal {n} afbeeldingen toevoegen',
    'app_studio.builder.chat.attach_title': 'Afbeelding toevoegen (of plak een schermafbeelding)',
    'app_studio.builder.chat.composer_aria': 'Bericht aan de AI-bouwer',
    'app_studio.builder.chat.continuing': 'Gaat verder{phase}…',
    'app_studio.builder.chat.empty_hint': 'Beschrijf de app die je wilt — ik bouw hem op het canvas',
    'app_studio.builder.chat.empty_title': 'Bouwen met AI',
    'app_studio.builder.chat.err_budget_exhausted': 'Ik heb geen bouwbeurten meer voor deze vraag, maar je voortgang is bewaard. Stuur nog een bericht en ik ga verder.',
    'app_studio.builder.chat.err_generic': 'De AI-bouwer liep tegen een probleem aan.',
    'app_studio.builder.chat.err_internal': 'De AI-bouwer liep tegen een onverwacht probleem aan. Je voortgang is bewaard.',
    'app_studio.builder.chat.err_model_rejected': 'Het AI-model heeft de aanvraag geweigerd. Je voortgang is bewaard — controleer de model- of tierinstellingen voordat je het opnieuw probeert.',
    'app_studio.builder.chat.err_model_truncated': 'Het model kwam al redenerend niet meer aan bouwen toe. Kies een tier zonder denken, of maak de opdracht korter.',
    'app_studio.builder.chat.tier_pinned': 'De tier wordt door het playbook bepaald',
    'app_studio.builder.chat.err_model_empty_reply': 'Het model stopte twee keer zonder een tool aan te roepen of iets te zeggen — het schreef zijn volgende stap als tekst in plaats van als aanroep. Je concept is bewaard; stuur het bericht opnieuw, of kies een andere tier.',
    'app_studio.builder.chat.err_model_unavailable': 'Het AI-model is op dit moment niet beschikbaar. Probeer het zo opnieuw, of kies een andere modeltier.',
    'app_studio.builder.chat.err_rate_limited': 'Je stuurt bouwopdrachten te snel achter elkaar. Wacht even en probeer het dan opnieuw.',
    'app_studio.builder.chat.err_save_conflict': 'De app is in een andere tab gewijzigd terwijl de AI aan het bouwen was. Open hem opnieuw en probeer het nog eens.',
    'app_studio.builder.chat.err_subscription_limit': 'Je hebt de AI-limiet van je abonnement bereikt. Upgrade je abonnement om verder te bouwen met AI.',
    'app_studio.builder.chat.err_transient_upstream': 'De AI-aanbieder had een korte storing. Je voortgang is bewaard — probeer het zo opnieuw.',
    'app_studio.builder.chat.err_validation_failed': 'De app had validatiefouten die de AI niet kon oplossen. Bekijk de punten hieronder en probeer het opnieuw.',
    'app_studio.builder.chat.phase_line': 'Bouwen — fase {i}{total}{label}',
    'app_studio.builder.chat.placeholder': 'Beschrijf een wijziging, of plak een schermafbeelding…',
    'app_studio.builder.chat.placeholder_busy': 'De AI is aan het bouwen…',
    'app_studio.builder.chat.send': 'Versturen',
    'app_studio.builder.chat.send_title': 'Versturen (Enter)',
    'app_studio.builder.chat.stop_title': 'Stoppen met bouwen',
    'app_studio.builder.chat.title': 'AI-bouwer',
    'app_studio.builder.chat.try_again': 'Opnieuw proberen',
};

/**
 * Keys whose Dutch IS the English: seeding them would pin a value nobody can
 * tell apart from an untranslated one.
 */
const SAME_AS_ENGLISH = [
    'app_studio.builder.banner.plan_progress', // "Plan 3/7" — a word and two numbers
    'app_studio.builder.draft.component',      // "Component"
    'app_studio.builder.chat.stop',            // "Stop"
];

async function up() {
    const languageStore = require('../stores/languageStore');
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-app-studio-builder-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS, SAME_AS_ENGLISH };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-app-studio-builder-translations failed:', e.message);
        process.exit(1);
    });
}
