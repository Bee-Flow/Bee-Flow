/**
 * Framework catalogue — the static facts every other compliance module leans
 * on: unique ids and codes, parseable dates, the AI Act's per-article dates,
 * the fixed core set, and a dictionary entry for every label key.
 *
 * Pure module (no db, no licence layer) — nothing to stub.
 *
 * Run: cd server && node --test --test-force-exit compliance/frameworks.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const fw = require('./frameworks');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

// The redesign streams may not edit the dictionaries; every new key is dropped
// in .claude/handoff/compliance/keys/<stream>.json and the integrator merges
// those files into server/i18n/defaults/en.js (and the client copy) in Wave 2.
// Until that merge, this stream's keys file is the second place a key may live.
// After the merge the file may be deleted — the en.js lookup then carries it.
const KEYS_FILE = path.join(__dirname, '..', '..', '.claude', 'handoff', 'compliance', 'keys', 'be-registry-runner.json');
function pendingKeys() {
    if (!fs.existsSync(KEYS_FILE)) return { en: {}, nl: {} };
    return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
}
const pending = pendingKeys();
const hasKey = (key) => Object.prototype.hasOwnProperty.call(GUI_DEFAULTS, key)
    || Object.prototype.hasOwnProperty.call(pending.en || {}, key);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const parses = (d) => ISO_DATE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`))
    && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

test('ten built-in frameworks with unique ids and unique regulation codes', () => {
    const all = fw.listBuiltin();
    assert.equal(all.length, 10);
    assert.equal(new Set(all.map(f => f.id)).size, all.length, 'duplicate framework id');
    assert.equal(new Set(all.map(f => f.regulation)).size, all.length, 'duplicate regulation code');
    assert.equal(new Set(all.map(f => f.checks_dir)).size, all.length, 'two frameworks share a checks dir');
    assert.equal(new Set(all.map(f => f.capability)).size, all.length, 'two frameworks share a capability');
    for (const f of all) {
        assert.match(f.id, /^[a-z][a-z0-9_]*$/, `${f.id}: id must be a lowercase slug`);
        assert.match(f.regulation, /^[A-Z][A-Z0-9_]*$/, `${f.id}: regulation must be an uppercase code`);
        assert.match(f.capability, /^compliance_hub_[a-z0-9_]+$/, `${f.id}: capability keeps the compliance_hub_ prefix`);
        assert.ok(f.id_pattern instanceof RegExp, `${f.id}: id_pattern must be a RegExp`);
        assert.ok(Array.isArray(f.registers), `${f.id}: registers must be an array`);
        assert.equal(typeof f.regulation_code, 'string');
        assert.ok(f.regulation_code.length > 0);
    }
});

test('listBuiltin returns a copy; the catalogue itself is frozen', () => {
    const a = fw.listBuiltin();
    a.push({ id: 'bogus' });
    assert.equal(fw.listBuiltin().length, 10);
    assert.throws(() => { fw.FRAMEWORKS[0].id = 'x'; }, TypeError);
    assert.throws(() => { fw.byId('aia').phases.push({}); }, TypeError);
});

test('the core set is exactly gdpr, aia, iso27001', () => {
    assert.deepEqual([...fw.CORE_IDS].sort(), ['aia', 'gdpr', 'iso27001']);
    for (const f of fw.listBuiltin()) {
        assert.equal(f.core, fw.CORE_IDS.includes(f.id), `${f.id}: core flag disagrees with CORE_IDS`);
    }
});

test('every date in the catalogue parses as a real calendar day', () => {
    for (const f of fw.listBuiltin()) {
        for (const d of [f.in_force_since, f.in_force_from]) {
            if (d !== null) assert.ok(parses(d), `${f.id}: bad date ${d}`);
        }
        assert.ok(!(f.in_force_since && f.in_force_from), `${f.id}: a framework is either in force or ahead, not both`);
        for (const p of f.phases) {
            assert.ok(parses(p.date), `${f.id}: bad phase date ${p.date}`);
            assert.match(p.label_key, new RegExp(`^compliance\\.fw_${f.id}_phase_[a-z0-9_]+$`), `${f.id}: phase key ${p.label_key}`);
        }
        for (const [ref, d] of Object.entries(f.articles)) {
            assert.ok(parses(d), `${f.id}: bad article date ${ref} → ${d}`);
        }
        // Phases are listed in chronological order — the timeline renders them as given.
        const dates = f.phases.map(p => p.date);
        assert.deepEqual(dates, [...dates].sort(), `${f.id}: phases out of order`);
    }
    for (const m of fw.MILESTONES) {
        if (m.kind === 'uncertain') {
            assert.equal(m.date, null, `${m.id}: an uncertain milestone has no date`);
            assert.match(m.expected, /^\d{4}-Q[1-4]$/, `${m.id}: expected quarter`);
        } else {
            assert.ok(parses(m.date), `${m.id}: bad milestone date ${m.date}`);
            assert.equal(m.expected, null);
        }
    }
});

test('the dated in-force facts of BRIEF §1.4', () => {
    const since = (id) => fw.byId(id).in_force_since;
    const from = (id) => fw.byId(id).in_force_from;
    assert.equal(since('gdpr'), '2018-05-25');
    assert.equal(since('aia'), '2024-08-01');
    assert.equal(since('iso27001'), null);
    assert.equal(from('iso27001'), null);
    assert.equal(since('nis2'), '2026-08-15');
    assert.equal(since('cra'), '2026-09-11');
    assert.equal(since('data_act'), '2025-09-12');
    assert.equal(from('pld'), '2026-12-09');
    assert.equal(since('eaa'), '2025-06-28');
    assert.equal(since('dora'), '2025-01-17');
    assert.equal(from('machinery'), '2027-01-20');
    assert.ok(fw.byId('cra').phases.some(p => p.date === '2027-12-11'), 'CRA in full on 11 Dec 2027');
    assert.ok(fw.byId('data_act').phases.some(p => p.date === '2027-01-12'), 'switching charges abolished');
    assert.ok(fw.byId('eaa').phases.some(p => p.date === '2030-06-28'), 'EAA legacy contracts');
    assert.equal(fw.byId('dora').relevance_gate, true);
    assert.equal(fw.byId('machinery').relevance_gate, true);
    assert.deepEqual(fw.byId('nis2').registers, ['incidents']);
    assert.deepEqual(fw.byId('cra').registers, ['vulnerabilities']);
    assert.deepEqual(fw.byId('data_act').registers, ['portability']);
});

test('inForceSince: the AI Act answers per article, everything else per framework', () => {
    assert.equal(fw.inForceSince('AIA', '50'), '2026-08-02');
    assert.equal(fw.inForceSince('AIA', '50(2)'), '2026-08-02');
    assert.equal(fw.inForceSince('AIA', 'Art. 50'), '2026-08-02', 'the "Art." spelling the newer checks use');
    assert.equal(fw.inForceSince('AIA', '4'), '2025-02-02');
    assert.equal(fw.inForceSince('AIA', '5'), '2025-02-02');
    assert.equal(fw.inForceSince('AIA', '53'), '2025-08-02');
    assert.equal(fw.inForceSince('AIA', 'annex_iii'), '2027-12-02');
    assert.equal(fw.inForceSince('AIA', 'Annex III'), '2027-12-02');
    assert.equal(fw.inForceSince('AIA', 'annex_i'), '2028-08-02');
    // A paragraph of an article without its own override falls back to the
    // article: Art. 26(6) logs follow Art. 26, a Chapter III high-risk duty
    // that applies with Annex III (Reg. (EU) 2026/1744), not since 2024.
    assert.equal(fw.inForceSince('AIA', '26(6)'), '2027-12-02', 'paragraph → its article');
    assert.equal(fw.inForceSince('AIA', '13'), '2027-12-02');
    // An article with no override at all → the framework date.
    assert.equal(fw.inForceSince('AIA', '9'), '2024-08-01', 'no override → the framework date');
    // Non-staggered frameworks ignore the ref.
    assert.equal(fw.inForceSince('GDPR', '32'), '2018-05-25');
    assert.equal(fw.inForceSince('NIS2', 'Art. 21(2)(j)'), '2026-08-15');
    // Ahead-of-today frameworks answer with their start date.
    assert.equal(fw.inForceSince('PLD', '9'), '2026-12-09');
    assert.equal(fw.inForceSince('MACHINERY', '3'), '2027-01-20');
    // A standard and an unknown code have no date.
    assert.equal(fw.inForceSince('ISO27001', 'A.5.24'), null);
    assert.equal(fw.inForceSince('NOPE', '1'), null);
    assert.equal(fw.inForceSince('CUSTOM', 'Q3.1'), null);
});

test('regulationCodes: GDPR, AIA, ISO27001 first, then the rest, CUSTOM last', () => {
    const codes = fw.regulationCodes();
    assert.deepEqual(codes.slice(0, 3), ['GDPR', 'AIA', 'ISO27001']);
    assert.equal(codes[codes.length - 1], 'CUSTOM');
    assert.deepEqual(codes, ['GDPR', 'AIA', 'ISO27001', 'NIS2', 'CRA', 'DATA_ACT', 'PLD', 'EAA', 'DORA', 'MACHINERY', 'CUSTOM']);
    assert.equal(fw.CUSTOM_REGULATION, 'CUSTOM');
});

test('id ↔ regulation ↔ capability conversions, including custom ids', () => {
    assert.equal(fw.frameworkIdOf('GDPR'), 'gdpr');
    assert.equal(fw.frameworkIdOf('DATA_ACT'), 'data_act');
    assert.equal(fw.frameworkIdOf('PLD'), 'pld');
    assert.equal(fw.frameworkIdOf('CUSTOM'), null, 'one custom framework per org — no static id');
    assert.equal(fw.frameworkIdOf('NOPE'), null);
    assert.equal(fw.regulationOf('iso27001'), 'ISO27001');
    assert.equal(fw.regulationOf('custom:3f0a'), 'CUSTOM');
    assert.equal(fw.regulationOf('nope'), null);
    assert.equal(fw.capabilityOf('nis2'), 'compliance_hub_nis2');
    assert.equal(fw.capabilityOf('custom:3f0a'), 'compliance_hub_custom');
    assert.equal(fw.capabilityOf('nope'), null);
    assert.equal(fw.isCustomId('custom:3f0a'), true);
    assert.equal(fw.isCustomId('customary'), false);
    assert.equal(fw.isCustomId(null), false);
    assert.equal(fw.byRegulation('CRA').id, 'cra');
    assert.equal(fw.byRegulation('CUSTOM'), null);
    assert.equal(fw.byId('nope'), null);
});

test('id_pattern accepts the ids that ship and rejects foreign prefixes', () => {
    const ok = {
        gdpr: ['GDPR-Art32-encryption-at-rest', 'GDPR-Art5-1-e-storage-limitation'],
        aia: ['AIA-Art50-ai-disclosure', 'AIA-Art26-6-log-retention'],
        iso27001: ['ISO27001-A.5.24-incident-mgmt', 'ISO27001-cl9.2-internal-audit'],
        nis2: ['NIS2-Art21(2)(j)-admin-mfa', 'NIS2-Art3-registration'],
        cra: ['CRA-Art14-vuln-reporting-clocks', 'CRA-AnnexI-II1-sbom'],
        data_act: ['DATA_ACT-Art30-export-coverage'],
        pld: ['PLD-Art9-release-record'],
        eaa: ['EAA-Art4-webpage-a11y'],
        dora: ['DORA-Art30-incident-reporting-path'],
        machinery: ['MACHINERY-Art3-industrial-detection'],
    };
    for (const [id, ids] of Object.entries(ok)) {
        const f = fw.byId(id);
        for (const checkId of ids) assert.match(checkId, f.id_pattern, `${id} should accept ${checkId}`);
        // Every OTHER framework must reject them — a check can only live in one home.
        for (const other of fw.listBuiltin()) {
            if (other.id === id) continue;
            for (const checkId of ids) assert.doesNotMatch(checkId, other.id_pattern, `${other.id} must reject ${checkId}`);
        }
    }
    assert.doesNotMatch('GDPR-Art32', fw.byId('gdpr').id_pattern, 'an id needs a slug');
    assert.doesNotMatch('NIS2-21-admin-mfa', fw.byId('nis2').id_pattern, 'an id needs the Art prefix');
});

test('MILESTONES: the 20 dated dates plus the 2 uncertain ones, each pointing at a known framework', () => {
    const dated = fw.MILESTONES.filter(m => m.kind !== 'uncertain');
    const uncertain = fw.MILESTONES.filter(m => m.kind === 'uncertain');
    assert.equal(dated.length, 20);
    assert.deepEqual(uncertain.map(m => m.id), ['omnibus_data_part', 'nl_uitvoeringswet_ai']);
    assert.equal(new Set(fw.MILESTONES.map(m => m.id)).size, fw.MILESTONES.length, 'duplicate milestone id');
    const dates = dated.map(m => m.date);
    assert.deepEqual(dates, [...dates].sort(), 'dated milestones are chronological');
    const byId = Object.fromEntries(fw.MILESTONES.map(m => [m.id, m]));
    assert.equal(byId.aia_art50_enforcement.date, '2026-08-02');
    assert.equal(byId.nis2_in_force.date, '2026-08-15');
    assert.equal(byId.cra_reporting_duty.date, '2026-09-11');
    assert.equal(byId.aia_marking_transition_end.date, '2026-12-02');
    assert.equal(byId.aia_marking_transition_end.affects_kind, 'marking');
    assert.equal(byId.pld_in_force.date, '2026-12-09');
    assert.equal(byId.data_act_switching_charges.date, '2027-01-12');
    assert.equal(byId.machinery_in_force.date, '2027-01-20');
    assert.equal(byId.aia_annex_iii.date, '2027-12-02');
    assert.equal(byId.cra_full.date, '2027-12-11');
    assert.equal(byId.aia_annex_i.date, '2028-08-02');
    assert.equal(byId.eaa_legacy_contracts_end.date, '2030-06-28');
    // Added in the legal register review of 6 Oct 2026.
    assert.equal(byId.cra_notified_bodies.date, '2026-06-11');
    assert.equal(byId.data_act_connected_products.date, '2026-09-12');
    assert.equal(byId.aia_gpai_legacy_models.date, '2027-08-02');
    assert.equal(byId.data_act_chapter_iv_legacy_contracts.date, '2027-09-12');
    for (const m of fw.MILESTONES) {
        assert.ok(fw.byId(m.framework_id), `${m.id}: unknown framework ${m.framework_id}`);
        assert.ok(['in_force', 'phase', 'transition_end', 'uncertain'].includes(m.kind), `${m.id}: kind ${m.kind}`);
        assert.ok([null, 'marking', 'a11y', 'releases'].includes(m.affects_kind), `${m.id}: affects_kind ${m.affects_kind}`);
        assert.equal(m.label_key, `compliance.cal_ms_${m.id}_label`);
        assert.equal(m.detail_key, `compliance.cal_ms_${m.id}_detail`);
    }
    // Every framework phase inside the calendar's window appears on the
    // calendar too — the card timeline and the calendar must never disagree
    // on a date. (GDPR's 2018 start predates the window; the calendar starts
    // at DORA, Jan 2025.)
    const windowStart = dated[0].date;
    for (const f of fw.listBuiltin()) {
        for (const p of f.phases) {
            if (p.date < windowStart) continue;
            assert.ok(dated.some(m => m.framework_id === f.id && m.date === p.date),
                `${f.id} phase ${p.date} has no calendar milestone`);
        }
    }
});

test('every name/description/affects/phase/milestone key has EN and NL copy', () => {
    const keys = [];
    for (const f of fw.listBuiltin()) {
        keys.push(f.name_key, f.description_key, f.affects_key);
        for (const p of f.phases) keys.push(p.label_key);
    }
    for (const m of fw.MILESTONES) keys.push(m.label_key, m.detail_key);
    for (const key of keys) {
        assert.match(key, /^compliance\.(fw|cal_ms)_[a-z0-9_]+$/, `${key}: flat compliance.<area>_<name> style`);
        assert.ok(hasKey(key), `${key} exists neither in server/i18n/defaults/en.js nor in keys/be-registry-runner.json`);
    }
    // The keys file itself: EN and NL cover exactly the same keys, and none of
    // them is already in en.js under a different English (a duplicate key would
    // silently overwrite an existing string at merge time).
    const en = Object.keys(pending.en || {}).sort();
    const nl = Object.keys(pending.nl || {}).sort();
    assert.deepEqual(en, nl, 'EN and NL key sets diverge in keys/be-registry-runner.json');
    for (const k of en) {
        assert.ok(!Object.prototype.hasOwnProperty.call(GUI_DEFAULTS, k) || GUI_DEFAULTS[k] === pending.en[k],
            `${k} already exists in en.js with different English`);
        assert.ok(pending.en[k].trim() && pending.nl[k].trim(), `${k}: empty translation`);
    }
});

// ── Keeping the catalogue current ─────────────────────────────────────────

test('every built-in framework names an official source and the day it was checked', () => {
    const fw = require('./frameworks');
    for (const f of fw.listBuiltin()) {
        assert.ok(Array.isArray(f.sources) && f.sources.length > 0, `${f.id} has sources`);
        for (const src of f.sources) {
            assert.match(src.url, /^https:\/\//, `${f.id} source is https`);
            assert.ok(src.label && src.label.length > 3, `${f.id} source has a label`);
        }
        assert.match(f.legal_status_verified, /^\d{4}-\d{2}-\d{2}$/, `${f.id} has an ISO verification date`);
        assert.ok(Object.isFrozen(f.sources), `${f.id} sources are frozen`);
    }
});

test('legalReview: fresh inside the window, stale after it, and stale when nobody recorded a check', () => {
    const fw = require('./frameworks');
    const day = (iso) => Date.parse(`${iso}T12:00:00Z`);
    const entry = { legal_status_verified: '2026-10-01', sources: [{}] };
    assert.deepEqual(fw.legalReview(entry, day('2026-10-06')), {
        verified_on: '2026-10-01', age_days: 5, stale: false, stale_after_days: fw.LEGAL_REVIEW_STALE_DAYS, sources: 1,
    });
    assert.equal(fw.legalReview(entry, day('2026-12-30')).stale, false, 'day 90 is still inside');
    assert.equal(fw.legalReview(entry, day('2026-12-31')).stale, true, 'day 91 is stale');
    for (const bad of [{}, { legal_status_verified: 'last week' }, { legal_status_verified: '2026-13-45x' }, null]) {
        const r = fw.legalReview(bad, day('2026-10-06'));
        assert.equal(r.stale, true, JSON.stringify(bad));
        assert.equal(r.verified_on, null);
        assert.equal(r.age_days, null);
    }
});

test('catalogueReview vouches only for the OLDEST check and names every stale entry', () => {
    const fw = require('./frameworks');
    const now = Date.parse('2026-10-06T00:00:00Z');
    const list = [
        { id: 'a', legal_status_verified: '2026-10-01' },
        { id: 'b', legal_status_verified: '2026-06-01' },
    ];
    const r = fw.catalogueReview(now, list);
    assert.equal(r.verified_on, '2026-06-01');
    assert.equal(r.stale, true);
    assert.deepEqual(r.stale_ids, ['b']);
    const unknown = fw.catalogueReview(now, [...list, { id: 'c' }]);
    assert.equal(unknown.verified_on, null, 'an unchecked entry means the catalogue cannot vouch for a date');
    assert.deepEqual(unknown.stale_ids, ['b', 'c']);
});
