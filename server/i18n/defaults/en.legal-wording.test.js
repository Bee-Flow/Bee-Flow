/**
 * The legal claims the Compliance Center's English strings make, pinned to
 * what the law actually says (round 2 legal-wording review, 7 Oct 2026).
 *
 * Each test names the provision a string cites and asserts the element that
 * was missing or wrong before: who a duty binds, from when it applies, and
 * which article carries it. The wording around those elements may change
 * freely; the legal element may not quietly drop out again.
 *
 * Pure: reads the merged English dictionary and the ISO policy seeds.
 *
 * Run: cd server && node --test i18n/defaults/en.legal-wording.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { GUI_DEFAULTS } = require('./en');
const { POLICY_SEEDS } = require('../../compliance/iso/policySeeds');

function s(key) {
    const value = GUI_DEFAULTS[`compliance.${key}`];
    assert.equal(typeof value, 'string', `compliance.${key} is in the dictionary`);
    return value;
}

// ── AI Act ────────────────────────────────────────────────────────────────

test('AI Act Art. 53 binds GPAI model providers; the workspace record is not an Art. 53 duty', () => {
    // The ladder records a deployer's own classification: no Art. 53 attribution.
    assert.doesNotMatch(s('ladder_outcome_note'), /Art\. 53/);
    assert.match(s('ladder_outcome_note'), /model inventory/);

    const art53 = s('checks.aia_art53.desc');
    assert.match(art53, /providers of general-purpose AI models/);
    assert.match(art53, /Art\. 53\(1\)\(a\)/);
    assert.match(art53, /Art\. 53\(1\)\(b\)/);
    // The per-provider safeguard is a GDPR matter, not an AI Act one.
    assert.match(art53, /GDPR Art\. 28\/46/);
});

test('AI Act Art. 13 is a high-risk duty towards deployers, from 2 Dec 2027; AI disclosure is Art. 50(1)', () => {
    const art13 = s('checks.aia_art13.desc');
    assert.match(art13, /high-risk/);
    assert.match(art13, /deployers/);
    assert.match(art13, /2 Dec 2027/);
    assert.match(art13, /Art\. 50\(1\)/);
});

test('the high-risk ladder outcome says the duties apply from 2 Dec 2027 and splits provider and deployer', () => {
    const outcome = s('ladder_outcome_high_risk');
    assert.match(outcome, /From 2 Dec 2027/);
    assert.match(outcome, /provider: Art\. 9, 11, 14/);
    assert.match(outcome, /deployer: Art\. 26/);
});

test('Art. 50(2) requires machine-readable marking only; the visible note is what Bee Flow adds', () => {
    const hint = s('set_ai_marking_hint');
    const art50Sentence = hint.split(/(?<=\.)\s+(?=[A-Z])/).find(part => part.includes('Art. 50(2)'));
    assert.ok(art50Sentence, 'one sentence cites Art. 50(2)');
    assert.match(art50Sentence, /machine-readable/);
    assert.doesNotMatch(art50Sentence, /visible/, 'the visible note is not part of the Art. 50(2) requirement');
    assert.match(hint, /Bee Flow also adds a visible note/);
});

// ── GDPR ──────────────────────────────────────────────────────────────────

test('GDPR Art. 12(3): DSR strings speak of one month, extendable by at most two further months', () => {
    const keys = [
        'nav_dsr_desc', 'dsr_subtitle', 'checks.gdpr_art15.desc', 'checks.gdpr_art15.fix',
        'checks.gdpr_art17.desc', 'checks.gdpr_art17.fix', 'dsr_error_already_extended',
        'ovw_deadlines_hint', 'hdr_dsr_window', 'dsr_toast_captured', 'dsr_intake_note',
        'dsr_capture_desc', 'dsr_pf_intro',
    ];
    for (const key of keys) assert.doesNotMatch(s(key), /30[- ]day/, `${key} speaks of months`);
    assert.doesNotMatch(s('dsr_error_already_extended'), /single extension/);
    assert.match(s('dsr_error_already_extended'), /at most two further months/);
    // The extension adds two calendar months (dsrStore.extend), not 60 days.
    for (const key of ['dsr_extend_60', 'dsr_extend_confirm', 'dsr_toast_extended']) {
        assert.doesNotMatch(s(key), /60/, `${key} speaks of months`);
        assert.match(s(key), /(2|two) months/, `${key} names the two-month extension`);
    }
});

test('GDPR Art. 12(3): the public request form promises one month from receipt, extendable by two further months', () => {
    // A data subject reads this line without an account; it is the promise the controller makes.
    const subtitle = GUI_DEFAULTS['dsr_public.subtitle'];
    assert.doesNotMatch(subtitle, /30[- ]days?/);
    assert.match(subtitle, /one month of receipt/);
    assert.match(subtitle, /two further months where necessary/);
});

test('GDPR Chapter V: an adequacy decision or SCCs make a transfer lawful; a DPA alone does not', () => {
    const art44 = s('checks.gdpr_art44.desc');
    assert.match(art44, /outside the EEA/);
    assert.match(art44, /adequacy decision \(Art\. 45/);
    assert.match(art44, /SCCs \(Art\. 46\)/);
    assert.match(art44, /DPA \(Art\. 28\) on its own is not a transfer tool/);
    assert.doesNotMatch(art44, /SCCs\/DPA/);
});

test('GDPR Art. 35(7): the DPIA hint names all four elements, the risk assessment included', () => {
    const hint = s('dpia_questionnaire_hint');
    assert.match(hint, /purposes/);
    assert.match(hint, /necessity and proportionality/);
    assert.match(hint, /risks to the rights and freedoms/);
    assert.match(hint, /measures/);
});

// ── DORA ──────────────────────────────────────────────────────────────────

test('DORA incidents: 4 h / 24 h is the financial entity\'s clock; the provider is bound through Art. 30', () => {
    const desc = s('check_dora_incident_path_desc');
    assert.match(desc, /within 4 hours of classifying it/);
    assert.match(desc, /no later than 24 hours after becoming aware/);
    assert.match(desc, /DORA Art\. 19/);
    assert.match(desc, /2025\/301/);
    assert.match(desc, /Art\. 30\(2\)\(f\)/);
    // Art. 30(3)(b) only binds contracts for critical or important functions.
    assert.match(desc, /for services supporting critical or important functions[^.]*Art\. 30\(3\)\(b\)/);
    assert.doesNotMatch(desc, /you must notify them promptly/);
});

test('DORA Art. 28(3): the register is the financial entity\'s duty; the provider hands over its supply chain', () => {
    const desc = s('check_dora_register_desc');
    assert.match(desc, /requires your financial customers to keep a register/);
    assert.match(desc, /2024\/2956/);
    assert.match(desc, /subcontractors/);
});

test('DORA Art. 30: audit rights and exit strategies are Art. 30(3), for critical or important functions only', () => {
    const desc = s('check_dora_contract_clauses_desc');
    const extra = desc.indexOf('Art. 30(3)');
    assert.match(desc, /Art\. 30\(2\)/);
    assert.ok(extra > 0, 'Art. 30(3) is named');
    assert.match(desc.slice(0, extra), /data access and return/);
    assert.ok(desc.indexOf('audit') > extra, 'audit rights are listed under Art. 30(3)');
    assert.ok(desc.indexOf('exit') > extra, 'exit strategies are listed under Art. 30(3)');
    assert.match(desc.slice(0, extra), /critical or important function/);
});

test('DORA applies from 17 Jan 2025 (it entered into force in 2023): the milestone says "applies"', () => {
    assert.equal(s('cal_ms_dora_in_force_label'), 'DORA applies');
    assert.equal(s('fw_dora_phase_in_force'), 'applies');
});

// ── NIS2 / CRA ────────────────────────────────────────────────────────────

test('NIS2: the framework name points at the Dutch Cyberbeveiligingswet, not the EU Cybersecurity Act', () => {
    assert.equal(s('fw_nis2_name'), 'NIS2 · Dutch Cybersecurity Act (Cbw)');
});

test('CRA notified bodies: any product can involve one through a third-party module (Art. 32(1))', () => {
    const detail = s('cal_ms_cra_notified_bodies_detail');
    assert.doesNotMatch(detail, /only for important and critical/);
    assert.match(detail, /mainly for important \(Annex III\) and critical \(Annex IV\)/);
    assert.match(detail, /Art\. 32\(1\)/);
});

// ── Data Act ──────────────────────────────────────────────────────────────

test('Data Act Art. 50: older contracts are caught when indefinite or expiring 10 years from 11 Jan 2024', () => {
    const detail = s('cal_ms_data_act_chapter_iv_legacy_contracts_detail');
    assert.match(detail, /of indefinite duration/);
    assert.match(detail, /due to expire at least ten years from 11 Jan 2024/);
    assert.match(detail, /not before 11 Jan 2034/);
    assert.doesNotMatch(detail, /run indefinitely or for at least ten years/);
});

test('Data Act Art. 3(1) binds providers of related services too', () => {
    assert.match(s('cal_ms_data_act_connected_products_detail'),
        /only for manufacturers of connected products and providers of related services$/);
});

test('Data Act applies from 12 Sep 2025 (it entered into force on 11 Jan 2024): the label says "applies"', () => {
    assert.equal(s('fw_data_act_phase_in_force'), 'applies');
    assert.equal(s('cal_ms_data_act_in_force_label'), 'Data Act applies');
});

test('Data Act Art. 30(5): the export format is structured, commonly used AND machine-readable', () => {
    const desc = s('check_data_act_formats_desc');
    assert.match(desc, /structured, commonly used and machine-readable format \(Data Act Art\. 30\(5\)\)/);
    // The examples are formats the check itself accepts.
    assert.match(desc, /JSON, CSV, ZIP or DOCX/);
});

// ── EAA ───────────────────────────────────────────────────────────────────

test('EAA Art. 2(2): the service list includes consumer banking and access to audiovisual media services', () => {
    for (const key of ['fw_eaa_desc', 'cal_ms_eaa_in_force_detail']) {
        assert.match(s(key), /consumer banking/, key);
        assert.match(s(key), /access to audiovisual media services/, key);
        assert.match(s(key), /passenger transport/, key);
    }
});

test('EAA standard: V3.2.1 (WCAG 2.1 AA) is the reference until V4.1.1 (WCAG 2.2 AA) is cited in the OJ', () => {
    for (const key of ['fw_eaa_desc', 'cal_ms_eaa_in_force_detail', 'check_eaa_webpage_a11y_desc']) {
        assert.match(s(key), /V3\.2\.1/, key);
        assert.match(s(key), /V4\.1\.1/, key);
        assert.match(s(key), /WCAG 2\.2 AA/, key);
        assert.match(s(key), /Official Journal/, key);
    }
    assert.doesNotMatch(s('fw_eaa_desc'), /which means WCAG 2\.1 AA/);
    assert.doesNotMatch(s('check_eaa_webpage_a11y_desc'), /^Public pages must meet WCAG 2\.1 AA/);
    assert.match(s('check_eaa_webpage_a11y_desc'), /presumption of conformity/);
});

// ── PLD ───────────────────────────────────────────────────────────────────

test('PLD: the Dutch implementing bill is named while it is still pending', () => {
    assert.match(s('cal_ms_pld_in_force_detail'), /bill 36906/);
    assert.match(s('cal_ms_pld_in_force_detail'), /not yet adopted/);
});

test('PLD: a substantial modification restarts the Art. 17(1)(b) expiry period; Art. 8(2) is who becomes manufacturer', () => {
    const desc = s('check_pld_release_record_desc');
    assert.match(desc, /restarts the 10-year expiry period[^;.]*\(Art\. 17\(1\)\(b\)\)/);
    assert.match(desc, /outside the manufacturer's control[^.]*\(Art\. 8\(2\)\)/);
    assert.doesNotMatch(desc, /new liability window/);
});

// ── Machinery Regulation ──────────────────────────────────────────────────

test('Machinery Art. 3(3): software is a safety component only when it is placed on the market on its own', () => {
    for (const key of ['fw_machinery_desc', 'check_machinery_detection_desc', 'mach_intro']) {
        const first = s(key).split(/(?<=\.)\s+(?=[A-Z])/)[0];
        assert.match(first, /placed on the market on its own/, key);
        assert.match(first, /Art\. 3\(3\)/, key);
    }
    assert.match(s('fw_machinery_desc'), /Art\. 18/);
});

// ── ISO 27001 ─────────────────────────────────────────────────────────────

test('ISO 27001: the exit procedure maps to supplier and cloud-exit controls, and its description says so', () => {
    const seed = POLICY_SEEDS.find(p => p.slug === 'exit-procedure');
    assert.ok(seed, 'the exit-procedure policy seed exists');
    // A.5.29/A.5.30 are continuity controls (the business-continuity seed has them).
    assert.deepEqual([...seed.controls].sort(), ['A.5.20', 'A.5.23']);
    const desc = s('policy_seed_exit_procedure_desc');
    for (const control of seed.controls) assert.ok(desc.includes(control), `the description names ${control}`);
    assert.doesNotMatch(desc, /A\.5\.29|A\.5\.30/);
    assert.match(desc, /Data Act switching rights \(Art\. 23, 25\)/);
});
