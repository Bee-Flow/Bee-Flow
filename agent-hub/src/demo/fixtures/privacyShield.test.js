/**
 * The Privacy Shield demo shows an administrator two things a marketing page
 * cannot: the rules an organisation can actually enforce, and a month of what
 * those rules caught. Both are only worth showing if the numbers survive
 * being read.
 *
 * What is pinned here is what a VISITOR CAN CHECK BY LOOKING. The "What
 * happened" tab puts a headline next to the rows it is made of — 586 events
 * over a timeline, 355 of them personal data across seven categories, a
 * sovereignty score beside the destinations it is computed from. Any of those
 * can disagree with the others without erroring, and a compliance-adjacent
 * demo whose arithmetic is wrong is worse than no demo.
 *
 * The other half is the CONTRACT with the editor: shapes come from the server
 * (`normaliseDoc` in useOrgShield, `getGuardrailOverview` in the store), and a
 * near-miss field name renders a silent zero rather than a failure.
 *
 * Run: cd agent-hub && npx vitest run src/demo/fixtures/privacyShield.test.js
 */
import { describe, it, expect } from 'vitest';
import { PII_CATEGORIES } from '../../config/piiCategories';
import { DEMO_CAPABILITIES } from './common';
import { ROUTES, createState, shieldDoc, _internals } from './privacyShield';
import { LEGACY_ID, POLIS_ID, PROJECT_ID } from './privacyShieldOwnData';
import { isSpecialCategory } from '../../components/admin/security/guardrails/orgShield/activity/specialCategories';

const VALID_CATEGORY_IDS = new Set(PII_CATEGORIES.map(c => c.id));
const CUSTOM_ID = /^cdt_[0-9a-f]{10}$/;
/** A list id is fine when it is a real built-in kind, or one of the org's own types. */
const knownId = (id) => VALID_CATEGORY_IDS.has(id) || shieldDoc().customDataTypes.some(t => t.id === id);
const ctx = (over = {}) => ({
    state: createState(), query: new URLSearchParams(), params: { orgId: 'org_demo_vandael' }, body: null, ...over,
});
const num = (v) => Number(v || 0);

describe('the shield document', () => {
    it('every watched category is a real category id', () => {
        // useOrgShield filters piiDetectionCategories against this list. An id
        // that is not in it does not error — it silently disappears, and the
        // Overview's "N of 21" quietly counts one fewer than the file says.
        // The org's own type ids ride in the same list; each must be a type
        // the document actually has, or its switch would be a dead tick.
        for (const id of shieldDoc().piiDetectionCategories) {
            expect(knownId(id), `unknown category "${id}"`).toBe(true);
        }
        expect(PII_CATEGORIES.length).toBe(21);
    });

    it('every category named in a tool policy is real too', () => {
        const doc = shieldDoc();
        const named = [
            ...doc.toolPiiPolicy.external.blockCategories,
            ...doc.toolPiiPolicy.internal.blockCategories,
            ...doc.webSearchGuardPiiCategories,
        ];
        expect(named.length).toBeGreaterThan(0);
        for (const id of named) expect(knownId(id), `unknown category "${id}"`).toBe(true);
    });

    it('the shield is on, and looking for something', () => {
        const doc = shieldDoc();
        expect(doc.enabled).toBe(true);
        // derivePosture flags an enabled shield with zero categories as a
        // warning, because everything below it is then decoration. A demo
        // must not open on its own warning state.
        expect(doc.piiDetectionCategories.length).toBeGreaterThan(0);
    });

    it('grants the capabilities the document needs, or two controls render as locks', () => {
        const doc = shieldDoc();
        if (doc.piiDetectionAction === 'tokenize') expect(DEMO_CAPABILITIES).toContain('pii_tokenize');
        if (doc.webSearchGuardEnabled) expect(DEMO_CAPABILITIES).toContain('web_search_guard');
        // Without it the "Your own data" tab renders its locked view.
        if (doc.customDataTypes.length) expect(DEMO_CAPABILITIES).toContain('custom_data_types');
        expect(DEMO_CAPABILITIES).toContain('advanced_usage_monitoring');
    });

    it('the configuration and the evidence tell one story', () => {
        // The whole point of the activity tab in this demo: EU-only routing is
        // off, and the tab reports the consequence. If someone switches the
        // document to euModeEnabled the alert becomes a lie about the sample.
        expect(shieldDoc().euModeEnabled).toBe(false);
        expect(_internals.PII_NON_EU).toBeGreaterThan(0);
    });
});

describe('saving', () => {
    it('a save is readable back — the panel is not a prop', async () => {
        const c = ctx();
        await ROUTES['PUT /api/org-privacy-shield/:orgId']({ ...c, body: { ...c.state.shield, piiDetectionAction: 'block' } });
        expect(ROUTES['GET /api/org-privacy-shield/:orgId'](c).piiDetectionAction).toBe('block');
    });

    it('reports no clamps and no rejected terms', async () => {
        const c = ctx();
        const res = await ROUTES['PUT /api/org-privacy-shield/:orgId']({ ...c, body: c.state.shield });
        // Either being absent renders "Saved, with notes" over a clean save.
        expect(res.clamped_fields).toEqual([]);
        expect(res.termErrors).toEqual([]);
        expect(res.typeErrors).toEqual([]);
    });
});

describe('the rows the Overview only exists to summarise', () => {
    it('offers the two rows that depend on other endpoints', () => {
        // "Web search protection" appears only when /ai/config names a search
        // provider; "EU-hosted AI only" only when the EU model map is
        // non-empty. Both are on the screenshot this demo is standing in for,
        // and both vanish silently when these come back empty.
        expect(ROUTES['GET /ai/config']().searchProvider).toBeTruthy();
        expect(Object.keys(ROUTES['GET /ai/config/chat-models-eu']()).length).toBeGreaterThan(0);
    });

    it('answers the organisation list even though the picker is hidden', () => {
        const orgs = ROUTES['GET /auth/organizations']();
        expect(Array.isArray(orgs)).toBe(true);
        expect(orgs[0].id).toBe(shieldDoc().organization_id);
    });
});

describe('"What happened" — the numbers reconcile', () => {
    const guard = () => ROUTES['GET /api/usage/guardrails/overview'](ctx());
    const integ = () => ROUTES['GET /api/usage/integrations/overview'](ctx());

    it('the timeline sums to the headline', () => {
        const g = guard();
        expect(g.timeline.reduce((s, r) => s + num(r.total), 0)).toBe(num(g.summary.total_events));
        expect(g.timeline.reduce((s, r) => s + num(r.pii), 0)).toBe(num(g.summary.pii_count));
    });

    it('the breakdown cards sum to the headline', () => {
        const g = guard();
        expect(g.top_categories.reduce((s, r) => s + num(r.count), 0)).toBe(num(g.summary.pii_count));
        expect(g.by_surface.reduce((s, r) => s + num(r.count), 0)).toBe(num(g.summary.total_events));
        expect(g.by_action.reduce((s, r) => s + num(r.count), 0)).toBe(num(g.summary.total_events));
        expect(g.top_users.reduce((s, r) => s + num(r.total), 0)).toBe(num(g.summary.total_events));
    });

    it('carries by_surface, which the hook does not default', () => {
        // EMPTY_GUARD in useShieldActivity has no by_surface key, so the
        // "Where it happened" card is the one that disappears without a sound.
        expect(guard().by_surface.length).toBeGreaterThan(0);
    });

    it('the destinations sum to the call count, and some of them left Europe', () => {
        const i = integ();
        const dests = i.top.destinations;
        expect(dests.reduce((s, d) => s + num(d.total), 0)).toBe(num(i.summary.total_calls));
        const outside = dests.filter(d => d.location_state === 'outside');
        expect(outside.length).toBeGreaterThan(0);
        expect(i.top.non_eu_destinations.map(d => d.dest_host).sort())
            .toEqual(outside.map(d => d.dest_host).sort());
    });

    it('the location counts reconcile: located + via a network + unknown = every call', () => {
        const { summary, top } = integ();
        const calls = (state) => top.destinations.filter(d => d.location_state === state).reduce((s, d) => s + num(d.total), 0);
        expect(num(summary.via_network_count)).toBe(calls('via_network'));
        expect(num(summary.unknown_count)).toBe(calls('unknown'));
        expect(num(summary.located_count)).toBe(calls('local') + calls('eu') + calls('outside'));
        expect(num(summary.located_count) + num(summary.via_network_count) + num(summary.unknown_count))
            .toBe(num(summary.total_calls));
        expect(summary.coverage_pct).toBe(Math.round((num(summary.located_count) / num(summary.total_calls)) * 1000) / 10);
    });

    it('the sovereignty score is the server formula over the LOCATED calls', () => {
        // A call through a global network, or with no known location, is
        // neither a pass nor a fail, so it is not in the score at all.
        const { summary } = integ();
        const located = num(summary.located_count);
        const outside = num(summary.non_eu_count);
        const pii = num(summary.pii_non_eu_count);
        const expected = Math.max(0, Math.min(100, Math.round(100 * (1 - (outside + pii) / (located + pii)))));
        expect(num(summary.sovereignty_score)).toBe(expected);
        expect(num(summary.sovereignty_score)).toBeLessThan(Math.round(((located - outside) / located) * 100) + 1);
    });

    it('the kinds found in tool calls cover every call that carried personal data', () => {
        // One call can carry two kinds, never none: "Personal data found"
        // sums the kinds, "in N messages and calls" counts the calls, and a
        // demo where the first is smaller than the second reads as a bug.
        const i = integ();
        const kinds = i.pii_categories.reduce((s, c) => s + num(c.count), 0);
        expect(kinds).toBeGreaterThanOrEqual(num(i.summary.pii_events));
    });

    it('personal data that left Europe cannot exceed the calls that left', () => {
        const i = integ();
        const outside = i.top.destinations.filter(d => d.location_state === 'outside').reduce((s, d) => s + num(d.total), 0);
        expect(num(i.summary.pii_non_eu_count)).toBeLessThanOrEqual(outside);
        expect(num(i.summary.pii_non_eu_count)).toBeGreaterThan(0);
    });

    it('one destination is the organisation\'s own server, at no egress', () => {
        // The row worth looking at: real traffic that never left the network.
        // `is_eu` means "inside Europe", so your own server is local, not EU.
        expect(integ().top.destinations.some(d => d.is_local && d.location_state === 'local' && !d.is_eu)).toBe(true);
    });
});

describe('"What happened" — the map has every kind of place to show', () => {
    const integ = () => ROUTES['GET /api/usage/integrations/overview'](ctx());
    const dest = (pred) => integ().map.destinations.find(pred);

    it('draws lines from a known origin, and credits the geolocation database', () => {
        const { map } = integ();
        expect(map.origin).toMatchObject({ country_code: 'NL', lat: 52.37, lon: 4.9 });
        expect(map.attribution).toEqual({ text: 'IP geolocation by DB-IP', url: 'https://db-ip.com' });
        expect(map.geo_db.available).toBe(true);
        expect(map.destinations.length).toBeGreaterThanOrEqual(integ().top.destinations.length);
    });

    it('has a global network at its Amsterdam edge, an EU city, and Canada with personal data', () => {
        expect(dest(d => d.location_state === 'via_network')).toMatchObject({ network: 'Cloudflare', edge_pop: 'AMS', location_basis: 'edge_header' });
        expect(dest(d => d.location_state === 'eu')).toMatchObject({ city: 'Frankfurt am Main', country_code: 'DE' });
        const canada = dest(d => d.country_code === 'CA');
        expect(canada).toMatchObject({ location_state: 'outside', city: 'Toronto' });
        expect(canada.pii_events).toBeGreaterThan(0);
    });

    it('places every destination it can, and says why it cannot place the rest', () => {
        for (const d of integ().map.destinations) {
            if (['eu', 'outside', 'via_network'].includes(d.location_state)) {
                expect(Number.isFinite(d.lat) && Number.isFinite(d.lon), `${d.dest_host} has no coordinates`).toBe(true);
            }
        }
        expect(dest(d => d.location_state === 'unknown')).toMatchObject({ location_basis: 'none', lat: null, lon: null });
    });

    it('egress rows carry the location of their destination', () => {
        const rows = ROUTES['GET /api/usage/integrations/egress'](ctx());
        for (const r of rows) {
            const d = dest(x => x.dest_host === r.dest_host);
            expect(r).toMatchObject({ location_state: d.location_state, city: d.city, lat: d.lat, lon: d.lon, edge_pop: d.edge_pop });
        }
    });
});

describe('"What happened" — the drill-downs are not empty', () => {
    it('every category card can be drilled into', () => {
        // The tab filters this axis CLIENT-side against `violation_categories`,
        // so a card with no matching row opens an empty table under a heading
        // that names the category — which reads as a product bug.
        const rows = ROUTES['GET /api/usage/guardrails/recent'](ctx());
        for (const c of ROUTES['GET /api/usage/guardrails/overview'](ctx()).top_categories.slice(0, 5)) {
            const hit = rows.some(r => String(r.violation_categories).toLowerCase().includes(c.category.toLowerCase()));
            expect(hit, `no sample event carries category "${c.category}"`).toBe(true);
        }
    });

    it('every destination card can be drilled into', () => {
        const rows = ROUTES['GET /api/usage/integrations/egress'](ctx());
        for (const d of ROUTES['GET /api/usage/integrations/overview'](ctx()).top.non_eu_destinations) {
            expect(rows.some(r => r.dest_host === d.dest_host), `no sample call to "${d.dest_host}"`).toBe(true);
        }
    });

    it('no row names a health category next to a person, as the server never does', () => {
        // GDPR Art. 9: health is an organisation total only. The server strips
        // it from every row that carries a user (core/privacy/specialCategories.js);
        // a demo row with one would show what the product never shows.
        const guard = ROUTES['GET /api/usage/guardrails/recent'](ctx({ query: new URLSearchParams('limit=200') }));
        const calls = ROUTES['GET /api/usage/integrations/egress'](ctx({ query: new URLSearchParams('limit=200') }));
        const named = [
            ...guard.map(r => r.violation_categories),
            ...calls.map(r => r.pii_categories_detected),
        ].flatMap(v => String(v || '').split(',')).filter(isSpecialCategory);
        expect(named).toEqual([]);
        // The total is still there.
        const totals = ROUTES['GET /api/usage/guardrails/overview'](ctx()).top_categories;
        expect(totals.some(c => isSpecialCategory(c.category) && c.count > 0)).toBe(true);
    });

    it('every person card can be drilled into', () => {
        for (const u of ROUTES['GET /api/usage/guardrails/overview'](ctx()).top_users.slice(0, 5)) {
            const rows = ROUTES['GET /api/usage/guardrails/recent']({
                ...ctx(), query: new URLSearchParams(`user=${u.user_id}`),
            });
            expect(rows.length, `no sample event for ${u.user_id}`).toBeGreaterThan(0);
            expect(rows.every(r => r.user_id === u.user_id)).toBe(true);
        }
    });

    it('the "outside Europe" drill returns only calls that left Europe', () => {
        // `query` is a URLSearchParams. Reading it as a plain object returns
        // undefined, the filter passes everything, and the fold renders EU
        // rows under the heading "Outside Europe".
        const rows = ROUTES['GET /api/usage/integrations/egress']({
            ...ctx(), query: new URLSearchParams('eu=false'),
        });
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every(r => r.is_eu === false)).toBe(true);
    });

    it('honours the row limit', () => {
        expect(ROUTES['GET /api/usage/guardrails/recent']({
            ...ctx(), query: new URLSearchParams('limit=3'),
        })).toHaveLength(3);
    });
});

describe('"Your own data"', () => {
    const doc = shieldDoc();
    const post = (path, body) => ROUTES[`POST /api/org-privacy-shield/:orgId/custom-data/${path}`](ctx({ body }));
    const type = (id) => doc.customDataTypes.find(t => t.id === id);

    it('has one type per method, with contract-shaped ids and free placeholders', () => {
        const types = doc.customDataTypes;
        expect(types.map(t => t.method).sort()).toEqual(['ai', 'pattern', 'words']);
        for (const t of types) expect(t.id).toMatch(CUSTOM_ID);
        const legacy = type(LEGACY_ID);
        expect(legacy).toMatchObject({ origin: 'migrated', legacy: true, tokenKey: 'customterm' });
        // Migrated terms stay hidden from the AI and are kept from tools.
        expect(doc.piiDetectionCategories).toContain(LEGACY_ID);
        expect(doc.toolPiiPolicy.external.blockCategories).not.toContain(LEGACY_ID);
    });

    it('keeps tests only for types that exist, with gold on the real examples', () => {
        for (const [id, tests] of Object.entries(doc.customDataTests)) {
            expect(type(id), `tests for unknown type ${id}`).toBeDefined();
            for (const s of tests.sentences) {
                for (const g of s.gold || []) expect(tests.examples).toContain(s.text.slice(g.start, g.end));
            }
            expect(tests.sentences.length).toBeLessThanOrEqual(40);
        }
    });

    it('shows the assistant look-alikes only: same shape, never the real value', () => {
        const examples = doc.customDataTests[POLIS_ID].examples;
        const res = post('assist/preview', { type: { ...type(POLIS_ID) }, examples, keepFixed: ['PN-'] });
        expect(res.keepFixedProposal).toEqual(['PN-']);
        res.outbound.lookalikes.forEach((l, i) => {
            expect(l).not.toBe(examples[i]);
            expect(l).toMatch(/^PN-\d{7}$/);
        });
    });

    it('writes sentences that carry the real examples, marked', () => {
        const examples = doc.customDataTests[POLIS_ID].examples;
        const res = post('assist', { type: type(POLIS_ID), examples, expectLookalikes: [] });
        expect(res.sentences.length).toBeGreaterThanOrEqual(5);
        for (const s of res.sentences) expect(examples).toContain(s.text.slice(s.gold[0].start, s.gold[0].end));
        expect(res.nearMisses.every(s => Array.isArray(s.gold) && s.gold.length === 0)).toBe(true);
    });

    it('tests a fixed format with the matcher\'s own rules, and previews one sentence', () => {
        const t = type(POLIS_ID);
        const res = post('test', { type: t, sentences: doc.customDataTests[POLIS_ID].sentences });
        expect(res.summary).toMatchObject({ found: 3, total: 3, falseAlarms: 0 });
        const one = post('test', { type: t, sentences: [{ id: 'try', text: 'Polis PN-1234567 loopt af.' }] });
        expect(one.results[0].marks).toEqual([{ start: 6, end: 16, kind: 'found' }]);
        expect(one.preview).toBe('Polis [polisnummer_1] loopt af.');
    });

    it('matches a list of words as whole words by default', () => {
        const t = type(LEGACY_ID);
        const res = post('test', { type: t, sentences: [{ id: 'a', text: 'Het schadedossier en schadedossiers' }] });
        expect(res.results[0].marks).toEqual([{ start: 4, end: 17, kind: 'found' }]);
    });

    it('needs five marked sentences before it tunes, then tunes the AI type', () => {
        const t = type(PROJECT_ID);
        const few = post('tune', { type: t, sentences: doc.customDataTests[PROJECT_ID].sentences, examples: [] });
        expect(few).toBeInstanceOf(Response);
        expect(few.status).toBe(400);
        const sentences = [
            ...doc.customDataTests[PROJECT_ID].sentences,
            { id: 'x1', text: 'Tureluur gaat live.', gold: [{ start: 0, end: 8 }] },
            { id: 'x2', text: 'Status Grutto: groen.', gold: [{ start: 7, end: 13 }] },
        ];
        const res = post('tune', { type: t, sentences, examples: [] });
        expect(res.improved).toBe(true);
        expect(res.best.summary.falseAlarms).toBeLessThan(res.before.summary.falseAlarms);
        expect(res.best.config.ai.floor).toBeGreaterThan(t.ai.floor);
    });
});
