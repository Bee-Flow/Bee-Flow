/**
 * Nederlandse tekst van de koppelingspagina's voor Google Workspace en Microsoft 365 (zie index.mts).
 */

import type { Prose } from '../types.mts';
import { GOOGLE_CONNECT, MS_CONNECT, PREVIEW, MS_PUSH } from './shared.mts';

export const WORKSPACE: Record<string, Prose> = {
    gmail: {
        title: 'Gmail-koppeling: zoeken, antwoorden, sorteren',
        description: 'Een Bee Flow-assistent zoekt en leest in Gmail, schrijft concepten en antwoorden en sorteert mail met labels. Automatiseringen starten op nieuwe mail.',
        summary: 'Mail zoeken en lezen, concepten en antwoorden schrijven, sorteren met labels.',
        intro: ['Met de Gmail-koppeling werkt een assistent in je eigen mailbox. Hij zoekt met dezelfde zoektaal als Gmail zelf, leest berichten en de tekst van bijlagen, schrijft concepten en antwoorden en houdt je inbox op orde met labels.'],
        groups: {
            find: 'Zoeken met de zoektaal van Gmail, één bericht of tot 100 tegelijk lezen, en de tekst van bijlagen lezen: PDF, Word, Excel, CSV en afbeeldingen via tekstherkenning.',
            write: 'Een nieuw bericht of een antwoord schrijven. In een chat zie je eerst een voorbeeld met Versturen, Opslaan als concept en Weggooien. Een concept komt in Concepten, zodat je het zelf verstuurt. Direct antwoorden in dezelfde thread kan alleen in een run die door een nieuwe e-mail is gestart.',
            sort: 'Labels opvragen, toevoegen en weghalen, mail als gelezen of ongelezen markeren, archiveren of naar de prullenbak verplaatsen (dat is terug te draaien). In een automatisering gaan tot 1.000 berichten in één verzoek.',
        },
        connect: [GOOGLE_CONNECT],
        limits: [
            'De quota van Google gelden per mailbox. Meldt Google een limiet, dan wacht Bee Flow en probeert het opnieuw; een verzoek dat mail verstuurt wordt nooit herhaald.',
            'De inhoud van berichten en bijlagen gaat door het Privacy Shield voordat het model hem ziet.',
        ],
        examples: ['Zoek de facturen van vorige week en zet de bedragen op een rij.', 'Schrijf een conceptantwoord op het laatste bericht van deze afzender.', 'Geef alle nieuwsbrieven van deze maand een label en archiveer ze.'],
    },
    'google-calendar': {
        title: 'Google Agenda-koppeling voor AI-assistenten',
        description: 'Een Bee Flow-assistent leest je Google Agenda, vindt afspraken en maakt, verzet of schrapt ze na jouw akkoord. Automatiseringen starten op wijzigingen.',
        summary: 'Afspraken bekijken en zoeken; aanmaken, wijzigen en schrappen na akkoord.',
        name: 'Google Agenda',
        intro: ['Met de koppeling met Google Agenda beantwoordt een assistent vragen over je planning en plant hij voor je. Hij zet de komende dagen op een rij, vindt een afspraak op een woord uit de titel of beschrijving en bereidt nieuwe afspraken en wijzigingen voor.'],
        groups: {
            read: 'Komende afspraken bekijken (standaard de komende zeven dagen) en afspraken zoeken op een woord in titel of beschrijving.',
            change: `Afspraken aanmaken, wijzigen en verwijderen. ${PREVIEW}`,
        },
        connect: [GOOGLE_CONNECT],
        limits: ['De assistent werkt alleen in de agenda\'s van het gekoppelde account.', 'Beschrijvingen van afspraken gaan door het Privacy Shield.'],
        examples: ['Wat staat er donderdag in mijn agenda?', 'Verzet het projectoverleg naar vrijdag 10.00 uur.'],
    },
    'google-drive': {
        title: 'Google Drive-koppeling: bestanden vinden',
        description: 'Een Bee Flow-assistent zoekt in Google Drive, leest Docs, Sheets, PDF\'s en tekstbestanden, en zet bestanden in de juiste map.',
        summary: 'Bestanden zoeken en lezen, uploaden, verplaatsen, mappen maken.',
        intro: ['Met Google Drive gekoppeld vindt een assistent bestanden op naam, type of datum, leest hij de inhoud en zet hij nieuwe bestanden op de juiste plek. Google Docs leest hij als tekst en Google Sheets als CSV, zodat het model er direct mee werkt.'],
        groups: {
            find: 'Zoeken met de zoekopties van Drive, een map bekijken, zien wat er sinds een datum is gewijzigd, en de details van een bestand lezen, zoals grootte en delen.',
            read: 'De tekst lezen van een Google Doc, een Google Sheet (als CSV), een PDF of een tekstbestand.',
            organise: 'Een bestand naar een andere map verplaatsen, mappen maken en bestanden uploaden, bijvoorbeeld een bijlage uit een e-mail.',
        },
        connect: [GOOGLE_CONNECT],
        limits: ['De inhoud van bestanden gaat door het Privacy Shield voordat het model hem ziet.', 'Een spreadsheet in Drive kun je in Bee Flow ook als live datatabel koppelen.'],
        examples: ['Zoek de nieuwste prijslijst en vat hem samen.', 'Bewaar deze bijlage in de map Contracten.'],
    },
    'google-slides': {
        title: 'Google Slides-koppeling: decks lezen en vullen',
        description: 'Een Bee Flow-assistent leest presentaties in Google Slides, vult sjablonen door tijdelijke tekst te vervangen, maakt lege decks en zet ze om naar PDF.',
        summary: 'Decks lezen, sjablonen vullen, decks maken, omzetten naar PDF.',
        intro: ['De koppeling met Google Slides leest de tekst van elke dia en vult sjablonen. Een deck met tijdelijke tekst zoals {{NAAM}} wordt in één stap een afgemaakt deck.'],
        groups: {
            read: 'De presentaties opvragen die je mag openen en een deck dia voor dia lezen, voor een samenvatting of als invoer voor een AI-stap.',
            make: 'Een nieuwe lege presentatie maken en tekst in het hele deck vervangen.',
            export: 'Een presentatie als PDF klaarzetten om te downloaden.',
        },
        connect: [GOOGLE_CONNECT],
        limits: ['Dia\'s worden als tekst gelezen: afbeeldingen en opmaak worden niet beschreven.'],
    },
    'google-sheets': {
        title: 'Google Sheets-koppeling: lezen en aanvullen',
        description: 'Een Bee Flow-assistent leest bereiken in Google Sheets, voegt rijen toe, past cellen aan en maakt spreadsheets. Automatiseringen starten op wijzigingen.',
        summary: 'Bereiken lezen, rijen toevoegen, cellen bijwerken, spreadsheets maken.',
        intro: ['Met Google Sheets gekoppeld leest een assistent een tabblad of bereik, zet hij rijen onderaan en werkt hij cellen bij. Automatiseringen gebruiken het om resultaten bij te houden of nieuwe rijen op te pakken.'],
        groups: {
            read: 'Een spreadsheet zoeken, de tabbladen opvragen en een bereik lezen als rijen en kolommen.',
            write: 'Rijen toevoegen, een bereik overschrijven en een nieuwe spreadsheet maken, eventueel met tabbladen.',
        },
        connect: [GOOGLE_CONNECT],
        limits: ['Een spreadsheet kun je in Bee Flow ook als live datatabel koppelen.'],
        examples: ['Zet een rij met de cijfers van vandaag in het weekrapport.', 'Welke rijen op het tabblad Leads hebben nog geen eigenaar?'],
    },
    'google-docs': {
        title: 'Google Docs-koppeling: lezen en schrijven',
        description: 'Een Bee Flow-assistent leest Google Docs, ook met tabbladen, maakt nieuwe documenten, voegt tekst toe en vult sjablonen met zoeken en vervangen.',
        summary: 'Documenten lezen, nieuwe maken, tekst toevoegen, sjablonen vullen.',
        intro: ['De koppeling met Google Docs leest de tekst van een document, alle tabbladen inbegrepen, en schrijft erin. Door tijdelijke tekst te vervangen vul je eenvoudig een sjabloon.'],
        groups: {
            read: 'De tekst van een document lezen; een document met tabbladen komt per tabblad terug, of één tabblad op naam.',
            write: 'Een document maken, tekst aan het eind toevoegen, en tekst zoeken en vervangen.',
        },
        connect: [GOOGLE_CONNECT],
        limits: ['Alleen tekst: opmaak en afbeeldingen worden niet gelezen.', 'De inhoud gaat door het Privacy Shield.'],
    },
    'google-contacts': {
        title: 'Google Contacten-koppeling voor AI-assistenten',
        description: 'Een Bee Flow-assistent zoekt in je Google Contacten op naam, e-mail of telefoon en maakt of wijzigt contacten na jouw akkoord.',
        summary: 'Contacten zoeken en bekijken; aanmaken en wijzigen na akkoord.',
        name: 'Google Contacten',
        intro: ['Met Google Contacten gekoppeld zoekt een assistent iemand op naam, e-mailadres of telefoonnummer op en houdt hij gegevens actueel.'],
        groups: {
            find: 'Contacten zoeken op naam, e-mail of telefoon, en ze op naam gesorteerd opvragen.',
            change: `Een contact aanmaken of wijzigen. ${PREVIEW}`,
        },
        connect: [GOOGLE_CONNECT],
        limits: ['Contactgegevens vervangt het Privacy Shield door plaatshouders voordat het model ze ziet.'],
    },
    'google-keep': {
        title: 'Google Keep-koppeling: notities en lijstjes',
        description: 'Een Bee Flow-assistent leest je notities in Google Keep en maakt notities of afvinklijsten na jouw akkoord. Automatiseringen starten op nieuwe notities.',
        summary: 'Notities lezen; tekstnotities en afvinklijsten maken, notities verwijderen.',
        intro: ['Met de koppeling met Google Keep leest een assistent je notities en maakt hij nieuwe, als gewone tekst of als afvinklijst.'],
        groups: {
            read: 'Notities opvragen met een stukje van de inhoud, en een notitie helemaal lezen.',
            change: `Een tekstnotitie of afvinklijst maken, en een notitie naar de prullenbak verplaatsen. ${PREVIEW}`,
        },
        connect: [GOOGLE_CONNECT],
        limits: ['Alleen notities: herinneringen horen niet bij Keep.'],
    },
    'google-groups': {
        title: 'Google Groups-koppeling: lezen en antwoorden',
        description: 'Een Bee Flow-assistent leest de gesprekken van een Google Group via je Gmail en schrijft antwoorden aan de groep die je eerst nakijkt.',
        summary: 'Groepsgesprekken lezen en de groep antwoorden na controle.',
        intro: ['De koppeling met Google Groups leest de gesprekken van een groep uit de berichten in je eigen Gmail, en kan in de thread antwoorden zodat elk lid het ziet.'],
        groups: {
            read: 'Recente gesprekken van een groep opvragen, gefilterd op trefwoorden, en een hele thread op volgorde lezen.',
            reply: 'Op een gesprek antwoorden via het adres van de groep. Je ziet eerst een voorbeeld met Versturen, Opslaan als concept en Weggooien.',
        },
        connect: [GOOGLE_CONNECT],
        limits: ['Je ziet alleen de groepsmail die in je eigen mailbox is binnengekomen.'],
    },
    maps: {
        title: 'Google Maps-koppeling: plaatsen en routes',
        description: 'Een Bee Flow-assistent zoekt in Google Maps naar plaatsen bij een locatie en plant routes met reistijd, afstand en een kaartlink.',
        summary: 'Plaatsen in de buurt vinden en een route plannen met reistijd.',
        intro: ['Met Google Maps vindt een assistent bedrijven en plekken bij een locatie en zoekt hij uit hoe je van A naar B komt.'],
        groups: {
            places: 'Plaatsen bij een locatie zoeken, met adres, beoordeling en een kaartlink.',
            route: 'Een route stap voor stap, met totale reistijd, afstand en een kaart van de route.',
        },
        connect: ['Een beheerder stelt één Google Maps API-sleutel in voor de hele server. Je koppelt geen eigen account.'],
        limits: ['Google brengt elke aanroep in rekening bij de eigenaar van de sleutel.'],
        examples: ['Hoe lang doe ik om 17.00 uur over de rit van kantoor naar het station?'],
    },
    outlook: {
        title: 'Outlook-koppeling: mail lezen en versturen',
        description: 'Een Bee Flow-assistent zoekt en leest Outlook-mail, schrijft concepten en verstuurt mail. Automatiseringen starten op nieuwe of gemarkeerde mail.',
        summary: 'Mail zoeken en lezen, concepten schrijven, mail en antwoorden versturen.',
        intro: ['De Outlook-koppeling geeft een assistent toegang tot je Microsoft 365-mailbox: zoeken met trefwoorden of KQL, veel berichten tegelijk lezen, concepten opslaan en mail versturen.'],
        groups: {
            find: 'In de mailbox zoeken, de nieuwste berichten opvragen en één bericht of tot 100 tegelijk lezen.',
            write: 'Een concept opslaan dat je zelf verstuurt, of een nieuw bericht of antwoord versturen. In een chat zie je eerst een voorbeeld met Versturen en Weggooien; in een run zonder toezicht, zoals een automatisering, gaat het bericht direct weg. Antwoorden in hetzelfde gesprek kan alleen in een run die door een nieuwe e-mail is gestart.',
        },
        connect: [MS_CONNECT],
        limits: [
            'Remt Microsoft een verzoek af, dan wacht Bee Flow zo lang als Microsoft vraagt en probeert het opnieuw. Een verzoek dat mail verstuurt wordt na een serverfout niet herhaald.',
            MS_PUSH,
        ],
        examples: ['Welke mails van deze week moet ik nog beantwoorden?', 'Schrijf een conceptantwoord dat de afspraak bevestigt.'],
    },
    'outlook-readonly': {
        title: 'Outlook-koppeling die alleen leest',
        description: 'Een Outlook-koppeling die alleen leest: de Bee Flow-assistent zoekt en leest mail, maar kan niets schrijven, versturen of wijzigen in de mailbox.',
        summary: 'Outlook-mail zoeken en lezen. Er wordt niets geschreven of verstuurd.',
        name: 'Outlook (alleen lezen)',
        intro: ['Deze variant van de Outlook-koppeling leest alleen. Hij is er voor organisaties die naast of in plaats van de volledige koppeling een mailboxverbinding willen die echt alleen leest.'],
        groups: {
            find: 'In de mailbox zoeken, de nieuwste berichten opvragen en één bericht of tot 100 tegelijk lezen.',
        },
        connect: [MS_CONNECT],
        limits: ['Alleen lezen: er is geen tool om mail te schrijven, te versturen, te verplaatsen of te verwijderen.'],
    },
    'ms-calendar': {
        title: 'Outlook-agenda-koppeling voor AI-assistenten',
        description: 'Een Bee Flow-assistent leest je Microsoft 365-agenda, vindt afspraken op onderwerp en maakt, wijzigt of verwijdert afspraken na een voorbeeld.',
        summary: 'Afspraken bekijken en zoeken; aanmaken, wijzigen en verwijderen na een voorbeeld.',
        name: 'Microsoft 365-agenda',
        intro: ['De koppeling met de Microsoft 365-agenda beantwoordt vragen over je Outlook-agenda en plant voor je: hij laat zien wat eraan komt, vindt afspraken op onderwerp of inhoud en bereidt nieuwe afspraken en wijzigingen voor.'],
        groups: {
            read: 'Afspraken bekijken van nu tot een aantal dagen vooruit, en afspraken zoeken op onderwerp of inhoud.',
            change: 'Afspraken aanmaken, wijzigen en verwijderen. Je ziet eerst een voorbeeld van een nieuwe afspraak of wijziging, en bevestigt een verwijdering.',
        },
        connect: [MS_CONNECT],
        limits: [MS_PUSH],
    },
    onedrive: {
        title: 'OneDrive-koppeling: bestanden en mappen vinden',
        description: 'Een Bee Flow-assistent zoekt in je OneDrive op naam of inhoud, bekijkt mappen en wijzigingen en maakt mappen. Automatiseringen starten op nieuwe bestanden.',
        summary: 'Bestanden zoeken, mappen en recente wijzigingen bekijken, mappen maken.',
        intro: ['Met OneDrive gekoppeld vindt een assistent bestanden op naam of inhoud, laat hij zien wat er onlangs is gewijzigd en houdt hij mappen op orde.'],
        groups: {
            find: 'Bestanden zoeken, een map bekijken, zien wat er sinds een datum is gewijzigd en de details van een bestand lezen, zoals grootte en delen.',
            organise: 'Een map maken.',
        },
        connect: [MS_CONNECT],
        limits: [MS_PUSH, 'Een Excel- of CSV-bestand in OneDrive kun je in Bee Flow ook als live datatabel koppelen.'],
    },
    'ms-contacts': {
        title: 'Microsoft-contacten-koppeling voor assistenten',
        description: 'Een Bee Flow-assistent zoekt in je Microsoft 365-contacten op naam of e-mail en maakt of wijzigt contacten na een voorbeeld.',
        summary: 'Contacten zoeken en bekijken; aanmaken en wijzigen na een voorbeeld.',
        name: 'Microsoft 365-contacten',
        intro: ['De koppeling met de Microsoft 365-contacten zoekt mensen op in je Outlook-contacten en houdt hun gegevens actueel.'],
        groups: {
            find: 'Contacten zoeken op naam of e-mailadres, en ze opvragen met e-mail, telefoon en bedrijf.',
            change: 'Een contact aanmaken of wijzigen. Je ziet eerst een voorbeeld voordat er iets wordt opgeslagen.',
        },
        connect: [MS_CONNECT],
        limits: ['Contactgegevens gaan door het Privacy Shield.'],
    },
};
