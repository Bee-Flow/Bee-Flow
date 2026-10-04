#!/usr/bin/env node
/**
 * Dutch for the Nextcloud-mirror half of the Datatables section (2026-09).
 *
 * Its own catalogue beside add-nl-datatables-translations.js rather than a
 * widening of it: that file's test pins "every English datatables.* key has a
 * Dutch one", and it does so by unioning BOTH catalogues, so a key can live in
 * either without the guard weakening — while the feature this one belongs to
 * (core/dataEngine/sources/nextcloudTable) ships as one piece.
 *
 * Terminology: a datatable is a "datatabel", a Nextcloud table a
 * "Nextcloud-tabel", a refresh is "verversen", linking is "koppelen" and
 * undoing it "ontkoppelen" (never "verwijderen" — the table in Nextcloud
 * stays exactly as it is, and the word must not threaten otherwise). And "dit
 * account", never "jij", for the reason the sibling file states.
 *
 * Idempotent, ADD NEVER RENAME, auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-datatables-nextcloud-translations.js
 */

const NL_TRANSLATIONS = {
    // ── De derde kaart in de nieuwe-tabel-dialoog ───────────────────────────
    'datatables.kind_nextcloud': 'Een tabel uit Nextcloud',
    'datatables.kind_nextcloud_blurb': 'Een kopie van een Nextcloud Tables-tabel of -weergave, die ermee in de pas blijft. Rijen die je hier wijzigt, wijzig je in Nextcloud; de kolommen zijn van Nextcloud.',
    'datatables.kind_relation': 'koppeling naar een rij',
    'datatables.kindchip_nextcloud': 'uit Nextcloud',
    'datatables.nc_reason_scope_off': 'Bee Flow mag de Nextcloud-tabellen van dit account nog niet lezen. Zet Tables aan onder Instellingen → Koppelingen → Nextcloud.',
    'datatables.nc_reason_integration_off': 'Nextcloud Tables staat uit voor deze organisatie. Een beheerder kan het aanzetten onder Organisatie → Nextcloud.',
    'datatables.nc_reason_unavailable': 'Nextcloud is op dit moment niet bereikbaar.',
    'datatables.nc_footer': 'Namen en technische namen kies je per tabel in de volgende stap.',
    'datatables.nc_choose': 'Tabellen kiezen…',

    // ── De koppel-wizard ────────────────────────────────────────────────────
    'datatables.nc_link_title': 'Tabellen uit Nextcloud koppelen',
    'datatables.nc_steps': 'Stappen',
    'datatables.nc_step_tables': 'Tabellen',
    'datatables.nc_step_names': 'Namen & kolommen',
    'datatables.nc_step_relations': 'Relaties',
    'datatables.nc_step_review': 'Controleren',
    'datatables.nc_back': 'Terug',
    'datatables.nc_next': 'Volgende',
    'datatables.nc_tables_intro': 'Vink de tabellen aan die je wilt koppelen. Een weergave is een gefilterde blik op een tabel — die kun je apart koppelen.',
    'datatables.nc_search_tables': 'Zoek een tabel',
    'datatables.nc_none': 'Nextcloud heeft geen tabellen die dit account kan lezen.',
    'datatables.nc_view_word': 'weergave',
    'datatables.nc_table_meta': '{rows} rijen · {cols} kolommen',
    'datatables.nc_already_linked': 'al gekoppeld',
    'datatables.nc_key_dup': 'Twee tabellen zouden de technische naam “{key}” krijgen.',
    'datatables.nc_columns_preview': 'Kolommen, zoals ze binnenkomen',
    'datatables.nc_reading': 'Kolommen worden gelezen…',
    'datatables.nc_required': 'verplicht in Nextcloud',
    'datatables.nc_rel_target_missing': 'Wijst naar een tabel die niet geselecteerd is — deze kolom komt binnen als gewoon getal.',
    'datatables.nc_select_too': 'Selecteer die ook',
    'datatables.nc_relations_intro': 'Een relatie geeft elke rij van de ene tabel een koppeling naar één rij van een andere. Nextclouds eigen relatiekolommen worden overgenomen; je kunt er zelf één toevoegen door twee kolommen te matchen.',
    'datatables.nc_relations_need_two': 'Selecteer minstens twee tabellen (geen weergaven) om ze te relateren.',
    'datatables.nc_rel_unlinked': 'een tabel die niet geselecteerd is',
    'datatables.nc_relation_from_nc': 'uit Nextcloud',
    'datatables.nc_relation_suggested': 'dezelfde titel',
    'datatables.nc_relation_matches': 'komt overeen met',
    'datatables.nc_relation_remove': 'Deze relatie verwijderen',
    'datatables.nc_relation_add': 'Relatie toevoegen',
    'datatables.nc_rel_from': 'Tabel',
    'datatables.nc_rel_column': 'Kolom',
    'datatables.nc_rel_to': 'Andere tabel',
    'datatables.nc_rel_target_column': 'Kolom daarvan',
    'datatables.nc_relation_sentence': 'Elke rij van {a} krijgt een koppeling naar de rij van {b} waarvan {y} gelijk is aan zijn {x}. De koppelkolom heet {key}.',
    'datatables.nc_relation_use': 'Deze relatie gebruiken',
    'datatables.nc_review_org': 'Deze tabellen worden van je organisatie.',
    'datatables.nc_review_personal': 'Deze tabellen worden alleen van dit account.',
    'datatables.nc_review_change': 'Wijzigen',
    'datatables.nc_review_note': 'De rijen worden op de achtergrond uit Nextcloud gekopieerd en blijven ermee in de pas. Rijen die je hier wijzigt, wijzig je in Nextcloud.',
    'datatables.nc_link_submit': '{n} tabellen koppelen',
    'datatables.nc_link_submit_one': 'De tabel koppelen',
    'datatables.nc_linked_title': 'De tabellen staan klaar',
    'datatables.nc_linked_body': '{n} tabellen worden nu uit Nextcloud gevuld. Automatiseringen en apps kunnen ze gebruiken als elke andere tabel.',
    'datatables.nc_linked_body_one': 'De tabel wordt nu uit Nextcloud gevuld. Automatiseringen en apps kunnen hem gebruiken als elke andere tabel.',

    // ── De lijst en het Nextcloud-tabblad ───────────────────────────────────
    'datatables.nc_chip_error': 'verversen mislukt',
    'datatables.nc_chip_running': 'wordt ververst…',
    'datatables.nc_chip_truncated': 'niet elke rij',
    'datatables.nc_status_title': 'In de pas met Nextcloud',
    'datatables.nc_status_running': 'Wordt ververst uit Nextcloud…',
    'datatables.nc_status_error': 'De laatste verversing is mislukt: {error}',
    'datatables.nc_status_live': 'Live · in de pas met Nextcloud',
    'datatables.nc_live_last': '· gecontroleerd {when}',
    'datatables.nc_live_explain': 'Wijzigingen in Nextcloud verschijnen hier binnen seconden zolang de tabel openstaat; op de achtergrond wordt hij elke minuut gecontroleerd, en Nextcloud stuurt wijzigingen door zodra ze gebeuren.',
    'datatables.nc_refresh_now': 'Nu verversen',
    'datatables.nc_already_running': 'Er loopt al een verversing.',
    'datatables.nc_truncated': 'Niet elke rij is gekopieerd — de kopie is begrensd op {n} rijen. Filter de weergave in Nextcloud, of koppel een weergave.',
    'datatables.nc_linked_by': 'Nextcloud wordt gelezen en geschreven als het account dat deze tabel gekoppeld heeft.',
    'datatables.nc_linked_at': 'Gekoppeld {when}.',
    'datatables.nc_open_in_nc': 'Openen in Nextcloud',
    'datatables.nc_write_title': 'Wijzigingen gaan twee kanten op',
    'datatables.nc_write_body': 'Rijen die je hier toevoegt, wijzigt of verwijdert worden eerst naar Nextcloud geschreven; daarna wordt deze kopie ververst uit wat Nextcloud antwoordde. Weigert Nextcloud een wijziging — geen rechten daar, een verplichte kolom leeg — dan zie je dat hier en verandert er aan geen van beide kanten iets.',
    'datatables.nc_columns_body': 'De kolommen zijn van Nextcloud. Wijzig ze in Nextcloud; de volgende verversing brengt ze hierheen.',
    'datatables.nc_no_retention': 'Rijen worden hier niet opgeruimd — ze blijven zolang ze in Nextcloud staan.',
    'datatables.nc_strip_write': 'Rijen die je hier wijzigt, wijzig je in Nextcloud.',
    'datatables.nc_relations_title': 'Relaties',
    'datatables.nc_relations_empty': 'Nog geen relaties. Koppel een tweede Nextcloud-tabel en match een kolom van elk.',
    'datatables.nc_relation_matched_on': 'gematcht op {local} = {target}',
    'datatables.nc_relations_saved': 'Opgeslagen. De koppelkolom wordt bij de volgende verversing gevuld.',

    // ── Kolommen en rijen ───────────────────────────────────────────────────
    'datatables.nc_columns_locked': 'Deze kolommen komen uit Nextcloud en kunnen hier niet worden toegevoegd, verwijderd, hernoemd of van type veranderd. Wijzig ze in Nextcloud — de volgende verversing brengt ze hierheen.',
    'datatables.nc_column_hint': 'uit Nextcloud',
    'datatables.nc_column_label': 'hier gevuld · de naam van de gekoppelde rij',
    'datatables.nc_column_relation_nc': 'uit Nextcloud · een koppeling naar een rij van een andere gekoppelde tabel',
    'datatables.nc_column_relation_declared': 'hier gevuld · gematcht op een kolom van een andere gekoppelde tabel',
    'datatables.nc_rows_refreshed': 'ververst {when}',
    'datatables.nc_writing': 'Wordt naar Nextcloud geschreven…',
    'datatables.nc_relation_cell_title': 'Een rij van de gekoppelde tabel',
    'datatables.nc_relation_derived': 'Gevuld vanuit een andere kolom — wijzig die kolom.',

    // ── Ontkoppelen ─────────────────────────────────────────────────────────
    'datatables.nc_unlink_open': 'Deze tabel ontkoppelen',
    'datatables.nc_unlink_question': '“{name}” ontkoppelen van deze werkruimte?',
    'datatables.nc_unlink_confirm': 'Ontkoppelen',
    'datatables.nc_unlink_notice': 'Ontkoppelen verwijdert de kopie die hier staat. De tabel in Nextcloud, en elke rij erin, blijft precies zoals hij is. Automatiseringen en apps die deze tabel gebruiken, vinden hem niet meer.',

    // ── Weigeringen ─────────────────────────────────────────────────────────
    'datatables.err_nextcloud_forbidden': 'Nextcloud weigert deze wijziging: het account dat deze tabel gekoppeld heeft, mag hem daar niet wijzigen.',
    'datatables.err_nextcloud_not_found': 'Nextcloud heeft deze rij of tabel niet meer.',
    'datatables.err_nextcloud_rejected': 'Nextcloud accepteerde de rij niet: {detail}',
    'datatables.err_nextcloud_unavailable': 'Nextcloud was niet bereikbaar, dus er is aan geen van beide kanten iets veranderd. Probeer het zo nog eens.',
    'datatables.err_nc_scope_denied': 'Het account dat deze tabel gekoppeld heeft, deelt hem niet meer met Bee Flow. Vraag een eigenaar om opnieuw te koppelen.',
    'datatables.err_nextcloud_integration_off': 'Nextcloud Tables staat uit voor deze organisatie.',
    'datatables.err_not_nc_org': 'Deze organisatie is niet verbonden met Nextcloud.',
    'datatables.err_schema_from_source': 'De kolommen van deze tabel zijn van Nextcloud. Wijzig ze in Nextcloud — de volgende verversing brengt ze hierheen.',
    'datatables.err_derived_column': 'Die kolom wordt gevuld vanuit een relatie en kan niet rechtstreeks worden gezet.',
    'datatables.err_mirror_no_retention': 'Rijen van een Nextcloud-tabel worden hier niet opgeruimd.',
    'datatables.err_mirror_row_scope': 'Een Nextcloud-tabel kan niet worden beperkt tot ieders eigen rijen — elke rij is geschreven door het account dat hem gekoppeld heeft.',
    'datatables.err_already_linked': 'Die Nextcloud-tabel is hier al gekoppeld.',
    'datatables.err_nextcloud_write_unsupported': 'Rijen van deze tabel wijzig je voorlopig in Nextcloud; wijzigingen komen hier binnen bij het verversen.',
};

/** Keys whose Dutch IS the English string (see the sibling file for why). */
const SAME_AS_ENGLISH = [
    'datatables.tab_nextcloud',
];

async function up() {
    const languageStore = require('../stores/languageStore');
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-datatables-nextcloud-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS, SAME_AS_ENGLISH };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-datatables-nextcloud-translations failed:', e.message);
        process.exit(1);
    });
}
