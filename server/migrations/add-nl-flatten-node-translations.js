#!/usr/bin/env node
/**
 * Migration: Dutch translations for "Flatten a list" (flatten_node.*, and the
 * five automations.node.flatten.* node keys): the step card, the Simple
 * editor's sentences, Choose fields, More options, the run sentences, the
 * palette hint and the validator chips.
 *
 * "Flatten a list" is "Lijst plat maken". The data nouns ({parents},
 * {children}, {child}, {parent}) are the data's own keys and stay as
 * they are.
 *
 * Idempotent: only inserts keys that do not have a NL value yet. Runs at boot
 * from boot/bootMigrations.js (NL_TRANSLATIONS).
 *
 * Manual usage:
 *   node server/migrations/add-nl-flatten-node-translations.js
 */

const NL_TRANSLATIONS = {
    'automations.node.flatten.typeLabel': 'Lijst plat maken',
    'automations.node.flatten.defaultLabel': 'Lijst plat maken',
    'automations.node.flatten.label': 'Lijst plat maken',
    'automations.node.flatten.desc': 'Eén rij voor elk item van een lijst in een lijst, zoals één rij per bijlage met de gegevens van de e-mail erbij.',
    'automations.node.flatten.help': 'Maakt van een lijst in een lijst één tabel. Elke rij is één binnenste item, zoals een bijlage, met de gegevens van het item waar het uit komt, zoals de e-mail.',
    'flatten_node.card.title': 'Eén rij per {child}',
    'flatten_node.card.from': 'Uit {source}',
    'flatten_node.card.pick': 'Kies een lijst',
    'flatten_node.editor.working_through': 'Werkt met',
    'flatten_node.editor.change': 'Wijzigen',
    'flatten_node.editor.row_per': 'Eén rij per',
    'flatten_node.editor.one_level': 'Eén rij per {child}',
    'flatten_node.editor.count_run': '{count} {children} in {outerCount} {parents} (laatste run)',
    'flatten_node.editor.count_shape': 'Elk(e) {parent} bevat een lijst met {children}.',
    'flatten_node.editor.option_count': '{count} in {outerCount} {parents}',
    'flatten_node.editor.no_inner': 'De {parents} in deze lijst bevatten zelf geen lijst, dus er valt niets plat te maken. Kies een lijst waarvan elk item een lijst bevat, zoals e-mails met bijlagen.',
    'flatten_node.editor.no_list': 'Kies de lijst die je plat wilt maken.',
    'flatten_node.editor.choose_list': 'Kies een lijst',
    'flatten_node.editor.no_sample': 'Voer de stap hiervoor uit om te zien welke lijsten erin zitten.',
    'flatten_node.editor.columns': 'Elke rij heeft de {n} velden van de {child}',
    'flatten_node.editor.columns_own': 'Elke rij heeft de eigen velden van de {child}',
    'flatten_node.editor.columns_from': 'plus {fields} van de bijbehorende {parent}',
    'flatten_node.editor.columns_nothing': 'Er wordt niets overgenomen van de bijbehorende {parent}.',
    'flatten_node.editor.and': 'en',
    'flatten_node.editor.left_out': 'Weggelaten: {fields}.',
    'flatten_node.editor.reason_long': 'lange tekst',
    'flatten_node.editor.already_on': '{fields} zitten al bij elke {child}.',
    'flatten_node.editor.choose_fields': 'Velden kiezen',
    'flatten_node.editor.empty_warn': '{emptyCount} van de {outerCount} {parents} heeft geen {children} en levert dus geen rij op.',
    'flatten_node.editor.empty_warn_plural': '{emptyCount} van de {outerCount} {parents} hebben geen {children} en leveren dus geen rijen op.',
    'flatten_node.editor.keep_anyway': 'Toch houden',
    'flatten_node.editor.kept_note': '{parents} zonder {children} krijgen één rij zonder gegevens van een {child}.',
    'flatten_node.editor.undo': 'Ongedaan maken',
    'flatten_node.editor.clash': '{field} van de {parent} heet {renamed}, omdat elke {child} een eigen {field} heeft.',
    'flatten_node.editor.refreshed': 'Neemt nu ook {fields} over.',
    'flatten_node.editor.preview': 'Voorbeeld: {count} rij',
    'flatten_node.editor.preview_plural': 'Voorbeeld: {count} rijen',
    'flatten_node.editor.open': 'Openen',
    'flatten_node.fields.from_each': 'Van elke {parent}',
    'flatten_node.fields.all_child': 'Alle {n} velden',
    'flatten_node.fields.already': 'zit al bij elke {child}',
    'flatten_node.fields.all': 'Alle',
    'flatten_node.fields.reset': 'Herstellen',
    'flatten_node.fields.summary': '{on} van {total} velden',
    'flatten_node.advanced.title': 'Meer opties',
    'flatten_node.advanced.source': 'Bronlijst',
    'flatten_node.advanced.max_items': 'Maximaal aantal invoeritems',
    'flatten_node.advanced.max_help': 'Ook het maximale aantal rijen dat deze stap mag maken.',
    'flatten_node.advanced.empty_title': '{parents} zonder {children}',
    'flatten_node.advanced.empty_drop': 'Weglaten',
    'flatten_node.advanced.empty_keep': 'Elk als één rij houden met lege velden voor de {child}',
    'flatten_node.advanced.empty_keep_help': 'Stappen hierna kunnen dan rijen zonder {children} krijgen.',
    'flatten_node.advanced.item_name': 'Elk(e) {parent} heet {var}',
    'flatten_node.run.made': '{count} rij gemaakt uit {inputCount} {parents}.',
    'flatten_node.run.made_plural': '{count} rijen gemaakt uit {inputCount} {parents}.',
    'flatten_node.run.empty_dropped': '{emptyCount} daarvan had geen {children} en leverde geen rij op.',
    'flatten_node.run.empty_dropped_plural': '{emptyCount} daarvan hadden geen {children} en leverden geen rijen op.',
    'flatten_node.run.empty_kept': '{emptyCount} daarvan had geen {children} en kreeg één rij zonder gegevens van een {child}.',
    'flatten_node.run.empty_kept_plural': '{emptyCount} daarvan hadden geen {children} en kregen elk één rij zonder gegevens van een {child}.',
    'flatten_node.run.no_match': 'Geen van de {inputCount} {parents} heeft een lijst met de naam {children}, dus er viel niets plat te maken.',
    'flatten_node.run.empty_input': 'De lijst was leeg, dus er zijn geen rijen.',
    'flatten_node.run.unit_items': 'items',
    'flatten_node.palette.keywords_hint': 'Eén rij per bijlage, regel of item erin',
    'flatten_node.activity': 'Lijst plat maken',
    'flatten_node.validate.level_missing': 'Kies van welke lijst in elk item je rijen wilt maken.',
    'flatten_node.validate.columns_unsaved': 'Open deze stap één keer, zodat de kolommen vastliggen.',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomic across replicas (advisory lock in mutateConfig); existing values
    // win, only missing keys are added.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-flatten-node-translations applied (+${added} keys)`);
    }
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
