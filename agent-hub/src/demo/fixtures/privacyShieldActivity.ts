/**
 * "What happened" for the Privacy Shield demo: thirty days of evidence for
 * the same fictional insurer as privacyShield.js (Van Dael Assurantiën).
 *
 * Every number here is generated from ONE table of days so the parts cannot
 * drift: the timeline sums to the summary, the categories sum to the PII
 * count, the destinations sum to the call count, and the sovereignty score is
 * computed with the server's own weighting rather than typed in. The tab
 * writes its findings from these numbers, so getting them wrong does not
 * look like bad data: it looks like the shield saying the wrong thing.
 *
 * THE DESTINATIONS ARE TOOL TRAFFIC, in the overview's shape (contract of
 * `GET /api/usage/integrations/overview`, `top.destinations` and `map`): the
 * organisation's own Nextcloud, a document service in Frankfurt, OpenAI's
 * API reached through Cloudflare's Amsterdam edge (a "global network": the
 * edge is known, the service behind it is not), a claims portal in Toronto
 * that received personal data, a form service in Virginia, and one tool whose
 * connection was never seen. Only OpenAI is a real company, and its API does
 * sit behind Cloudflare; the others are invented, with documentation IPs.
 */

import { daysAgo, minutesAgo } from './common';

const DAYS = 30;

// Weekday-shaped traffic: quiet weekends, a spike on the day the claims backlog
// was worked through.
const dayShape = (i: number) => {
    const dow = (i + 3) % 7;              // arbitrary but fixed phase
    if (dow === 5 || dow === 6) return 0.25;
    return i === 11 ? 2.1 : 1;
};

const SERIES = Array.from({ length: DAYS }, (_, i) => {
    const f = dayShape(i);
    const pii = Math.round(14 * f);
    const moderation = Math.round(2 * f);
    const regex = Math.round(3 * f);
    const dlp = Math.round(4 * f);
    return {
        period: daysAgo(DAYS - 1 - i).slice(0, 10),
        total: pii + moderation + regex + dlp,
        moderation, pii, regex, dlp,
        calls: Math.round(96 * f),
    };
});

type SeriesKey = 'total' | 'pii' | 'moderation' | 'regex' | 'calls';
const sum = (key: SeriesKey) => SERIES.reduce((s, r) => s + r[key], 0);

export const TOTAL_EVENTS = sum('total');
export const TOTAL_PII = sum('pii');
export const TOTAL_CALLS = sum('calls');

/** Split a total across weights so the parts always add back up to it. */
function apportion<T extends { weight: number }>(total: number, weights: T[]): Array<T & { count: number }> {
    const w = weights.reduce((s, x) => s + x.weight, 0);
    const out = weights.map(x => ({ ...x, count: Math.floor((total * x.weight) / w) }));
    const drift = total - out.reduce((s, x) => s + x.count, 0);
    if (out.length) out[0].count += drift;   // the remainder lands on the biggest
    return out;
}

const TOP_CATEGORIES = apportion(TOTAL_PII, [
    { category: 'Person', weight: 34 },
    { category: 'Email', weight: 22 },
    { category: 'InternationalBankingAccountNumber', weight: 14 },
    { category: 'PhoneNumber', weight: 12 },
    { category: 'Address', weight: 9 },
    { category: 'NationalIdentificationNumber', weight: 6 },
    { category: 'MedicalCondition', weight: 3 },
]).map(c => ({ category: c.category, violation_type: 'pii', count: c.count }));

const PEOPLE = [
    { user_id: 'u_sanne', display_name: 'Sanne Vermeer', weight: 30 },
    { user_id: 'u_ruben', display_name: 'Ruben Tak', weight: 24 },
    { user_id: 'u_pieter', display_name: 'Pieter Hoogendijk', weight: 19 },
    { user_id: 'u_farah', display_name: 'Farah El Amrani', weight: 15 },
    { user_id: 'u_joost', display_name: 'Joost Bakker', weight: 12 },
];

const TOP_USERS = apportion(TOTAL_EVENTS, PEOPLE).map((u, i) => ({
    user_id: u.user_id,
    display_name: u.display_name,
    total: u.count,
    pii: Math.round(u.count * 0.62),
    moderation: Math.round(u.count * 0.09),
    regex: Math.round(u.count * 0.13),
    last_event: minutesAgo(40 + i * 220),
}));

const byWeight = <K extends string>(key: K, rows: Array<Record<K, string> & { weight: number }>) =>
    apportion(TOTAL_EVENTS, rows).map(r => ({ [key]: r[key], count: r.count }));

/* ── Destinations ─────────────────────────────────────────────────────── */

const LOC_NONE = { city: null, lat: null, lon: null, edge_pop: null, network: null, as_org: null };

/** `piiShare` is the share of a destination's calls that carried personal data. */
const DEST_SEEDS = [
    {
        dest_host: 'cloud.vandael.nl', integration: 'nextcloud', operator: 'Van Dael (own server)',
        country_code: 'NL', country_name: 'Netherlands', location_state: 'local', location_basis: 'socket',
        ...LOC_NONE, sample_peer_ip: '10.20.0.14', piiShare: 0.3, weight: 34,
    },
    {
        dest_host: 'api.dossierbank.eu', integration: 'mcp_server', operator: 'Dossierbank GmbH',
        country_code: 'DE', country_name: 'Germany', location_state: 'eu', location_basis: 'socket',
        ...LOC_NONE, city: 'Frankfurt am Main', lat: 50.11, lon: 8.68, as_org: 'Dossierbank GmbH',
        sample_peer_ip: '203.0.113.40', piiShare: 0, weight: 24,
    },
    {
        dest_host: 'api.openai.com', integration: 'openai_images', operator: 'OpenAI, L.L.C.',
        country_code: 'NL', country_name: 'Netherlands', location_state: 'via_network', location_basis: 'edge_header',
        city: 'Amsterdam', lat: 52.31, lon: 4.76, edge_pop: 'AMS', network: 'Cloudflare', as_org: 'Cloudflare, Inc.',
        sample_peer_ip: '104.18.33.45', piiShare: 0, weight: 16,
    },
    {
        dest_host: 'api.claimsbridge.ca', integration: 'http_request', operator: 'ClaimsBridge Inc.',
        country_code: 'CA', country_name: 'Canada', location_state: 'outside', location_basis: 'socket',
        ...LOC_NONE, city: 'Toronto', lat: 43.65, lon: -79.38, as_org: 'ClaimsBridge Inc.',
        sample_peer_ip: '198.51.100.24', piiShare: 0.45, weight: 10,
    },
    {
        dest_host: 'api.formsense.io', integration: 'http_request', operator: 'FormSense Inc.',
        country_code: 'US', country_name: 'United States', location_state: 'outside', location_basis: 'socket',
        ...LOC_NONE, city: 'Ashburn', lat: 39.04, lon: -77.49, as_org: 'FormSense Inc.',
        sample_peer_ip: '198.51.100.77', piiShare: 0, weight: 9,
    },
    {
        dest_host: 'api.expertiseportaal.nl', integration: 'mcp_server', operator: '',
        country_code: null, country_name: null, location_state: 'unknown', location_basis: 'none',
        ...LOC_NONE, sample_peer_ip: null, piiShare: 0, weight: 7,
    },
];

const INTEGRATION_OF = new Map(DEST_SEEDS.map(d => [d.dest_host, d.integration]));

export const DESTINATIONS = apportion(TOTAL_CALLS, DEST_SEEDS).map((d, i) => {
    const { weight: _w, count, piiShare, integration: _i, ...rest } = d;
    return {
        ...rest,
        total: count,
        pii_events: Math.round(count * piiShare),
        is_eu: d.location_state === 'eu',
        is_local: d.location_state === 'local',
        last_contact: minutesAgo(6 + i * 47),
        country_flag: null,
    };
});

const callsIn = (state: string) => DESTINATIONS.filter(d => d.location_state === state).reduce((s, d) => s + d.total, 0);

const OUTSIDE = DESTINATIONS.filter(d => d.location_state === 'outside');
/** Calls that carried personal data, and the kinds found in them: some calls carried two. */
export const PII_EVENTS = DESTINATIONS.reduce((s, d) => s + d.pii_events, 0);
const TOOL_CATEGORIES = apportion(Math.round(PII_EVENTS * 1.25), [
    { category: 'Person', weight: 46 },
    { category: 'Email', weight: 24 },
    { category: 'InternationalBankingAccountNumber', weight: 16 },
    { category: 'PhoneNumber', weight: 9 },
    { category: 'Address', weight: 5 },
]).map(c => ({ category: c.category, count: c.count }));
export const NON_EU_CALLS = callsIn('outside');
/** Of the calls that left Europe, the ones that carried personal data. */
export const PII_NON_EU = OUTSIDE.reduce((s, d) => s + d.pii_events, 0);
export const VIA_NETWORK_CALLS = callsIn('via_network');
export const UNKNOWN_CALLS = callsIn('unknown');
export const LOCATED_CALLS = callsIn('local') + callsIn('eu') + NON_EU_CALLS;

/**
 * The server's weighting, over the LOCATED calls only (your own server, inside
 * Europe, outside it): a call that stayed scores full marks, and personal data
 * leaving Europe counts double. Calls through a global network and calls with
 * no known location are neither, so they are not in it.
 */
export const SOVEREIGNTY_SCORE = Math.max(0, Math.min(100, Math.round(
    100 * (1 - (NON_EU_CALLS + PII_NON_EU) / (LOCATED_CALLS + PII_NON_EU)),
)));

export const GUARD_OVERVIEW = () => ({
    summary: {
        total_events: TOTAL_EVENTS,
        pii_count: TOTAL_PII,
        // Every demo event is a find (violation_type 'pii'), so the two agree.
        pii_messages: TOTAL_PII,
        moderation_count: sum('moderation'),
        regex_count: sum('regex'),
        input_count: Math.round(TOTAL_EVENTS * 0.88),
        output_count: TOTAL_EVENTS - Math.round(TOTAL_EVENTS * 0.88),
        unique_users: PEOPLE.length,
    },
    timeline: SERIES.map(({ period, total, moderation, pii, regex, dlp }) => ({ period, total, moderation, pii, regex, dlp })),
    top_categories: TOP_CATEGORIES,
    by_action: byWeight('action_taken', [
        { action_taken: 'tokenized', weight: 71 }, { action_taken: 'redacted', weight: 17 },
        { action_taken: 'blocked', weight: 8 }, { action_taken: 'allowed', weight: 4 },
    ]),
    top_users: TOP_USERS,
    by_surface: byWeight('surface', [
        { surface: 'direct', weight: 46 }, { surface: 'agent', weight: 34 },
        { surface: 'automation', weight: 15 }, { surface: 'notebook', weight: 5 },
    ]),
    health: { last_event_at: minutesAgo(38) },
    window: { start: null, end: null, interval: 'day' },
});

export const INTEG_OVERVIEW = () => ({
    summary: {
        total_calls: TOTAL_CALLS,
        pii_non_eu_count: PII_NON_EU,
        sovereignty_score: SOVEREIGNTY_SCORE,
        score_delta: 4,
        // One count per location state, like the server's stateCounts():
        // your own server is `local`, not `eu`.
        local_count: callsIn('local'),
        eu_count: callsIn('eu'),
        pii_events: PII_EVENTS,
        // The demo organisation checks connected-app content, so every call
        // was scanned: none is "not checked", none was blocked.
        clean_count: TOTAL_CALLS - PII_EVENTS,
        unchecked_count: 0,
        blocked_count: 0,
        non_eu_count: NON_EU_CALLS,
        via_network_count: VIA_NETWORK_CALLS,
        unknown_count: UNKNOWN_CALLS,
        located_count: LOCATED_CALLS,
        coverage_pct: Math.round((LOCATED_CALLS / TOTAL_CALLS) * 1000) / 10,
    },
    timeline: SERIES.map(r => ({ period: r.period, total: r.calls })),
    top: {
        destinations: DESTINATIONS,
        non_eu_destinations: OUTSIDE,
        integrations: [...INTEGRATION_OF.entries()].reduce<Array<{ integration_type: string; total: number }>>((out, [host, type]) => {
            const n = DESTINATIONS.find(d => d.dest_host === host)?.total || 0;
            const row = out.find(r => r.integration_type === type);
            if (row) row.total += n; else out.push({ integration_type: type, total: n });
            return out;
        }, []).sort((a, b) => b.total - a.total),
        actors: [
            { actor: 'agent', total: Math.round(TOTAL_CALLS * 0.54) },
            { actor: 'user', total: Math.round(TOTAL_CALLS * 0.31) },
            { actor: 'automation', total: Math.round(TOTAL_CALLS * 0.15) },
        ],
        users: TOP_USERS.map(u => ({ user_id: u.user_id, display_name: u.display_name, total: Math.round(u.total * 1.7) })),
    },
    map: {
        origin: { country_code: 'NL', country_name: 'Netherlands', lat: 52.37, lon: 4.9, label: 'Your server' },
        destinations: DESTINATIONS,
        attribution: { text: 'IP geolocation by DB-IP', url: 'https://db-ip.com' },
        geo_db: { available: true, edition: 'dbip-city-lite', date: '2026-09' },
    },
    pii_categories: TOOL_CATEGORIES,
    data_categories: [
        { category: 'Conversation content', count: TOTAL_CALLS },
        { category: 'Attachment text', count: 318 },
        { category: 'Retrieved knowledge', count: 902 },
    ],
    health: { last_call_at: minutesAgo(6), scan_levels: { full: TOTAL_CALLS, basic: 0, none: 0 } },
    window: { start: null, end: null, interval: 'day' },
});

/* ── The drill-down rows ────────────────────────────────────────────────
   The tab filters the category and destination drills CLIENT-side, so these
   rows have to carry the categories and hosts the cards above them show;
   otherwise clicking a card opens an empty table, which reads as a bug in the
   product rather than a gap in the sample.

   They are spread over the whole month with the same weekday shape as the
   timeline, because the day-by-day chart and the KPI sparklines are drawn
   from them: a sample squeezed into one afternoon draws one bar. There are
   fewer rows than the aggregates count, as for any real organisation of this
   size, so the tab says the sample is not the whole window. */

/**
 * Timestamps for the sample rows, newest first: `perDay(i)` rows on day i
 * (0 = the oldest), in office hours; today's are minutes old.
 */
function sampleTimes(perDay: (i: number) => number, offset: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < DAYS; i += 1) {
        for (let k = 0; k < perDay(i); k += 1) {
            if (i === DAYS - 1) { out.push(minutesAgo(offset + k * 97)); continue; }
            const d = new Date(daysAgo(DAYS - 1 - i));
            d.setHours(9 + ((k * 3 + offset) % 8), (k * 23 + offset * 7) % 60, 0, 0);
            out.push(d.toISOString());
        }
    }
    return out.sort((a, b) => b.localeCompare(a));
}

// No sample row names a health category (MedicalCondition is in
// TOP_CATEGORIES as a total): the server never returns one on a row that
// carries a person (server/core/privacy/specialCategories.js).
const GUARD_EVENT_SEEDS: Array<[number, string, string, string, string | null]> = [
    [0, 'direct', 'Person,Email', 'tokenized', null],
    [1, 'agent', 'InternationalBankingAccountNumber', 'tokenized', 'Schadebeoordeling'],
    [0, 'agent', 'Person,PhoneNumber', 'tokenized', 'Polisintake'],
    [2, 'automation', 'Email', 'redacted', 'Wekelijkse schaderapportage'],
    [3, 'direct', 'NationalIdentificationNumber', 'blocked', null],
    [1, 'agent', 'Person,Address', 'tokenized', 'Klachtdossier'],
    [4, 'direct', 'NationalIdentificationNumber', 'blocked', null],
    [2, 'agent', 'Person', 'tokenized', 'Klantenservice-assistent'],
    [0, 'notebook', 'Email,Person', 'tokenized', null],
    [3, 'automation', 'InternationalBankingAccountNumber,Person', 'tokenized', 'Incassobestand opschonen'],
    [1, 'direct', 'PhoneNumber', 'allowed', null],
    [4, 'agent', 'Address', 'redacted', 'Polisintake'],
    [2, 'agent', 'Email', 'tool_blocked', 'Klachtdossier'],
];

const GUARD_TIMES = sampleTimes(i => Math.floor(2 * dayShape(i)), 35);

export const GUARD_ROWS = () => GUARD_TIMES.map((timestamp, i) => {
    const [user, surface, cats, action, agent] = GUARD_EVENT_SEEDS[i % GUARD_EVENT_SEEDS.length];
    return {
        // Newest first with the highest id, as the server returns them.
        id: `ge_${1000 + GUARD_TIMES.length - i}`,
        timestamp,
        user_id: PEOPLE[user].user_id,
        display_name: PEOPLE[user].display_name,
        violation_type: 'pii',
        violation_categories: cats,
        action_taken: action,
        direction: action === 'tool_blocked' ? 'output' : 'input',
        source: surface,
        agent_id: surface === 'agent' ? `agent_${agent}` : null,
        automation_id: surface === 'automation' ? `automation_${agent}` : null,
        agent_name: agent,
        conversation_id: `conv_${7100 + i}`,
        model: surface === 'automation' ? 'qwen3-8b' : 'gpt-5',
        status: 'handled',
    };
});

/** [destination index, tool, categories, duration ms] */
const EGRESS_SEEDS: Array<[number, string, string, number]> = [
    [0, 'files.read', 'Person', 420],
    [3, 'claims.submit', 'Person,Email', 1_840],
    [1, 'dossier.upload', '', 960],
    [2, 'images.generate', '', 5_120],
    [0, 'files.search', '', 310],
    [3, 'claims.status', 'InternationalBankingAccountNumber', 1_210],
    [4, 'forms.fetch', '', 780],
    [5, 'expertise.request', '', 2_200],
    [1, 'dossier.search', '', 640],
    [0, 'files.write', 'Person', 505],
];

const EGRESS_TIMES = sampleTimes(i => Math.floor(3 * dayShape(i)), 12);

/** Where a sampled call started: chat, one of the agents, or the weekly automation. */
const EGRESS_SURFACES: Array<{ source: string; agent_name: string | null }> = [
    { source: 'agent', agent_name: 'Polisintake' },
    { source: 'direct_chat', agent_name: null },
    { source: 'agent', agent_name: 'Klachtdossier' },
    { source: 'automation', agent_name: 'Wekelijkse schaderapportage' },
    { source: 'direct_chat', agent_name: null },
    { source: 'agent', agent_name: 'Schadebeoordeling' },
    { source: 'direct_chat', agent_name: null },
];

export const EGRESS_ROWS = () => EGRESS_TIMES.map((timestamp, i) => {
    const [dest, tool, pii, dur] = EGRESS_SEEDS[i % EGRESS_SEEDS.length];
    const d = DESTINATIONS[dest];
    const surface = EGRESS_SURFACES[i % EGRESS_SURFACES.length];
    return {
        id: `eg_${2000 + EGRESS_TIMES.length - i}`,
        timestamp,
        source: surface.source,
        agent_name: surface.agent_name,
        agent_id: surface.source === 'agent' ? `agent_${surface.agent_name}` : null,
        automation_id: surface.source === 'automation' ? `automation_${surface.agent_name}` : null,
        user_id: PEOPLE[i % PEOPLE.length].user_id,
        display_name: PEOPLE[i % PEOPLE.length].display_name,
        integration_type: INTEGRATION_OF.get(d.dest_host),
        tool_name: tool,
        dest_host: d.dest_host,
        tls_servername: d.dest_host,
        server_endpoint: `https://${d.dest_host}/`,
        operator: d.operator,
        country_code: d.country_code,
        country_name: d.country_name,
        city: d.city,
        lat: d.lat,
        lon: d.lon,
        location_state: d.location_state,
        location_basis: d.location_basis,
        edge_pop: d.edge_pop,
        network: d.network,
        as_org: d.as_org,
        peer_ip: d.sample_peer_ip,
        peers: null,
        is_eu: d.is_eu,
        is_local: d.is_local,
        pii_categories_detected: pii,
        pii_scan_level: 'full',
        duration_ms: dur,
        status: 'ok',
    };
});
