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
    'automations.node.group.flow_control': 'Stroombesturing',
    'automations.node.group.data': 'Gegevens',
    'automations.node.group.lists': 'Lijsten',
    'automations.node.group.data_lists': 'Gegevens & lijsten',
    // The two headings the builder redesign added to stepPalette.js without a
    // Dutch value, which is why this migration's own parity test was red.
    'automations.node.group.people': 'Mensen & wachten',
    'automations.node.group.integrations': 'Integraties',

    // ── Trigger ──
    'automations.node.trigger.typeLabel': 'Trigger',
    'automations.node.trigger.defaultLabel': 'Trigger',
    'automations.node.trigger.help': 'Waarmee deze automatisering begint. Elke automatisering heeft er precies één.',

    // ── AI en apps ──
    'automations.node.ai_step.typeLabel': 'AI-stap',
    'automations.node.ai_step.defaultLabel': 'AI-stap',
    'automations.node.ai_step.label': 'AI-stap',
    'automations.node.ai_step.desc': 'Redeneren en tools aanroepen met AI',
    'automations.node.ai_step.help': 'Geeft de run door aan een AI-model met jouw instructies, en gaat verder met wat dat oplevert.',
    'automations.node.integration_action.typeLabel': 'Actie',
    'automations.node.integration_action.defaultLabel': 'Integratie',
    'automations.node.integration_action.help': 'Doet één ding in een gekoppelde app — de e-mail versturen, het bestand aanmaken, de rij bijwerken.',

    // ── Stroombesturing ──
    'automations.node.condition.typeLabel': 'Voorwaarde',
    'automations.node.condition.defaultLabel': 'Voorwaarde',
    'automations.node.condition.label': 'Voorwaarde',
    'automations.node.condition.desc': 'Doorlaten, splitsen of vertakken — één regel of meerdere',
    'automations.node.condition.help': 'Stelt een ja/nee-vraag over je gegevens en stuurt de run uit de kant die klopt.',
    'automations.node.switch.typeLabel': 'Voorwaarde',
    'automations.node.switch.defaultLabel': 'Voorwaarde',
    'automations.node.switch.help': 'Stelt een ja/nee-vraag over je gegevens en stuurt de run uit de kant die klopt.',
    'automations.node.filter.typeLabel': 'Voorwaarde',
    'automations.node.filter.defaultLabel': 'Voorwaarde',
    'automations.node.filter.help': 'Stelt een ja/nee-vraag over je gegevens en stuurt de run uit de kant die klopt.',
    'automations.node.loop.typeLabel': 'Herhalen',
    'automations.node.loop.defaultLabel': 'Herhalen voor elk',
    'automations.node.loop.label': 'Herhalen voor elk',
    'automations.node.loop.desc': 'Voer de stappen erbinnen één keer uit voor elk item in een lijst',
    'automations.node.loop.help': 'Neemt een lijst en voert de stappen erbinnen één keer per item uit. Elk item is voor die stappen beschikbaar als loop.item.',
    'automations.node.wait.typeLabel': 'Wachten',
    'automations.node.wait.defaultLabel': 'Wachten',
    'automations.node.wait.label': 'Wachten',
    'automations.node.wait.desc': 'Pauzeer vóór de volgende stap — seconden, minuten of uren',
    'automations.node.wait.help': 'Houdt de run hier een vaste tijd vast en gaat daarna verder. Tot 24 uur.',
    'automations.node.stop_error.typeLabel': 'Stoppen',
    'automations.node.stop_error.defaultLabel': 'Stoppen met een fout',
    'automations.node.stop_error.label': 'Stoppen met een fout',
    'automations.node.stop_error.desc': 'Beëindig de run nu en leg vast waarom',
    'automations.node.stop_error.help': 'Beëindigt de run onmiddellijk en legt jouw bericht vast als de reden. Wat na deze stap staat, wordt nooit uitgevoerd.',
    'automations.node.notification.typeLabel': 'Melding',
    'automations.node.notification.defaultLabel': 'Melding',
    'automations.node.notification.label': 'Melding',
    'automations.node.notification.desc': 'Stuur een bericht of waarschuwing',
    'automations.node.notification.help': 'Stuurt tijdens de run een bericht naar jou of je team — via een melding in de app of per e-mail.',
    'automations.node.approval.typeLabel': 'Goedkeuring',
    'automations.node.approval.defaultLabel': 'Goedkeuring',
    'automations.node.approval.label': 'Iemand om goedkeuring vragen',
    'automations.node.approval.desc': 'Pauzeer de run tot iemand goedkeurt of afwijst',
    'automations.node.approval.help': 'Pauzeert de run en vraagt iemand om goed te keuren of af te wijzen. Bij goedkeuring gaat de run verder met de volgende stap; bij afwijzing stopt de run hier.',
    'automations.node.form_page.typeLabel': 'Formulierpagina',
    'automations.node.form_page.defaultLabel': 'Om meer info vragen',
    'automations.node.form_page.help': 'Pauzeert de run en toont nog een pagina op de eigen formulierlink van de automatisering, en gaat daarna verder met de antwoorden.',

    // ── Privacy ──
    'automations.node.guard.typeLabel': 'Controle op persoonsgegevens',
    'automations.node.guard.defaultLabel': 'Persoonsgegevens vinden',
    'automations.node.guard.label': 'Persoonsgegevens vinden',
    'automations.node.guard.desc': 'Scan een waarde en vertak op de vraag of er persoonsgegevens in staan',
    'automations.node.guard.help': 'Zoekt in een waarde naar namen, adressen, BSN-achtige nummers en dergelijke, en stuurt de run daarna uit de kant "persoonsgegevens" of "schoon".',
    'automations.node.tokenize.typeLabel': 'Persoonsgegevens verbergen',
    'automations.node.tokenize.defaultLabel': 'Persoonsgegevens verbergen',
    'automations.node.tokenize.label': 'Persoonsgegevens verbergen',
    'automations.node.tokenize.desc': 'Vervang persoonsgegevens door plaatsaanduidingen; de echte waarden komen vanzelf terug',
    'automations.node.tokenize.help': 'Vervangt persoonsgegevens door plaatsaanduidingen voordat de waarde verder reist — naar een AI-model bijvoorbeeld. De echte waarden worden automatisch teruggezet zodra de run ze weer gebruikt.',
    'automations.node.untokenize.typeLabel': 'Echte waarden tonen',
    'automations.node.untokenize.defaultLabel': 'Echte waarden weer tonen',
    'automations.node.untokenize.label': 'Echte waarden weer tonen',
    'automations.node.untokenize.desc': 'Zet de echte waarden terug waar een stap nog plaatsaanduidingen bevat',
    'automations.node.untokenize.help': 'Zet de echte waarden terug op de plek van eventuele overgebleven plaatsaanduidingen. Alleen nodig waar ze niet al vanzelf zijn teruggekomen.',

    // ── Gegevens ──
    'automations.node.set.typeLabel': 'Gegevens bewerken',
    'automations.node.set.defaultLabel': 'Gegevens bewerken',
    'automations.node.set.label': 'Gegevens bewerken',
    'automations.node.set.desc': 'Velden toevoegen, hernoemen en ordenen — voor één record of een hele tabel',
    'automations.node.set.help': 'Bouwt precies de set velden die de volgende stap nodig heeft — door toe te voegen, te hernoemen en te herordenen wat ervóór kwam.',
    'automations.node.datetime.typeLabel': 'Datum & tijd',
    'automations.node.datetime.defaultLabel': 'Datum & tijd',
    'automations.node.datetime.label': 'Datum & tijd',
    'automations.node.datetime.desc': 'De datum van vandaag ophalen, er een anders opschrijven, dagen optellen of er twee vergelijken',
    'automations.node.datetime.help': 'Werkt met datums en tijden: de datum van vandaag, er een uit tekst lezen, anders opschrijven, verschuiven, of het gat tussen twee datums meten.',
    'automations.node.http_request.typeLabel': 'Webservice-aanroep',
    'automations.node.http_request.defaultLabel': 'Een webservice aanroepen',
    'automations.node.http_request.label': 'Een webservice aanroepen',
    'automations.node.http_request.desc': 'Stuur een verzoek naar een systeem waarvoor hier geen kant-en-klare actie bestaat',
    'automations.node.http_request.help': 'Stuurt een verzoek rechtstreeks naar het webadres van een ander systeem en gaat verder met wat dat terugstuurt. Voor systemen zonder kant-en-klare actie in de Actie-lijst.',
    'automations.node.generate_document.typeLabel': 'Document maken',
    'automations.node.generate_document.defaultLabel': 'Document maken',
    'automations.node.generate_document.label': 'Document maken',
    'automations.node.generate_document.desc': 'Maak een PDF of Word-bestand van tekst uit een eerdere stap',
    'automations.node.generate_document.help': 'Zet tekst die een eerdere stap heeft gemaakt om in een echt PDF- of Word-bestand, met koppen, vet en links intact. Zet er een Formulierpagina achter om het bestand als download aan te bieden. Het bestand wordt verwijderd zodra de bewaartermijn voorbij is. Onder Look stel je alleen voor dit deck de stijl, kleuren, het lettertype, een logo (of geen) en een footerregel in.',
    'automations.node.fill_document.typeLabel': 'Document invullen',
    'automations.node.fill_document.defaultLabel': 'Document invullen',
    'automations.node.fill_document.label': 'Document invullen',
    'automations.node.fill_document.desc': 'Vul een document dat je zelf hebt ontworpen en bewaar de pdf',
    'automations.node.fill_document.help': 'Neemt een document dat je in Studio → Documenten hebt ontworpen — een factuur, een offerte, een brief op je eigen briefpapier — vult de plaatsvervangers met waarden uit deze run en bewaart de pdf. Kies "Document maken" als er geen ontwerp is en de stap de tekst zelf moet opmaken.',
    'automations.node.slide.typeLabel': 'Dia',
    'automations.node.slide.defaultLabel': 'Dia',
    'automations.node.slide.label': 'Dia',
    'automations.node.slide.desc': 'Eén dia van een presentatie: een titel met opsommingen, een tabel, een citaat of een afbeelding',
    'automations.node.slide.help': 'Bouwt één dia als waarde — nog geen bestand. Geef een titel en inhoud (opsommingen, een alinea, een tabel, een citaat), eventueel sprekersnotities, en koppel ze aan eerdere stappen. Gebruik "één per item" om voor elke rij van een lijst een dia te maken, en geef de dia\'s daarna aan een Presentatie-stap. Visuals: een grafiek uit datarijen, KPI-tegels, een tijdlijn van stappen of een dia in de accentkleur.',
    'automations.node.presentation.typeLabel': 'Presentatie',
    'automations.node.presentation.defaultLabel': 'Presentatie',
    'automations.node.presentation.label': 'Presentatie',
    'automations.node.presentation.desc': 'Maak van dia\'s of een geschreven opzet een PowerPoint (of pdf-deck) in je huisstijl',
    'automations.node.presentation.help': 'Neemt dia\'s — de opzet die een AI-stap schreef ("# " titel, "## " per dia), een lijst Dia-stappen of de resultaten van een lus — en bouwt er een echt PowerPoint-bestand (of pdf-deck) van in de huisstijl van je organisatie. Zet er een Formulierpagina achter om het bestand als download aan te bieden, of een Nextcloud-upload om het te bewaren waar het in Nextcloud Office opent. Het bestand wordt verwijderd zodra de bewaartermijn voorbij is. Onder Look stel je alleen voor dit deck de stijl, kleuren, het lettertype, een logo (of geen) en een footerregel in.',
    'automations.node.parse_json.typeLabel': 'JSON uitlezen',
    'automations.node.parse_json.defaultLabel': 'JSON uitlezen',
    'automations.node.parse_json.help': 'Haalt genoemde velden uit een blok JSON-tekst. Uitgefaseerd — Gegevens bewerken doet dit nu.',
    'automations.node.code.typeLabel': 'Code',
    'automations.node.code.defaultLabel': 'Code',
    'automations.node.code.label': 'Code',
    'automations.node.code.desc': 'Eigen JavaScript uitvoeren',
    'automations.node.code.help': 'Voert een stukje JavaScript uit in een sandbox en gaat verder met wat dat teruggeeft.',

    // ── Lijsten ──
    'automations.node.limit.typeLabel': 'Lijst inkorten',
    'automations.node.limit.defaultLabel': 'Lijst inkorten',
    'automations.node.limit.label': 'Lijst inkorten',
    'automations.node.limit.desc': 'Houd alleen de eerste — of laatste — paar items over',
    'automations.node.limit.help': 'Kort een lijst in tot de eerste of laatste paar items en geeft de kortere lijst door.',
    'automations.node.dedupe.typeLabel': 'Dubbele items verwijderen',
    'automations.node.dedupe.defaultLabel': 'Dubbele items verwijderen',
    'automations.node.dedupe.label': 'Dubbele items verwijderen',
    'automations.node.dedupe.desc': 'Houd van elk er één over — op het hele item, of op één veld',
    'automations.node.dedupe.help': 'Houdt van elk item er één over en laat de herhalingen vallen. Vergelijk op één veld, of op het hele item.',
    'automations.node.aggregate.typeLabel': 'Eén veld verzamelen',
    'automations.node.aggregate.defaultLabel': 'Eén veld verzamelen',
    'automations.node.aggregate.label': 'Eén veld verzamelen',
    'automations.node.aggregate.desc': 'Neem hetzelfde veld uit elk item — elk e-mailadres bijvoorbeeld',
    'automations.node.aggregate.help': 'Leest één veld uit elk item in een lijst en geeft een gewone lijst van alleen die waarden terug.',
    'automations.node.summarize.typeLabel': 'Optellen of tellen',
    'automations.node.summarize.defaultLabel': 'Optellen of tellen',
    'automations.node.summarize.label': 'Optellen of tellen',
    'automations.node.summarize.desc': 'Totaal, aantal, gemiddelde, laagste of hoogste — over één veld',
    'automations.node.summarize.help': 'Maakt van een lijst één getal: het totaal, het aantal, het gemiddelde, of de laagste of hoogste waarde van één veld.',

    // ── Flowlets en herbruikbare Stappen ──
    'automations.node.call_layer.typeLabel': 'Flowlet',
    'automations.node.call_layer.defaultLabel': 'Flowlet',
    'automations.node.call_layer.help': 'Voert een groep stappen uit die je één keer hebt gebouwd en kunt hergebruiken, en gaat daarna verder met wat die teruggeeft.',
    'automations.node.call_block.typeLabel': 'Stap',
    'automations.node.call_block.defaultLabel': 'Stap',
    'automations.node.call_block.help': 'Voert een herbruikbare Stap uit je bibliotheek uit en gaat daarna verder met wat die teruggeeft.',
    'automations.node.layer_output.typeLabel': 'Teruggeven',
    'automations.node.layer_output.defaultLabel': 'Teruggeven',
    'automations.node.layer_output.label': 'Flowlet-uitvoer',
    'automations.node.layer_output.desc': 'Geef gegevens vanuit deze flowlet terug aan de aanroeper',
    'automations.node.layer_output.help': 'Sluit een flowlet af en geeft de velden die je noemt terug aan wat de flowlet aanriep.',

    // ── Datatabel ──
    // Landed after the rest of the catalog. This migration merges missing keys
    // on every boot, so adding them here is enough — a separate migration would
    // only split one catalog across two files.
    'automations.node.datatable.typeLabel': 'Datatabel',
    'automations.node.datatable.defaultLabel': 'Datatabel',
    'automations.node.datatable.label': 'Datatabel',
    'automations.node.datatable.desc': 'Bewaar rijen die de run overleven — en deel ze met andere automatiseringen',
    'automations.node.datatable.help': 'Leest en schrijft rijen in een tabel die blijft bestaan nadat de run klaar is, zodat deze automatisering verder kan waar hij gebleven was en andere automatiseringen dezelfde gegevens kunnen gebruiken.',

    // K10 — de tweede stap waarvan het effect de run overleeft. Bewust NIET
    // "Naar kennisbank schrijven": op de kaart staat de naam van de stap, niet
    // wat hij doet, en "Naar kennisbank" leest daar als een bestemming.
    'automations.node.knowledge_write.typeLabel': 'Naar kennisbank',
    'automations.node.knowledge_write.defaultLabel': 'Naar kennisbank',
    'automations.node.knowledge_write.label': 'Naar kennisbank',
    'automations.node.knowledge_write.desc': 'Bewaar tekst waar een agent hem later kan vinden',
    'automations.node.knowledge_write.help': 'Zet tekst in een kennisbank, zodat je agents er daarna uit kunnen antwoorden — een opgeloste ticket als artikel, de besluiten uit een vergadering, de samenvatting van vannacht. Geef er een bronverwijzing bij, dan vervangt elke run zijn eigen tekst in plaats van er weer een nieuwe achter te laten.',

    'automations.node.parallel.typeLabel': 'Parallel',
    'automations.node.parallel.defaultLabel': 'Parallel',
    'automations.node.parallel.help': 'Voert meerdere takken tegelijk uit en gaat verder zodra ze allemaal klaar zijn.',

    // ── Terug naar de app (return_to_app) ──
    // De sleutels stonden al in en.js (Track P4) maar hadden hier nog geen
    // Nederlands, waardoor de dekkingstest van deze migratie rood bleef.
    'automations.node.return_to_app.typeLabel': 'Terug naar de app',
    'automations.node.return_to_app.defaultLabel': 'Terug naar de app',
    'automations.node.return_to_app.label': 'Terug naar de app',
    'automations.node.return_to_app.desc': 'Beëindig de run en vertel de app wat er nu moet gebeuren',
    'automations.node.return_to_app.help': 'Beëindigt de run en geeft de app een bericht, een scherm om te openen en wat er vernieuwd moet worden. Niets na deze stap wordt nog uitgevoerd.',
    'automations.node.return_to_app.card_resets_form': 'maakt het formulier leeg',
    'automations.node.return_to_app.card_reloads_data': 'laadt de gegevens opnieuw',
    'automations.node.return_to_app.card_empty': 'zegt de app nog niets',
    // ── Gegevens uitlezen (data_extraction) ──
    // De stap die met naam genoemde, getypeerde velden uit tekst haalt op het
    // extractiemodel van de beheerder. Sleutels als in het gedeelde contract
    // (2026-09-12): `automations.node.` voor de kaart, `automations.ndv.extraction.`
    // voor het instellingenpaneel. "Naam" en "Type" zijn in het Nederlands
    // hetzelfde woord als in het Engels.
    'automations.node.data_extraction.typeLabel': 'Gegevens uitlezen',
    'automations.node.data_extraction.defaultLabel': 'Gegevens uitlezen',
    'automations.node.data_extraction.label': 'Gegevens uitlezen',
    'automations.node.data_extraction.desc': 'Haal met naam genoemde velden uit tekst — een factuur, een e-mail, een pdf',
    'automations.node.data_extraction.help': 'Leest één stuk tekst — een pdf die je eerder hebt gelezen, de tekst van een e-mail, een pagina — en geeft precies de velden terug die je noemt, als tekst, getal, ja/nee of datum. Draait altijd op het extractiemodel dat je beheerder heeft ingesteld, niet op de chat-tier van de automatisering, met denken uit en een vaste antwoordvorm. Een veld dat niet gevonden wordt blijft leeg, en wordt nooit verzonnen. Zet de stap na een stap die de tekst maakt; een stap erna kan elk veld op naam binden.',
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
