#!/usr/bin/env node
/**
 * Migration: Dutch translations for the Condition node (condition_node.*):
 * operators and quantifiers of the rule rows, File type, the field groups,
 * the Custom rule card, the outputs chooser and the "Otherwise" story,
 * Suggest outputs, the notices that a step after the Condition still reads
 * its list (or that a whole-run Condition reads a whole list), the run and
 * canvas sentences, and the Filter entry of the step palette.
 *
 * "Condition" is "Voorwaarde", "Otherwise" is "Anders", an output is an
 * "uitgang".
 *
 * Idempotent: only inserts keys that do not have a NL value yet. Runs at boot
 * from boot/bootMigrations.js (NL_TRANSLATIONS).
 *
 * Manual usage:
 *   node server/migrations/add-nl-condition-node-translations.js
 */

const NL_TRANSLATIONS = {
    'condition_node.op.is': 'is',
    'condition_node.op.isNot': 'is niet',
    'condition_node.op.eq': 'is gelijk aan',
    'condition_node.op.eq_text': 'is precies (zelfde hoofdletters)',
    'condition_node.op.neq': 'is niet gelijk aan',
    'condition_node.op.neq_text': 'is niet precies (zelfde hoofdletters)',
    'condition_node.op.gt': 'groter dan',
    'condition_node.op.gte': 'groter dan of gelijk aan',
    'condition_node.op.lt': 'kleiner dan',
    'condition_node.op.lte': 'kleiner dan of gelijk aan',
    'condition_node.op.eq_date': 'is op',
    'condition_node.op.gt_date': 'is na',
    'condition_node.op.gte_date': 'is op of na',
    'condition_node.op.lt_date': 'is voor',
    'condition_node.op.lte_date': 'is op of voor',
    'condition_node.op.contains': 'bevat',
    'condition_node.op.notContains': 'bevat niet',
    'condition_node.op.startsWith': 'begint met',
    'condition_node.op.endsWith': 'eindigt op',
    'condition_node.op.isEmpty': 'is leeg',
    'condition_node.op.isNotEmpty': 'is niet leeg',
    'condition_node.op.isEmpty_records': 'heeft er geen',
    'condition_node.op.isNotEmpty_records': 'heeft er minstens één',
    'condition_node.op.isTrue': 'is waar',
    'condition_node.op.isFalse': 'is niet waar',
    'condition_node.op.truthy': 'heeft een waarde',
    'condition_node.op.seq': 'is strikt gelijk aan',
    'condition_node.op.sneq': 'is strikt niet gelijk aan',
    'condition_node.op.isAbout': 'gaat over',
    'condition_node.op.notAbout': 'gaat niet over',
    'condition_node.quantifier.any': '{name}: minstens één',
    'condition_node.quantifier.every': '{name}: allemaal',
    'condition_node.quantifier.none': '{name}: geen enkele',
    'condition_node.quantifier.aria': 'Hoeveel ({name})',
    'condition_node.file_type.label': 'Bestandstype',
    'condition_node.file_type.choose': 'Kies een bestandstype',
    'condition_node.file_type.pdf': 'PDF',
    'condition_node.file_type.word': 'Word',
    'condition_node.file_type.excel': 'Excel of CSV',
    'condition_node.file_type.powerpoint': 'PowerPoint',
    'condition_node.file_type.image': 'Afbeelding',
    'condition_node.file_type.text': 'Tekst',
    'condition_node.file_type.archive': 'Archief (zip)',
    'condition_node.file_type.audio': 'Audio',
    'condition_node.file_type.video': 'Video',
    'condition_node.file_type.other': 'Overig',
    'condition_node.group.item': 'Velden per {name}',
    'condition_node.group.inner_list': '{list} per {name}',
    'condition_node.group.parent': 'Waar het bij hoort ({name})',
    'condition_node.hint.case': 'Tekstvergelijkingen negeren hoofdletters.',
    'condition_node.hint.records_op': '{list} is een lijst, dus “{op}” past er nooit op. Kies liever een veld onder {list}, bijvoorbeeld Bestandstype.',
    'condition_node.hint.field_missing': 'De voorbeelddata heeft geen “{field}”, dus deze regel zou niets opleveren.',
    'condition_node.hint.list_field': 'Dit veld bevat een lijst. Kies het in het veldenmenu om minstens één, elk of geen enkel item ervan te controleren.',
    'condition_node.custom.title': 'Eigen regel',
    'condition_node.custom.body': 'Deze regel is als formule geschreven, dus hij kan hier niet als klikbare regels worden getoond.',
    'condition_node.custom.reads': 'Hij leest: {fields}',
    'condition_node.custom.rebuild': 'Opnieuw opbouwen door te klikken',
    'condition_node.custom.rebuild_note': 'De formule blijft staan tot je een veld kiest.',
    'condition_node.custom.keep': 'Formule houden',
    'condition_node.custom.advanced': 'Wil je de formule zelf aanpassen, schakel dan naar Geavanceerd.',
    'condition_node.outputs.one': 'Eén uitgang',
    'condition_node.outputs.several': 'Meerdere uitgangen',
    'condition_node.outputs.aria': 'Aantal uitgangen',
    'condition_node.outputs.count': 'Deze stap heeft {n} uitgangen.',
    'condition_node.outputs.count_one': 'Deze stap heeft 1 uitgang.',
    'condition_node.otherwise.label': 'Anders',
    'condition_node.otherwise.one': 'Wat past gaat verder; de rest stopt hier.',
    'condition_node.otherwise.first': 'Elk item gaat naar de eerste uitgang waar het bij past. Wat nergens bij past, gaat naar “Anders”; laat “Anders” los om het te laten vallen.',
    'condition_node.otherwise.all': 'Elke uitgang wordt los gecontroleerd, dus één item kan via meerdere uitgangen verder. Wat nergens bij past, gaat naar “Anders”; laat “Anders” los om het te laten vallen.',
    'condition_node.otherwise.use': 'De uitgang Anders gebruiken',
    'condition_node.default_output_name': 'Uitgang {n}',
    'condition_node.port.match': 'Past',
    'condition_node.suggest.unmatched_several': '{n} van de {total} {unit} uit het voorbeeld passen bij geen van deze en gaan naar “Anders”.',
    'condition_node.suggest.unmatched_one': '{n} van de {total} {unit} uit het voorbeeld passen niet en stoppen hier.',
    'condition_node.suggest.custom_rule': 'een eigen regel',
    'condition_node.suggest.by_file_type': 'Splitsen op bestandstype',
    'condition_node.suggest.files_inside': 'Deze uitgangen kijken per {name} naar de {list}: één {name} met een PDF en een Word-bestand gaat via allebei.',
    'condition_node.suggest.check_each': 'Controleer liever per {item}',
    'condition_node.suggest.check_each_note': 'Splitst de {list} zelf, een voor een.',
    'condition_node.suggest.name_types': 'Noem de bestandstypes om op te splitsen, bijvoorbeeld “pdf, word en powerpoint”.',
    'condition_node.source.no_sample': 'nog geen voorbeeld: voer de stap erboven uit om de velden te zien',
    'condition_node.rules_dont_fit': 'Deze regels lezen {fields}, en dat heeft een {name} niet.',
    'condition_node.rules_remove_unfit': 'Die regels verwijderen',
    'condition_node.stale.one': '“{step}” leest nog steeds {list}, dus wat deze Voorwaarde laat vallen komt er toch bij aan.',
    'condition_node.stale.many': '{steps} lezen nog steeds {list}, dus wat deze Voorwaarde laat vallen komt er toch bij aan.',
    'condition_node.stale.follow': 'Gebruik wat deze Voorwaarde doorlaat',
    'condition_node.followed_toast': '“{step}” werkt nu met wat “{condition}” doorlaat.',
    'condition_node.run.kept': '{kept} van {total} {unit} doorgelaten',
    'condition_node.run.kept_none': 'Geen van de {total} {unit} doorgelaten',
    'condition_node.run.split': '{parts} ({total} {unit} in totaal)',
    'condition_node.run.split_fanout': 'één item kan via meerdere uitgangen gaan',
    'condition_node.run.unit_items': 'items',
    'condition_node.run.kept_from': '{kept} van {total} {unit} doorgelaten, uit {parents} {parentUnit}',
    'condition_node.miss.rule': 'De regel',
    'condition_node.miss.output': 'Uitgang “{name}”',
    'condition_node.miss.hint': 'Een regel las een veld dat geen enkel item heeft, dus er paste niets. Kies het veld opnieuw in de Voorwaarde.',
    'condition_node.canvas.no_rule': 'nog geen regel',
    'condition_node.canvas.no_list': 'nog geen lijst',
    'condition_node.canvas.outputs': '{n} uitgangen',
    'condition_node.canvas.outputs_otherwise': '{n} uitgangen + Anders',
    'condition_node.canvas.output': '1 uitgang',
    'condition_node.canvas.output_otherwise': '1 uitgang + Anders',
    'condition_node.canvas.rule_otherwise': '{rule} + Anders',
    'condition_node.join.and': 'en',
    'condition_node.join.or': 'of',
    'condition_node.canvas.kept': '{kept} van {total} doorgelaten',
    'condition_node.check_each.label': 'Controleer per',
    'condition_node.check_each.option': '{name} ({count})',
    'condition_node.check_each.nested': '{name} ({count} in {parentCount} {parents})',
    'condition_node.live.match': '{n} van de {total} {unit} uit het voorbeeld passen',
    'condition_node.live.none': 'Geen van de {total} {unit} uit het voorbeeld past',
    'condition_node.palette.filter_label': 'Lijst filteren',
    'condition_node.palette.filter_desc': 'Houd alleen de items van een lijst over die passen; de rest stopt hier.',
    'condition_node.outputs.keep_rest': 'Stuur wat niet past naar “Anders”',
    'condition_node.outputs.keep_rest_hint': 'Anders wordt een tweede uitgang; laat die los om deze items te laten vallen.',
    'condition_node.otherwise.one_keep': 'Wat past gaat verder; wat niet past gaat naar “Anders”; laat “Anders” los om het te laten vallen.',
    'condition_node.whole_list.note': 'Dit controleert de hele lijst {list} één keer: de run gaat voor al haar items dezelfde kant op. De items worden niet gefilterd.',
    'condition_node.whole_list.use_filter': 'Controleer liever elk item apart',
    'condition_node.loop_after.one': '“{step}” draait nog steeds één keer voor elk item van die lijst.',
    'condition_node.loop_after.many': '{steps} draaien nog steeds één keer voor elk item van die lijst.',
    'condition_node.fix.followed': 'Klaar: de volgende stappen lezen nu wat deze Voorwaarde doorlaat.',
    'condition_node.fix.removed': 'Klaar: die regels zijn verwijderd.',
    'condition_node.fix.each_item': 'Klaar: deze Voorwaarde controleert nu elk item apart.',
    'condition_node.suggest.files_inside_first': 'Deze uitgangen kijken per {name} naar de {list}: één {name} met een PDF en een Word-bestand gaat alleen via de eerste uitgang die past.',
    'condition_node.suggest.unmatched_one_keep': '{n} van de {total} {unit} uit het voorbeeld passen niet en gaan naar “Anders”.',
    'condition_node.outputs.count_one_keep': 'Deze stap heeft 1 uitgang plus “Anders”.',
    'condition_node.otherwise.one_run': 'Klopt de regel, dan gaat de run verder; klopt hij niet, dan gaat de run naar “Anders”; laat “Anders” los om de run daar te stoppen.',
    'condition_node.outputs.label': 'Hoeveel uitgangen heeft deze stap?',
    'condition_node.outputs.hint': 'Eén uitgang: wat past gaat verder. Meerdere uitgangen: elke uitgang heeft een eigen regel en een eigen vervolg.',
    'condition_node.outputs.example': 'Elke uitgang is een filter met een eigen bestemming, bijvoorbeeld Uitgang 1: Onderwerp bevat urgent, Uitgang 2: Onderwerp bevat factuur.',
    'condition_node.collapse.one': 'Terug naar één uitgang verwijdert {outputs}. Die uitgang is op het canvas verbonden, dus de verbinding verdwijnt ook.',
    'condition_node.collapse.several': 'Terug naar één uitgang verwijdert {outputs}. Die uitgangen zijn op het canvas verbonden, dus de verbindingen verdwijnen ook.',
    'condition_node.collapse.confirm': 'Toch verwijderen',
    'condition_node.collapse.cancel': 'Meerdere uitgangen houden',
    'condition_node.outputs.canvas_note': 'Op het canvas: een uitgang die zijn naam houdt, houdt zijn verbinding; een uitgang die verdwijnt, neemt zijn verbinding mee.',
    'condition_node.run.total': '{total} {unit}',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomic across replicas (advisory lock in mutateConfig); existing values
    // win, only missing keys are added.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-condition-node-translations applied (+${added} keys)`);
    }
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
