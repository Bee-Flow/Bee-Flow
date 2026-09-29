/**
 * The words the Playbook ENGINE itself writes — the phase summaries the
 * handoff card shows, the descriptions of the things it creates, and the
 * language it asks the designer and the two builders to speak.
 *
 * A playbook remembers the interface language it was started in
 * (`options.locale`). Everything the server puts in front of the person then
 * follows that language: we ship copy for Dutch and English, and any other
 * interface language reads the English copy while the MODEL-facing prompts
 * still name that language (`languageName`), so a design or an AI-written
 * recipe comes back in it.
 *
 * Why here and not in the i18n catalogues: a summary is one sentence with
 * numbers in it that the server composes while a phase lands, stores on the
 * phase and hands back as data — it never passes a `t()` in the browser.
 */

'use strict';

// Where a mirrored table's rows live, by the registry's builder kind
// (core/dataEngine/sources.builderKindOf): the summary names the source, and
// a kind this map does not know is still called a mirror, never Nextcloud.
const MIRROR_WORD = { nextcloud: 'Nextcloud', spreadsheet: 'spreadsheet' };

// The interface languages the product ships words for; everything else
// reads English (`packLocale`).
const PACK_LOCALES = Object.freeze(['nl', 'en']);

const LANGUAGE_NAMES = Object.freeze({
    nl: 'Dutch', en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian',
    pt: 'Portuguese', pl: 'Polish', da: 'Danish', sv: 'Swedish', nb: 'Norwegian', no: 'Norwegian',
    fi: 'Finnish', tr: 'Turkish', cs: 'Czech', ro: 'Romanian', el: 'Greek', hu: 'Hungarian',
});

/** 'nl-NL' → 'nl'; anything that is not a language code → `fallback`. */
function normaliseLocale(value, fallback = 'nl') {
    const raw = String(value == null ? '' : value).trim().toLowerCase().replace('_', '-');
    const code = raw.split('-')[0];
    return /^[a-z]{2}$/.test(code) ? code : fallback;
}

/** The language a model prompt asks for, by name. */
function languageName(locale) {
    return LANGUAGE_NAMES[normaliseLocale(locale, 'en')] || 'English';
}

/** The locale whose COPY pack is used — Dutch or English. */
function packLocale(locale) {
    const code = normaliseLocale(locale, 'nl');
    return PACK_LOCALES.includes(code) ? code : 'en';
}

const COPY = Object.freeze({
    nl: Object.freeze({
        tableCreated: (name, columns) => `Tabel "${name}" aangemaakt met ${columns} kolommen.`,
        tableVerified: (name, columns, { isMirror = false, mirrorKind = null, hasStatus = true } = {}) => `Tabel "${name}" gecontroleerd: ${columns} kolommen herkend${isMirror ? ` (${MIRROR_WORD[mirrorKind] ? `${MIRROR_WORD[mirrorKind]}-spiegel` : 'spiegel van een externe bron'})` : ''}${hasStatus ? '' : ', geen statuskolom'}.`,
        tableDescription: (title) => `${title} die de Playbook-automatisering ophaalt en bijhoudt`,
        rowsAdded: (added, rowCount) => `${added == null ? 'Rijen' : `${added} rijen`} toegevoegd aan de tabel${rowCount == null ? '' : ` (nu ${rowCount})`}.`,
        designSummary: (name, screens, elements, preset) => `Ontwerp "${name}": ${screens} scherm${screens === 1 ? '' : 'en'}, ${elements} elementen, look ${preset}.`,
        designConstrained: (screens) => `Teruggebracht tot ${screens} scherm${screens === 1 ? '' : 'en'}, zoals gevraagd.`,
        runFailed: (status) => `De automatisering eindigde met status "${status}".`,
        runNeverStarted: 'De automatisering is niet gestart — er is nooit een run aangemaakt.',
        runTimedOut: 'De run was niet binnen 15 minuten klaar.',
        screenFallback: 'Scherm',
        appDescription: 'Gebouwd door een Studio-playbook',
        skippedNoStatus: 'Overgeslagen: de tabel heeft geen statuskolom om een goedkeuring in vast te leggen.',
        skippedNoColumn: (role) => `Overgeslagen: de tabel heeft geen kolom "${role}".`,
        skippedNoApp: 'Overgeslagen: dit playbook heeft geen app gebouwd om toegang op te geven.',
        // ── what the RULES say, in the demo's language ──────────────────
        // staticFindings took no locale, so the half of the verdict with a fact
        // behind it was always English — beside AI findings the model wrote in
        // Dutch. In front of an EU audience that is the most visible defect the
        // phase had (owner, 2026-09-17).
        finding: Object.freeze({
            seenValues: 'de waarden erin zijn gescand en bevatten persoonsgegevens',
            seenNames: 'hun namen lezen als persoonsgegevens',
            subjectApp: (n) => `App "${n}"`,
            subjectAutomation: (n) => `Automatisering "${n}"`,
            subjectTable: (n) => `Tabel "${n}"`,
            orgWide: {
                title: 'Persoonsgegevens staan open voor de hele organisatie',
                why: (names, seen) => `De tabel bevat ${names} — ${seen} — en iedereen in de organisatie kan de app openen, zonder rol die beperkt wat zij zien.`,
                fix: 'Deel de app met de groepen die hem nodig hebben, of geef een rol een rijregel zodat iedereen alleen zijn eigen rijen ziet.',
            },
            publicPage: {
                title: 'Een openbare pagina op een app met persoonsgegevens',
                why: (n, names) => `${n} pagina${n === 1 ? '' : "'s"} van deze app ${n === 1 ? 'is' : 'zijn'} zonder inloggen te openen, en de tabel erachter bevat ${names}.`,
                fix: 'Kijk na wat die pagina toont, of haal hem van de openbare link af.',
            },
            outbound: {
                title: 'Persoonsgegevens verlaten de werkruimte',
                why: (dests, names) => `Hij stuurt gegevens naar buiten (${dests}) uit een tabel die ${names} bevat.`,
                fix: 'Controleer wie het ontvangt en of dat mag — en stuur alleen de velden die zij nodig hebben.',
            },
            aiNoGuard: {
                title: 'Een model leest de gegevens zonder privacycontrole ervoor',
                why: (steps) => `${steps} lezen de inhoud, en er zit geen Privacy Shield-stap in deze automatisering.`,
                fix: 'Zet er een Privacy Shield-stap voor (controleren, of controleren + verbergen), of houd de persoonsvelden buiten wat het model leest.',
            },
            aiaDisclosure: {
                title: 'Mensen wordt niet verteld dat de inhoud door AI is gemaakt',
                why: 'Deze automatisering maakt inhoud die rechtstreeks bij mensen terechtkomt, en er is geen vermelding gevonden in wat zij lezen.',
                fix: 'Zeg in de tekst zelf dat hij met AI is gemaakt, of zet markering aan voor deze automatisering.',
            },
            aiaAnnexIii: {
                title: 'De Bijlage III-vragen zijn hier nog niet beantwoord',
                why: (cats) => `De bewoording raakt ${cats || 'een Annex III-gebied'}. Bewoording is een aanwijzing, geen kwalificatie — of dit hoog risico is, beslissen de tien Bijlage III-vragen, en die staan nog open.`,
                fix: 'Beantwoord ze in Compliance → AI Act. Elk antwoord noemt het punt van Bijlage III dat het afdoet, en "geen hoog risico" vraagt alle tien.',
                area: 'een Annex III-gebied',
            },
            mirror: {
                title: 'Persoonsgegevens worden gespiegeld naar Nextcloud',
                why: 'Rijen die hier worden geschreven gaan door naar een Nextcloud-tabel, dus dezelfde persoonsgegevens staan op twee plekken.',
                fix: 'Leg beide plekken vast in het verwerkingsregister (ROPA), en houd hun bewaartermijn gelijk.',
            },
            ropa: {
                title: (missing) => `Voor deze tabel is ${missing} niet vastgelegd`,
                why: (names, unsaid) => `Hij bevat persoonsgegevens (${names}) en nergens staat ${unsaid}.`,
                fix: 'Leg hem hieronder vast — dat vult het verwerkingsregister en zet het opruimen op bewaartermijn aan.',
                missingBasis: 'een grondslag',
                missingDays: 'een bewaartermijn',
                missingField: 'een datum om de bewaartermijn vanaf te tellen',
                unsaidBasis: 'waarom je het mag bewaren',
                unsaidDays: 'hoe lang',
                unsaidField: (days) => `vanaf wanneer die ${days} dagen lopen`,
                and: ' en ',
                or: ' of ',
            },
            isoRoles: {
                title: 'De toegang is gedeeld maar niemand heeft een rol',
                why: 'De app staat open voor anderen terwijl iedereen op de standaardrol terugvalt.',
                fix: 'Geef in elk geval de mensen die hem beheren een benoemde rol, zodat toegangsbeheer aantoonbaar is.',
            },
        }),
        // The phases and names the server adds to a recipe an AI wrote.
        tablePhaseLabel: 'Tabel',
        fillPhaseLabel: 'Eerste rijen',
        designPhaseLabel: 'Ontwerp',
        accessPhaseLabel: 'Toegang',
        compliancePhaseLabel: 'Compliance-check',
        complianceSummary: (n, high, fw) => (n === 0
            ? `Niets gevonden tegen ${fw} kader${fw === 1 ? '' : 's'}.`
            : `${n} punt${n === 1 ? '' : 'en'} om naar te kijken${high ? `, waarvan ${high} belangrijk` : ''}.`),
        accessSummary: (who, people) => `Gedeeld met ${who}${people ? ` · ${people}` : ''}.`,
        accessNobody: 'niemand — alleen jij',
        accessEveryone: 'de hele organisatie',
        accessGroups: (n) => `${n} ${n === 1 ? 'groep' : 'groepen'}`,
        accessPeople: (n) => `${n} ${n === 1 ? 'persoon' : 'personen'} met een rol`,
        columnFallback: (n) => `Kolom ${n}`,
        phaseFallback: (n) => `Fase ${n}`,
        inputFallback: (n) => `Invoer ${n}`,
        documentsFolder: 'documenten',
    }),
    en: Object.freeze({
        tableCreated: (name, columns) => `Table "${name}" created with ${columns} columns.`,
        tableVerified: (name, columns, { isMirror = false, mirrorKind = null, hasStatus = true } = {}) => `Table "${name}" checked: ${columns} columns recognised${isMirror ? ` (${MIRROR_WORD[mirrorKind] ? `${MIRROR_WORD[mirrorKind]} mirror` : 'mirror of an external source'})` : ''}${hasStatus ? '' : ', no status column'}.`,
        tableDescription: (title) => `${title} the Playbook automation reads in and keeps up to date`,
        rowsAdded: (added, rowCount) => `${added == null ? 'Rows' : `${added} row${added === 1 ? '' : 's'}`} added to the table${rowCount == null ? '' : ` (${rowCount} now)`}.`,
        designSummary: (name, screens, elements, preset) => `Design "${name}": ${screens} screen${screens === 1 ? '' : 's'}, ${elements} elements, look ${preset}.`,
        designConstrained: (screens) => `Reduced to ${screens} screen${screens === 1 ? '' : 's'}, as asked.`,
        runFailed: (status) => `The automation ended with status "${status}".`,
        runNeverStarted: 'The automation did not start — no run was ever created.',
        runTimedOut: 'The run did not finish within 15 minutes.',
        screenFallback: 'Screen',
        appDescription: 'Built by a Studio playbook',
        skippedNoStatus: 'Skipped: the table has no status column to record an approval in.',
        skippedNoColumn: (role) => `Skipped: the table has no "${role}" column.`,
        skippedNoApp: 'Skipped: this playbook built no app to give access to.',
        // ── what the RULES say, in the demo's language ──────────────────
        finding: Object.freeze({
            seenValues: 'the values in them were scanned and hold personal data',
            seenNames: 'their names read as personal data',
            subjectApp: (n) => `App "${n}"`,
            subjectAutomation: (n) => `Automation "${n}"`,
            subjectTable: (n) => `Table "${n}"`,
            orgWide: {
                title: 'Personal data is open to the whole organisation',
                why: (names, seen) => `The table holds ${names} — ${seen} — and everyone in the organisation can open the app, with no role narrowing what they see.`,
                fix: 'Share the app with the groups that need it, or give a role a row rule so each person sees only their own rows.',
            },
            publicPage: {
                title: 'A public page on an app holding personal data',
                why: (n, names) => `${n} page${n === 1 ? '' : 's'} of this app can be opened without signing in, and the table behind it holds ${names}.`,
                fix: 'Check what that page shows, or take it off the public link.',
            },
            outbound: {
                title: 'Personal data leaves the workspace',
                why: (dests, names) => `It sends data out (${dests}) from a table that holds ${names}.`,
                fix: 'Check who receives it and that the receiver is allowed to — and send only the fields they need.',
            },
            aiNoGuard: {
                title: 'A model reads the data with no privacy check in front of it',
                why: (steps) => `${steps} read(s) the content, and there is no Privacy Shield step in this automation.`,
                fix: 'Add a Privacy Shield step (check, or check + hide) before the AI step, or keep the personal fields out of what it reads.',
            },
            aiaDisclosure: {
                title: 'People are not told they are dealing with AI-generated content',
                why: 'This automation generates content that reaches people directly, and no disclosure was found in what they read.',
                fix: 'Say in the text itself that it was generated with AI, or switch on marking for this automation.',
            },
            aiaAnnexIii: {
                title: 'The Annex III questions have not been answered here',
                why: (cats) => `Its wording touches ${cats || 'an Annex III area'}. Wording is a hint, not a qualification — whether this is high risk is settled by the ten Annex III questions, and they are still open.`,
                fix: 'Answer them in Compliance → AI Act. Each answer names the point of Annex III it settles, and "not high risk" takes all ten.',
                area: 'an Annex III area',
            },
            mirror: {
                title: 'Personal data is mirrored to Nextcloud',
                why: 'Rows written here are written through to a Nextcloud table, so the same personal data lives in two places.',
                fix: 'Record both places in the processing register (ROPA), and keep their retention the same.',
            },
            ropa: {
                title: (missing) => `This table has no ${missing} on record`,
                why: (names, unsaid) => `It holds personal data (${names}) and nothing says ${unsaid}.`,
                fix: 'Register it below — that fills the processing register and switches on the retention clean-up.',
                missingBasis: 'legal basis',
                missingDays: 'retention period',
                missingField: 'date to count the retention from',
                unsaidBasis: 'why you may keep it',
                unsaidDays: 'how long',
                unsaidField: (days) => `from when the ${days} days run`,
                and: ' and ',
                or: ' or ',
            },
            isoRoles: {
                title: 'Access is shared but no role is assigned to anyone',
                why: 'The app is open to others while everyone falls back to the default role.',
                fix: 'Give at least the people who administer it a named role, so access control is evidenced.',
            },
        }),
        tablePhaseLabel: 'Table',
        fillPhaseLabel: 'First rows',
        designPhaseLabel: 'Design',
        accessPhaseLabel: 'Access',
        compliancePhaseLabel: 'Compliance check',
        complianceSummary: (n, high, fw) => (n === 0
            ? `Nothing found against ${fw} framework${fw === 1 ? '' : 's'}.`
            : `${n} point${n === 1 ? '' : 's'} to look at${high ? `, ${high} of them important` : ''}.`),
        accessSummary: (who, people) => `Shared with ${who}${people ? ` · ${people}` : ''}.`,
        accessNobody: 'nobody — only you',
        accessEveryone: 'the whole organisation',
        accessGroups: (n) => `${n} ${n === 1 ? 'group' : 'groups'}`,
        accessPeople: (n) => `${n} ${n === 1 ? 'person' : 'people'} with a role`,
        columnFallback: (n) => `Column ${n}`,
        phaseFallback: (n) => `Phase ${n}`,
        inputFallback: (n) => `Input ${n}`,
        documentsFolder: 'documents',
    }),
});

/** The copy pack for a playbook's locale (Dutch for an unset locale — those playbooks are). */
function copyFor(locale) {
    return COPY[packLocale(locale)];
}

module.exports = { PACK_LOCALES, LANGUAGE_NAMES, normaliseLocale, languageName, packLocale, copyFor };
