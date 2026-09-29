/**
 * compliance/marking — resolveMarking: flag, footer sources, memo.
 * Run: node --test --test-force-exit server/compliance/marking.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

const state = {
    settings: { ai_content_marking_enabled: false, ai_content_marking_footer: null },
    settingsReads: 0,
    org: { id: 'org-1', name: 'Acme BV' },
    locales: [{ code: 'nl', name: 'Nederlands', isDefault: true }, { code: 'en', name: 'English' }],
    gui: {},
};
const complianceStore = { getSettings: async () => { state.settingsReads++; return state.settings; } };
const userStore = { getOrganization: async (id) => (id === state.org.id ? state.org : null) };
const languageStore = {
    getAvailableLocales: async () => state.locales,
    getEffectiveGUIStrings: async (locale) => ({ ...(state.gui[locale] || {}) }),
};

const restore = installResolveStub({
    '../stores/complianceStore': complianceStore,
    '../stores/userStore': userStore,
    '../stores/languageStore': languageStore,
});
const marking = require('./marking');
after(() => restore());
beforeEach(() => { marking.invalidate(); state.settingsReads = 0; });

test('marking off → null, and the org name/dictionary are not read for it', async () => {
    assert.strictEqual(await marking.resolveMarking('org-1', { automationId: 'a1' }), null);
    assert.strictEqual(await marking.resolveMarking(null), null);
    assert.strictEqual(state.settingsReads, 1);
});

test('marking on → footer from the org default locale (NL fallback), org name, provider, ids, iso timestamp', async () => {
    state.settings = { ai_content_marking_enabled: true, ai_content_marking_footer: '' };
    const now = new Date('2026-09-14T09:00:00Z');
    const m = await marking.resolveMarking('org-1', { automationId: 'auto-7', aiStepIds: ['ai_1', null, 'ai_2'], provider: 'claude', now });
    assert.deepStrictEqual(m, {
        enabled: true,
        org_name: 'Acme BV',
        provider: 'claude',
        generated_at: '2026-09-14T09:00:00.000Z',
        automation_id: 'auto-7',
        ai_step_ids: ['ai_1', 'ai_2'],
        footer_text: 'Gegenereerd met AI — Acme BV',
        locale: 'nl',
    });
    assert.deepStrictEqual(marking.keywordsFor(m), ['AIGenerated=true', 'AIProvider=claude', 'GeneratedAt=2026-09-14T09:00:00.000Z', 'BeeFlowAutomation=auto-7']);
    assert.deepStrictEqual(marking.keywordsFor(null), []);
});

test('the dictionary key compliance.marking_footer wins over the hardcoded fallback; the settings footer wins over both', async () => {
    state.settings = { ai_content_marking_enabled: true };
    state.gui = { nl: { 'compliance.marking_footer': 'Met AI gemaakt voor {org}' } };
    let m = await marking.resolveMarking('org-1');
    assert.strictEqual(m.footer_text, 'Met AI gemaakt voor Acme BV');

    marking.invalidate('org-1');
    state.settings = { ai_content_marking_enabled: true, ai_content_marking_footer: '  Dit document is met AI opgesteld door { org }.  ' };
    m = await marking.resolveMarking('org-1');
    assert.strictEqual(m.footer_text, 'Dit document is met AI opgesteld door Acme BV.');
    state.gui = {};
});

test('English default locale and a missing organisation row fall back to EN copy and the org id', async () => {
    state.settings = { ai_content_marking_enabled: true };
    state.locales = [{ code: 'en', isDefault: true }];
    const m = await marking.resolveMarking('org-unknown', { provider: null });
    assert.strictEqual(m.locale, 'en');
    assert.strictEqual(m.org_name, 'org-unknown');
    assert.strictEqual(m.footer_text, 'Generated with AI — org-unknown');
    assert.strictEqual(m.provider, null);
    assert.strictEqual(m.automation_id, null);
    assert.deepStrictEqual(m.ai_step_ids, []);
    state.locales = [{ code: 'nl', isDefault: true }];
});

test('60 s memo: repeated renders read the settings once; invalidate() forces a re-read', async () => {
    state.settings = { ai_content_marking_enabled: true };
    await marking.resolveMarking('org-1');
    await marking.resolveMarking('org-1');
    await marking.resolveMarking('org-1');
    assert.strictEqual(state.settingsReads, 1);
    await marking.resolveMarking('org-2');
    assert.strictEqual(state.settingsReads, 2, 'memo is per org');
    marking.invalidate('org-1');
    await marking.resolveMarking('org-1');
    assert.strictEqual(state.settingsReads, 3);
    assert.strictEqual(marking.MEMO_MS, 60_000);
});

test('a throwing settings read is treated as marking off, never as a render failure', async () => {
    const orig = complianceStore.getSettings;
    complianceStore.getSettings = async () => { throw new Error('db down'); };
    try {
        assert.strictEqual(await marking.resolveMarking('org-1'), null);
    } finally {
        complianceStore.getSettings = orig;
    }
    assert.strictEqual(marking.FOOTER_KEY, 'compliance.marking_footer');
    assert.strictEqual(marking.FOOTER_DEFAULTS.en, 'Generated with AI — {org}');
});
