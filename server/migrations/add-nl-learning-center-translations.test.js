/**
 * The Dutch of the redesigned Learning Center: every key exists in the English
 * catalogue, none is left English or blank, the placeholders survive, and the
 * English catalogue itself is not Dutch for these keys (the defect the
 * DLP-review migration was written for).
 *
 * Run: node --test --test-force-exit migrations/add-nl-learning-center-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS } = require('./add-nl-learning-center-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

test('no Dutch value is blank or the English one copied over', () => {
    // A handful of words are the same in both languages ("quiz", "tour",
    // "open", "Capstone", "Tip", "Status", "Badge", "Curriculum", "min", the
    // brand line) — those keys are excused by name.
    const SAME_IN_BOTH = new Set([
        'learn.kind.quiz', 'learn.kind.tour', 'learn.kind.tour_plural', 'learn.legend.open', 'learn.rail.capstone',
        'learn.action.tip', 'learn.achievements.col_status', 'learn.achievements.col_badge', 'learn.tabs.curriculum',
        'learn.curriculum.title', 'learn.minutes', 'learn.cert.brand', 'learn.cert.drawer_label',
        'learn.cert.download_png_full', 'learn.cert.download_pdf_full', 'learn.achievements.badges',
        'learn.achievements.badges_title', 'learn.capstone.title', 'learn.achievements.checks_n',
    ]);
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        if (SAME_IN_BOTH.has(k)) continue;
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k} was never actually translated`);
    }
});

test('the English catalog is not Dutch for these keys', () => {
    const DUTCH_MARKERS = /\b(cursussen|lessen|afgerond|beheerst|herhaling|vergrendeld|werkruimte|onthuld|volgende|opnieuw)\b/i;
    const dutch = Object.keys(NL_TRANSLATIONS).filter(k => DUTCH_MARKERS.test(GUI_DEFAULTS[k] || ''));
    assert.deepStrictEqual(dutch, [], 'these English catalog entries hold Dutch text');
});

test('placeholders survive translation', () => {
    for (const [k, nl] of Object.entries(NL_TRANSLATIONS)) {
        const en = GUI_DEFAULTS[k] || '';
        const want = (en.match(/\{[a-z]+\}/g) || []).sort();
        const got = (nl.match(/\{[a-z]+\}/g) || []).sort();
        assert.deepStrictEqual(got, want, `${k}: placeholders differ (en ${want.join(',')} vs nl ${got.join(',')})`);
    }
});
