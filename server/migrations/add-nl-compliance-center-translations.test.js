/**
 * The Compliance Center's Dutch catalogue is data-driven (see the migration's
 * header); these are the same rules every hand-written add-nl-* catalogue
 * answers to, applied to the generated map.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, MAP_PATH } = require('./add-nl-compliance-center-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

// The families the redesign owns. Every English key under one of these must
// have Dutch (or be declared identical) — the direction that decides whether
// a Dutch DPO sees Dutch.
const OWNED_PREFIXES = [
    'compliance.rail_', 'compliance.hdr_', 'compliance.tab_', 'compliance.ovw_', 'compliance.tbl_', 'compliance.clock_',
    'compliance.seg_', 'compliance.cal_', 'compliance.ladder_', 'compliance.setup_', 'compliance.mob_', 'compliance.pf_',
    'compliance.mach_', 'compliance.custom_', 'compliance.check_', 'compliance.fw_nis2', 'compliance.fw_cra', 'compliance.fw_data_act',
    'compliance.fw_pld', 'compliance.fw_eaa', 'compliance.fw_dora', 'compliance.fw_machinery', 'compliance.fw_gdpr_', 'compliance.fw_aia_',
    'compliance.fw_iso27001_', 'compliance.fw_toast_', 'compliance.reg_', 'compliance.score_aria', 'compliance.page_pending',
    'compliance.back_to_settings', 'compliance.dsr_toast_captured', 'compliance.dsr_toast_extend_failed', 'compliance.vuln_',
    'common.previous', 'common.pager_range',
];
const owned = (k) => OWNED_PREFIXES.some((p) => k.startsWith(p));

test('the generated NL map exists and is non-trivial', () => {
    assert.ok(fs.existsSync(MAP_PATH), `${path.relative(process.cwd(), MAP_PATH)} is missing — run node server/scripts/mergeComplianceKeys.mjs`);
    assert.ok(Object.keys(NL_TRANSLATIONS).length > 100, 'fewer than 100 Dutch keys — the merge did not run over the keys files');
});

test('every Dutch key exists in the English catalog', () => {
    const orphans = [...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH].filter((k) => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, [],
        'these Dutch keys have no English counterpart — run the merge script so both dictionaries carry them');
});

test('no Dutch value is blank or the English one copied over', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k} was never actually translated`);
    }
});

test('identical values are only ever proper names or shared words', () => {
    // A Dutch value equal to the English is allowed only for short terms — a
    // full sentence that survived untranslated is a stream that skipped the NL column.
    // "A sentence" = three or more plain lower-case words; proper names ("CRA · Cyber
    // Resilience Act"), placeholders ("{n} · sweep {time}") and article refs pass.
    const lowerWords = (s) => (String(s).match(/\b[a-z]{3,}\b/g) || []).length;
    const suspicious = SAME_AS_ENGLISH.filter((k) => lowerWords(GUI_DEFAULTS[k]) >= 3);
    assert.deepStrictEqual(suspicious, [], 'sentences identical in both languages — translate them in the stream\'s keys file');
});

test('every English compliance-redesign key has a Dutch one (or is declared identical)', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS).filter((k) => owned(k) && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('placeholders survive translation', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        const en = GUI_DEFAULTS[k] || '';
        const want = [...en.matchAll(/\{([a-z_]+)\}/gi)].map((m) => m[1]).sort();
        const have = [...String(v).matchAll(/\{([a-z_]+)\}/gi)].map((m) => m[1]).sort();
        assert.deepStrictEqual(have, want, `${k}: placeholders differ — EN "${en}" vs NL "${v}"`);
    }
});

test('the boot ladder runs this catalogue', () => {
    const src = fs.readFileSync(require.resolve('../boot/bootMigrations.js'), 'utf8');
    assert.ok(src.includes("'add-nl-compliance-center-translations'"), 'not listed in boot/bootMigrations.js NL_TRANSLATIONS');
});
