#!/usr/bin/env node
/**
 * Dutch for the rebuilt "Where your data went" map in Privacy Shield (2026-09):
 * the tooltip with its "How we know" line, the legend, the zoom controls, the
 * list of destinations without a known location, and the footnote about how
 * a location is determined.
 *
 * Terminology follows the existing NL catalogue: aanroepen (calls),
 * persoonsgegevens (never "PII"), bestemming, je eigen server. A "global
 * network" (Cloudflare, Fastly, ...) is a "wereldwijd netwerk", and its edge
 * is the "rand" of that network.
 *
 * Three keys are the same in both languages and are left out on purpose:
 * "{city}, {country}", "via {network}, {pop}" and "via {network}". The test
 * declares them.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-egress-map-translations.js
 */

const NL_TRANSLATIONS = {
    'egress_map.alt': 'Wereldkaart van waar je data heen ging: je server, en een lijn naar elke plek waar data naartoe is gestuurd.',
    'egress_map.calls': '{n} aanroepen',
    'egress_map.calls_pii': '{n} aanroepen · {m} met persoonsgegevens',
    'egress_map.cluster_close': 'Sluiten',
    'egress_map.cluster_label': '{n} bestemmingen dicht bij elkaar. Toon ze.',
    'egress_map.cluster_pick': '{n} bestemmingen op deze plek',
    'egress_map.controls': 'Kaartbediening',
    'egress_map.fit': 'Inzoomen op het verkeer',
    'egress_map.footnote': 'De locatie komt van de verbinding zelf: het IP-adres waar de data naartoe ging, niet van wie de dienst beheert. Een wereldwijd netwerk zoals Cloudflare staat op de plek van zijn rand, waar je data het netwerk in ging.',
    'egress_map.global_network': 'een wereldwijd netwerk',
    'egress_map.global_network_start': 'Een wereldwijd netwerk',
    'egress_map.how_backfill': 'Vastgelegd vóór de exacte meting; locatie bij benadering',
    'egress_map.how_browser': 'Gezien door de webbrowsertool op de verbinding met {ip}',
    'egress_map.how_edge': '{network} meldde zijn rand ({pop}); de dienst erachter is niet zichtbaar',
    'egress_map.how_label': 'Hoe we het weten',
    'egress_map.how_local': 'Je eigen server of netwerk',
    'egress_map.how_recent_socket': 'Gezien op een recente verbinding met {ip}',
    'egress_map.how_socket': 'Gezien op de verbinding met {ip}',
    'egress_map.how_socket_noip': 'Gezien op de verbinding zelf',
    'egress_map.how_unrecorded': 'Niet vastgelegd voor deze bestemming',
    'egress_map.kpi_unknown': '{n} zonder bekende locatie',
    'egress_map.kpi_via': '{n} via een wereldwijd netwerk',
    'egress_map.last_contact': 'Laatste contact {when}',
    'egress_map.legend_eea': 'Binnen Europa (EER, Zwitserland, VK)',
    'egress_map.legend_label': 'Legenda van de kaart',
    'egress_map.legend_network': 'Via een wereldwijd netwerk',
    'egress_map.legend_outside': 'Buiten Europa',
    'egress_map.legend_pii': 'Met persoonsgegevens',
    'egress_map.legend_width': 'Dikkere lijn, meer aanroepen',
    'egress_map.no_origin': 'De locatie van je server is niet ingesteld. De kaart laat daarom zien waar data heen ging, maar tekent geen lijnen vanaf je server. Een beheerder kan BEEFLOW_SERVER_LOCATION instellen om ze toe te voegen.',
    'egress_map.origin_calls': '{n} aanroepen bleven op je eigen server of netwerk',
    'egress_map.pin_label': '{host}, {place}: {n} aanroepen',
    'egress_map.place_edge': 'Rand van {network}, {city}',
    'egress_map.place_edge_only': 'Rand van {network}',
    'egress_map.place_edge_pop': 'Rand van {network} ({pop})',
    'egress_map.place_local': 'Je server',
    'egress_map.reason_backfill': 'Oud record, van vóór de exacte meting',
    'egress_map.reason_child_process': 'De tool draait als apart programma, dus zijn verbindingen zijn niet zichtbaar',
    'egress_map.reason_no_coordinates': 'De plek is niet vastgelegd',
    'egress_map.reason_no_geo_db': 'De locatiedatabase ontbreekt op deze server',
    'egress_map.reason_none': 'Er is geen verbinding gezien',
    'egress_map.reason_proxy': 'Via een proxy verstuurd, dus de server erachter is niet zichtbaar',
    'egress_map.short_unknown': 'Onbekend',
    'egress_map.unplaced_title': 'Geen bekende locatie',
    'egress_map.world': 'Hele wereld',
    'egress_map.zoom_hint': 'Houd {key} ingedrukt en scroll om te zoomen',
    'egress_map.zoom_in': 'Inzoomen',
    'egress_map.zoom_out': 'Uitzoomen',

    // Round 3 (2026-09): kind pills on the map, pin labels, the list grouped
    // by region with a type and a bar per destination.
    'egress_map.col_bar': 'Aanroepen · met persoonsgegevens',
    'egress_map.col_calls': 'Aanroepen',
    'egress_map.col_destination': 'Bestemming',
    'egress_map.footnote_bar': 'Het donkere deel van elke balk zijn de aanroepen met persoonsgegevens.',
    'egress_map.group_calls_pct': '{n} aanroepen · {p}%',
    'egress_map.hint': 'Sleep om te verschuiven · {key} + scroll of +/− om te zoomen',
    'egress_map.kind_all': 'Alle gegevens',
    'egress_map.kind_more': '+{n} meer',
    'egress_map.kind_more_label': 'Meer soorten gegevens',
    'egress_map.kinds_label': 'Soorten gegevens',
    'egress_map.label_no_pii': 'geen persoonsgegevens',
    'egress_map.label_pii': '{m} met persoonsgegevens',
    'egress_map.label_top_more': '{kind} +{k} meer',
    'egress_map.legend_inside': 'Binnen Europa',
    'egress_map.pd': '{m} pg',
    'egress_map.tip_kinds': 'Soorten gegevens, in de recentste aanroepen',
    'egress_map.type_web_search': 'Webzoekopdracht',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomic across replicas (advisory lock in mutateConfig); existing values
    // win, only missing keys are added.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-egress-map-translations: added ${added} NL keys`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(({ added }) => {
        console.log(`Done (${added} added).`);
        process.exit(0);
    }).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
