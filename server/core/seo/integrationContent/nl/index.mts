/**
 * nl/index.mts: de Nederlandse tekst van de openbare koppelingspagina's: de
 * vaste woorden hieronder, de tekst per koppeling in workspace.mts,
 * services.mts en nextcloud.mts.
 *
 * Dezelfde feiten als en/, uit dezelfde bronnen, in de je-vorm. De lijsten
 * met tools en gebeurtenissen staan hier niet: die haalt de pagina bij het
 * renderen uit de catalogi (facts.mts). Wel staan hier de Nederlandse namen van
 * de gebeurtenissen, want het register kent alleen Engelse.
 */

import type { LocaleContent } from '../types.mts';
import { WORKSPACE } from './workspace.mts';
import { SERVICES } from './services.mts';
import { NEXTCLOUD } from './nextcloud.mts';

const EVENT_LABELS: Record<string, string> = {
    'gmail:mail.new': 'Nieuwe e-mail',
    'gmail:label.added': 'Label toegevoegd',
    'google-calendar:event.changed': 'Afspraak gewijzigd',
    'google-calendar:event.upcoming': 'Afspraak komt eraan (een ingestelde tijd voor de start)',
    'google-drive:file.new': 'Nieuw bestand',
    'google-sheets:spreadsheet.changed': 'Spreadsheet bewerkt',
    'google-sheets:spreadsheet.new': 'Nieuwe spreadsheet',
    'google-slides:presentation.changed': 'Presentatie bewerkt',
    'google-slides:presentation.new': 'Nieuwe presentatie',
    'google-contacts:contact.new': 'Nieuw contact',
    'google-contacts:contact.changed': 'Contactgegevens gewijzigd',
    'google-keep:note.new': 'Nieuwe notitie',
    'google-keep:note.changed': 'Notitie bewerkt',
    'nextcloud:file.new': 'Nieuw bestand',
    'nextcloud:file.changed': 'Bestand gewijzigd',
    'nextcloud:file.deleted': 'Bestand verwijderd',
    'nextcloud:file.renamed': 'Bestand hernoemd',
    'nextcloud:file.tagged': 'Tag aan een bestand toegekend',
    'nextcloud:share.received': 'Gedeeld item ontvangen',
    'nextcloud:share.created': 'Item gedeeld',
    'nextcloud:activity.new': 'Elke activiteit (geavanceerd)',
    'nextcloud:notification.new': 'Melding ontvangen',
    'nextcloud:calendar.event.upcoming': 'Afspraak komt eraan (een ingestelde tijd voor de start)',
    'nextcloud:calendar.event.created': 'Afspraak aangemaakt',
    'nextcloud:calendar.event.changed': 'Afspraak gewijzigd',
    'nextcloud:deck.card.created': 'Deck-kaart aangemaakt',
    'nextcloud:deck.card.changed': 'Deck-kaart gewijzigd',
    'nextcloud:deck.card.deleted': 'Deck-kaart verwijderd',
    'nextcloud:deck.card.moved': 'Deck-kaart naar een andere lijst verplaatst',
    'nextcloud:deck.card.completed': 'Deck-kaart als klaar gemarkeerd',
    'nextcloud:forms.submitted': 'Formulier ingevuld (Nextcloud Forms)',
    'nextcloud:tables.row.added': 'Rij toegevoegd aan een Nextcloud-tabel',
    'nextcloud:tables.row.updated': 'Rij gewijzigd in een Nextcloud-tabel',
    'nextcloud:talk.message.received': 'Talk-bericht ontvangen',
    'nextcloud:talk.reaction.added': 'Reactie in Talk toegevoegd',
    'msgraph:mail.new': 'Nieuwe e-mail (Outlook)',
    'msgraph:mail.flagged': 'E-mail gemarkeerd',
    'msgraph:event.created': 'Afspraak aangemaakt',
    'msgraph:event.changed': 'Afspraak gewijzigd',
    'msgraph:file.new': 'Nieuw OneDrive-bestand',
    'msgraph:file.changed': 'OneDrive-bestand gewijzigd',
    'scaleway-billing:invoice.new': 'Nieuwe Scaleway-factuur',
};

export const NL: LocaleContent = {
    locale: 'nl',
    ui: {
        navIntegrations: 'Integraties',
        navDirectory: 'Overzicht',
        navBlog: 'Blog',
        directoryTitle: 'Overzicht van alle koppelingen',
        directoryHeading: 'Koppelingen',
        directoryLead: 'Elke koppeling op deze pagina zit in het product, met echte tools erachter, en is per gebruiker, per organisatie en per groep aan te zetten.',
        directoryDescription: 'Bekijk de {count} koppelingen van Bee Flow: Google Workspace, Microsoft 365, Nextcloud en meer.',
        searchLabel: 'Zoek een koppeling',
        categoryLabel: 'Categorie',
        allCategories: 'Alle categorieën',
        searchButton: 'Zoeken',
        countLine: '{shown} van {total} koppelingen',
        clearFilters: 'Filters wissen',
        noMatch: 'Geen koppeling gevonden. Probeer een kortere zoekterm.',
        breadcrumbDirectory: 'Overzicht van koppelingen',
        canDo: 'Wat een assistent ermee kan',
        toolsLabel: 'Tools',
        otherTools: 'Andere tools in deze koppeling',
        effect: { reads: 'leest', writes: 'wijzigt', sends: 'verstuurt' },
        access: 'Lezen of schrijven',
        accessText: {
            reads: 'Alleen lezen: geen van deze tools wijzigt iets.',
            writes: 'Deze tools lezen en wijzigen gegevens. De regels met "wijzigt" zijn de regels die iets veranderen.',
            sends: 'Deze tools lezen en wijzigen gegevens, en een deel verstuurt iets naar anderen, zoals mail, berichten of uitnodigingen. Die regels zijn gemarkeerd met "verstuurt".',
        },
        events: 'Gebeurtenissen die een automatisering kunnen starten',
        eventsNone: 'Deze koppeling heeft geen eigen gebeurtenissen voor automatiseringen.',
        eventsConnector: 'Gebeurtenissen met een * komen binnen via de Nextcloud-connector; zonder connector gaan ze niet af.',
        eventsPublicUrl: 'Microsoft stuurt deze gebeurtenissen zelf door, dus de Bee Flow-server moet vanaf internet bereikbaar zijn.',
        connect: 'Zo koppel je het',
        gate: 'Een beheerder bepaalt wie het mag gebruiken: koppelingen gaan per gebruiker, per organisatie en per groep aan, en agents en automatiseringen roepen deze tools alleen voor die mensen aan.',
        limits: 'Grenzen',
        examples: 'Wat je kunt vragen',
        related: 'Verwante koppelingen',
        moreIn: 'Meer in {category}',
        browseAll: 'Bekijk alle koppelingen',
        overview: 'Overzicht integraties',
        deployment: 'Hosting en installatie',
        plans: 'Abonnementen',
    },
    prose: { ...WORKSPACE, ...SERVICES, ...NEXTCLOUD },
    eventLabels: EVENT_LABELS,
    categories: {
        'AI & Media': 'AI en media',
        Productivity: 'Productiviteit',
        Developer: 'Ontwikkelaars',
        Automation: 'Automatisering',
        Social: 'Sociale media',
        Health: 'Gezondheid',
    },
};
