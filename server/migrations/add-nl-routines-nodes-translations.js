#!/usr/bin/env node
/**
 * One-time migration: Dutch for the routines builder's NODE CATALOG — every
 * standard node's name, palette description and "what does this node do?"
 * sentence, plus the three group captions.
 *
 * Until now not one `routines.*` key existed in any nl migration, and the node
 * labels were hardcoded English literals besides, so a Dutch user saw the whole
 * step picker in English. The strings now live in flow/nodeDefs.js behind
 * `routines.node.*` keys; this fills them in.
 *
 * Scope is the CATALOG only. The rest of the builder (field labels, hints, the
 * server's validation messages) is still hardcoded English and needs its own
 * pass — see the plan's deferred WS5/WS6.
 *
 * Merges into the existing i18n_gui_nl config without overwriting any
 * translations that already exist. Idempotent — safe to re-run. Auto-runs from
 * server boot (server/index.js). Manual usage:
 *   node server/migrations/add-nl-routines-nodes-translations.js
 */

const NL_TRANSLATIONS = {
    // ── Groepskoppen in de stappenkiezer ──
    'routines.node.group.flow_control': 'Stroombesturing',
    'routines.node.group.data': 'Gegevens',
    'routines.node.group.lists': 'Lijsten',
    'routines.node.group.data_lists': 'Gegevens & lijsten',
    // The two headings the builder redesign added to stepPalette.js without a
    // Dutch value, which is why this migration's own parity test was red.
    'routines.node.group.people': 'Mensen & wachten',
    'routines.node.group.integrations': 'Integraties',

    // ── Trigger ──
    'routines.node.trigger.typeLabel': 'Trigger',
    'routines.node.trigger.defaultLabel': 'Trigger',
    'routines.node.trigger.help': 'Waarmee deze routine begint. Elke routine heeft er precies één.',

    // ── AI en apps ──
    'routines.node.ai_step.typeLabel': 'AI-stap',
    'routines.node.ai_step.defaultLabel': 'AI-stap',
    'routines.node.ai_step.label': 'AI-stap',
    'routines.node.ai_step.desc': 'Redeneren en tools aanroepen met AI',
    'routines.node.ai_step.help': 'Geeft de run door aan een AI-model met jouw instructies, en gaat verder met wat dat oplevert.',
    'routines.node.integration_action.typeLabel': 'Actie',
    'routines.node.integration_action.defaultLabel': 'Integratie',
    'routines.node.integration_action.help': 'Doet één ding in een gekoppelde app — de e-mail versturen, het bestand aanmaken, de rij bijwerken.',

    // ── Stroombesturing ──
    'routines.node.condition.typeLabel': 'Voorwaarde',
    'routines.node.condition.defaultLabel': 'Voorwaarde',
    'routines.node.condition.label': 'Voorwaarde',
    'routines.node.condition.desc': 'Doorlaten, splitsen of vertakken — één regel of meerdere',
    'routines.node.condition.help': 'Stelt een ja/nee-vraag over je gegevens en stuurt de run uit de kant die klopt.',
    'routines.node.switch.typeLabel': 'Voorwaarde',
    'routines.node.switch.defaultLabel': 'Voorwaarde',
    'routines.node.switch.help': 'Stelt een ja/nee-vraag over je gegevens en stuurt de run uit de kant die klopt.',
    'routines.node.filter.typeLabel': 'Voorwaarde',
    'routines.node.filter.defaultLabel': 'Voorwaarde',
    'routines.node.filter.help': 'Stelt een ja/nee-vraag over je gegevens en stuurt de run uit de kant die klopt.',
    'routines.node.loop.typeLabel': 'Herhalen',
    'routines.node.loop.defaultLabel': 'Herhalen voor elk',
    'routines.node.loop.label': 'Herhalen voor elk',
    'routines.node.loop.desc': 'Voer de stappen erbinnen één keer uit voor elk item in een lijst',
    'routines.node.loop.help': 'Neemt een lijst en voert de stappen erbinnen één keer per item uit. Elk item is voor die stappen beschikbaar als loop.item.',
    'routines.node.wait.typeLabel': 'Wachten',
    'routines.node.wait.defaultLabel': 'Wachten',
    'routines.node.wait.label': 'Wachten',
    'routines.node.wait.desc': 'Pauzeer vóór de volgende stap — seconden, minuten of uren',
    'routines.node.wait.help': 'Houdt de run hier een vaste tijd vast en gaat daarna verder. Tot 24 uur.',
    'routines.node.stop_error.typeLabel': 'Stoppen',
    'routines.node.stop_error.defaultLabel': 'Stoppen met een fout',
    'routines.node.stop_error.label': 'Stoppen met een fout',
    'routines.node.stop_error.desc': 'Beëindig de run nu en leg vast waarom',
    'routines.node.stop_error.help': 'Beëindigt de run onmiddellijk en legt jouw bericht vast als de reden. Wat na deze stap staat, wordt nooit uitgevoerd.',
    'routines.node.notification.typeLabel': 'Melding',
    'routines.node.notification.defaultLabel': 'Melding',
    'routines.node.notification.label': 'Melding',
    'routines.node.notification.desc': 'Stuur een bericht of waarschuwing',
    'routines.node.notification.help': 'Stuurt tijdens de run een bericht naar jou of je team — via een melding in de app of per e-mail.',
    'routines.node.approval.typeLabel': 'Goedkeuring',
    'routines.node.approval.defaultLabel': 'Goedkeuring',
    'routines.node.approval.label': 'Iemand om goedkeuring vragen',
    'routines.node.approval.desc': 'Pauzeer de run tot iemand goedkeurt of afwijst',
    'routines.node.approval.help': 'Pauzeert de run en vraagt iemand om goed te keuren of af te wijzen. Bij goedkeuring gaat de run verder met de volgende stap; bij afwijzing stopt de run hier.',
    'routines.node.form_page.typeLabel': 'Formulierpagina',
    'routines.node.form_page.defaultLabel': 'Om meer info vragen',
    'routines.node.form_page.help': 'Pauzeert de run en toont nog een pagina op de eigen formulierlink van de routine, en gaat daarna verder met de antwoorden.',

    // ── Privacy ──
    'routines.node.guard.typeLabel': 'Controle op persoonsgegevens',
    'routines.node.guard.defaultLabel': 'Persoonsgegevens vinden',
    'routines.node.guard.label': 'Persoonsgegevens vinden',
    'routines.node.guard.desc': 'Scan een waarde en vertak op de vraag of er persoonsgegevens in staan',
    'routines.node.guard.help': 'Zoekt in een waarde naar namen, adressen, BSN-achtige nummers en dergelijke, en stuurt de run daarna uit de kant "persoonsgegevens" of "schoon".',
    'routines.node.tokenize.typeLabel': 'Persoonsgegevens verbergen',
    'routines.node.tokenize.defaultLabel': 'Persoonsgegevens verbergen',
    'routines.node.tokenize.label': 'Persoonsgegevens verbergen',
    'routines.node.tokenize.desc': 'Vervang persoonsgegevens door plaatsaanduidingen; de echte waarden komen vanzelf terug',
    'routines.node.tokenize.help': 'Vervangt persoonsgegevens door plaatsaanduidingen voordat de waarde verder reist — naar een AI-model bijvoorbeeld. De echte waarden worden automatisch teruggezet zodra de run ze weer gebruikt.',
    'routines.node.untokenize.typeLabel': 'Echte waarden tonen',
    'routines.node.untokenize.defaultLabel': 'Echte waarden weer tonen',
    'routines.node.untokenize.label': 'Echte waarden weer tonen',
    'routines.node.untokenize.desc': 'Zet de echte waarden terug waar een stap nog plaatsaanduidingen bevat',
    'routines.node.untokenize.help': 'Zet de echte waarden terug op de plek van eventuele overgebleven plaatsaanduidingen. Alleen nodig waar ze niet al vanzelf zijn teruggekomen.',

    // ── Gegevens ──
    'routines.node.set.typeLabel': 'Gegevens bewerken',
    'routines.node.set.defaultLabel': 'Gegevens bewerken',
    'routines.node.set.label': 'Gegevens bewerken',
    'routines.node.set.desc': 'Velden toevoegen, hernoemen en ordenen — voor één record of een hele tabel',
    'routines.node.set.help': 'Bouwt precies de set velden die de volgende stap nodig heeft — door toe te voegen, te hernoemen en te herordenen wat ervóór kwam.',
    'routines.node.datetime.typeLabel': 'Datum & tijd',
    'routines.node.datetime.defaultLabel': 'Datum & tijd',
    'routines.node.datetime.label': 'Datum & tijd',
    'routines.node.datetime.desc': 'De datum van vandaag ophalen, er een anders opschrijven, dagen optellen of er twee vergelijken',
    'routines.node.datetime.help': 'Werkt met datums en tijden: de datum van vandaag, er een uit tekst lezen, anders opschrijven, verschuiven, of het gat tussen twee datums meten.',
    'routines.node.http_request.typeLabel': 'Webservice-aanroep',
    'routines.node.http_request.defaultLabel': 'Een webservice aanroepen',
    'routines.node.http_request.label': 'Een webservice aanroepen',
    'routines.node.http_request.desc': 'Stuur een verzoek naar een systeem waarvoor hier geen kant-en-klare actie bestaat',
    'routines.node.http_request.help': 'Stuurt een verzoek rechtstreeks naar het webadres van een ander systeem en gaat verder met wat dat terugstuurt. Voor systemen zonder kant-en-klare actie in de Actie-lijst.',
    'routines.node.generate_document.typeLabel': 'Document maken',
    'routines.node.generate_document.defaultLabel': 'Document maken',
    'routines.node.generate_document.label': 'Document maken',
    'routines.node.generate_document.desc': 'Maak een PDF of Word-bestand van tekst uit een eerdere stap',
    'routines.node.generate_document.help': 'Zet tekst die een eerdere stap heeft gemaakt om in een echt PDF- of Word-bestand, met koppen, vet en links intact. Zet er een Formulierpagina achter om het bestand als download aan te bieden. Het bestand wordt verwijderd zodra de bewaartermijn voorbij is. Onder Look stel je alleen voor dit deck de stijl, kleuren, het lettertype, een logo (of geen) en een footerregel in.',
    'routines.node.fill_document.typeLabel': 'Document invullen',
    'routines.node.fill_document.defaultLabel': 'Document invullen',
    'routines.node.fill_document.label': 'Document invullen',
    'routines.node.fill_document.desc': 'Vul een document dat je zelf hebt ontworpen en bewaar de pdf',
    'routines.node.fill_document.help': 'Neemt een document dat je in Studio → Documenten hebt ontworpen — een factuur, een offerte, een brief op je eigen briefpapier — vult de plaatsvervangers met waarden uit deze run en bewaart de pdf. Kies "Document maken" als er geen ontwerp is en de stap de tekst zelf moet opmaken.',
    'routines.node.slide.typeLabel': 'Dia',
    'routines.node.slide.defaultLabel': 'Dia',
    'routines.node.slide.label': 'Dia',
    'routines.node.slide.desc': 'Eén dia van een presentatie: een titel met opsommingen, een tabel, een citaat of een afbeelding',
    'routines.node.slide.help': 'Bouwt één dia als waarde — nog geen bestand. Geef een titel en inhoud (opsommingen, een alinea, een tabel, een citaat), eventueel sprekersnotities, en koppel ze aan eerdere stappen. Gebruik "één per item" om voor elke rij van een lijst een dia te maken, en geef de dia\'s daarna aan een Presentatie-stap. Visuals: een grafiek uit datarijen, KPI-tegels, een tijdlijn van stappen of een dia in de accentkleur.',
    'routines.node.presentation.typeLabel': 'Presentatie',
    'routines.node.presentation.defaultLabel': 'Presentatie',
    'routines.node.presentation.label': 'Presentatie',
    'routines.node.presentation.desc': 'Maak van dia\'s of een geschreven opzet een PowerPoint (of pdf-deck) in je huisstijl',
    'routines.node.presentation.help': 'Neemt dia\'s — de opzet die een AI-stap schreef ("# " titel, "## " per dia), een lijst Dia-stappen of de resultaten van een lus — en bouwt er een echt PowerPoint-bestand (of pdf-deck) van in de huisstijl van je organisatie. Zet er een Formulierpagina achter om het bestand als download aan te bieden, of een Nextcloud-upload om het te bewaren waar het in Nextcloud Office opent. Het bestand wordt verwijderd zodra de bewaartermijn voorbij is. Onder Look stel je alleen voor dit deck de stijl, kleuren, het lettertype, een logo (of geen) en een footerregel in.',
    'routines.node.parse_json.typeLabel': 'JSON uitlezen',
    'routines.node.parse_json.defaultLabel': 'JSON uitlezen',
    'routines.node.parse_json.help': 'Haalt genoemde velden uit een blok JSON-tekst. Uitgefaseerd — Gegevens bewerken doet dit nu.',
    'routines.node.code.typeLabel': 'Code',
    'routines.node.code.defaultLabel': 'Code',
    'routines.node.code.label': 'Code',
    'routines.node.code.desc': 'Eigen JavaScript uitvoeren',
    'routines.node.code.help': 'Voert een stukje JavaScript uit in een sandbox en gaat verder met wat dat teruggeeft.',

    // ── Lijsten ──
    'routines.node.limit.typeLabel': 'Lijst inkorten',
    'routines.node.limit.defaultLabel': 'Lijst inkorten',
    'routines.node.limit.label': 'Lijst inkorten',
    'routines.node.limit.desc': 'Houd alleen de eerste — of laatste — paar items over',
    'routines.node.limit.help': 'Kort een lijst in tot de eerste of laatste paar items en geeft de kortere lijst door.',
    'routines.node.dedupe.typeLabel': 'Dubbele items verwijderen',
    'routines.node.dedupe.defaultLabel': 'Dubbele items verwijderen',
    'routines.node.dedupe.label': 'Dubbele items verwijderen',
    'routines.node.dedupe.desc': 'Houd van elk er één over — op het hele item, of op één veld',
    'routines.node.dedupe.help': 'Houdt van elk item er één over en laat de herhalingen vallen. Vergelijk op één veld, of op het hele item.',
    'routines.node.aggregate.typeLabel': 'Eén veld verzamelen',
    'routines.node.aggregate.defaultLabel': 'Eén veld verzamelen',
    'routines.node.aggregate.label': 'Eén veld verzamelen',
    'routines.node.aggregate.desc': 'Neem hetzelfde veld uit elk item — elk e-mailadres bijvoorbeeld',
    'routines.node.aggregate.help': 'Leest één veld uit elk item in een lijst en geeft een gewone lijst van alleen die waarden terug.',
    'routines.node.summarize.typeLabel': 'Optellen of tellen',
    'routines.node.summarize.defaultLabel': 'Optellen of tellen',
    'routines.node.summarize.label': 'Optellen of tellen',
    'routines.node.summarize.desc': 'Totaal, aantal, gemiddelde, laagste of hoogste — over één veld',
    'routines.node.summarize.help': 'Maakt van een lijst één getal: het totaal, het aantal, het gemiddelde, of de laagste of hoogste waarde van één veld.',

    // ── Flowlets en herbruikbare Stappen ──
    'routines.node.call_layer.typeLabel': 'Flowlet',
    'routines.node.call_layer.defaultLabel': 'Flowlet',
    'routines.node.call_layer.help': 'Voert een groep stappen uit die je één keer hebt gebouwd en kunt hergebruiken, en gaat daarna verder met wat die teruggeeft.',
    'routines.node.call_block.typeLabel': 'Stap',
    'routines.node.call_block.defaultLabel': 'Stap',
    'routines.node.call_block.help': 'Voert een herbruikbare Stap uit je bibliotheek uit en gaat daarna verder met wat die teruggeeft.',
    'routines.node.layer_output.typeLabel': 'Teruggeven',
    'routines.node.layer_output.defaultLabel': 'Teruggeven',
    'routines.node.layer_output.label': 'Flowlet-uitvoer',
    'routines.node.layer_output.desc': 'Geef gegevens vanuit deze flowlet terug aan de aanroeper',
    'routines.node.layer_output.help': 'Sluit een flowlet af en geeft de velden die je noemt terug aan wat de flowlet aanriep.',

    // ── Datatabel ──
    // Landed after the rest of the catalog. This migration merges missing keys
    // on every boot, so adding them here is enough — a separate migration would
    // only split one catalog across two files.
    'routines.node.datatable.typeLabel': 'Datatabel',
    'routines.node.datatable.defaultLabel': 'Datatabel',
    'routines.node.datatable.label': 'Datatabel',
    'routines.node.datatable.desc': 'Bewaar rijen die de run overleven — en deel ze met andere routines',
    'routines.node.datatable.help': 'Leest en schrijft rijen in een tabel die blijft bestaan nadat de run klaar is, zodat deze routine verder kan waar hij gebleven was en andere routines dezelfde gegevens kunnen gebruiken.',

    // K10 — de tweede stap waarvan het effect de run overleeft. Bewust NIET
    // "Naar kennisbank schrijven": op de kaart staat de naam van de stap, niet
    // wat hij doet, en "Naar kennisbank" leest daar als een bestemming.
    'routines.node.knowledge_write.typeLabel': 'Naar kennisbank',
    'routines.node.knowledge_write.defaultLabel': 'Naar kennisbank',
    'routines.node.knowledge_write.label': 'Naar kennisbank',
    'routines.node.knowledge_write.desc': 'Bewaar tekst waar een agent hem later kan vinden',
    'routines.node.knowledge_write.help': 'Zet tekst in een kennisbank, zodat je agents er daarna uit kunnen antwoorden — een opgeloste ticket als artikel, de besluiten uit een vergadering, de samenvatting van vannacht. Geef er een bronverwijzing bij, dan vervangt elke run zijn eigen tekst in plaats van er weer een nieuwe achter te laten.',

    'routines.node.parallel.typeLabel': 'Parallel',
    'routines.node.parallel.defaultLabel': 'Parallel',
    'routines.node.parallel.help': 'Voert meerdere takken tegelijk uit en gaat verder zodra ze allemaal klaar zijn.',

    // ── Terug naar de app (return_to_app) ──
    // De sleutels stonden al in en.js (Track P4) maar hadden hier nog geen
    // Nederlands, waardoor de dekkingstest van deze migratie rood bleef.
    'routines.node.return_to_app.typeLabel': 'Terug naar de app',
    'routines.node.return_to_app.defaultLabel': 'Terug naar de app',
    'routines.node.return_to_app.label': 'Terug naar de app',
    'routines.node.return_to_app.desc': 'Beëindig de run en vertel de app wat er nu moet gebeuren',
    'routines.node.return_to_app.help': 'Beëindigt de run en geeft de app een bericht, een scherm om te openen en wat er vernieuwd moet worden. Niets na deze stap wordt nog uitgevoerd.',
    'routines.node.return_to_app.card_resets_form': 'maakt het formulier leeg',
    'routines.node.return_to_app.card_reloads_data': 'laadt de gegevens opnieuw',
    'routines.node.return_to_app.card_empty': 'zegt de app nog niets',
    // ── Gegevens uitlezen (data_extraction) ──
    // De stap die met naam genoemde, getypeerde velden uit tekst haalt op het
    // extractiemodel van de beheerder. Sleutels als in het gedeelde contract
    // (2026-09-12): `routines.node.` voor de kaart, `routines.ndv.extraction.`
    // voor het instellingenpaneel. "Naam" en "Type" zijn in het Nederlands
    // hetzelfde woord als in het Engels.
    'routines.node.data_extraction.typeLabel': 'Gegevens uitlezen',
    'routines.node.data_extraction.defaultLabel': 'Gegevens uitlezen',
    'routines.node.data_extraction.label': 'Gegevens uitlezen',
    'routines.node.data_extraction.desc': 'Haal met naam genoemde velden uit tekst — een factuur, een e-mail, een pdf',
    'routines.node.data_extraction.help': 'Leest één stuk tekst — een pdf die je eerder hebt gelezen, de tekst van een e-mail, een pagina — en geeft precies de velden terug die je noemt, als tekst, getal, ja/nee of datum. Draait altijd op het extractiemodel dat je beheerder heeft ingesteld, niet op de chat-tier van de routine, met denken uit en een vaste antwoordvorm. Een veld dat niet gevonden wordt blijft leeg, en wordt nooit verzonnen. Zet de stap na een stap die de tekst maakt; een stap erna kan elk veld op naam binden.',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-routines-nodes-translations applied (+${added} keys)`);
    }
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
