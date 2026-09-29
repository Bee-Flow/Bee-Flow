'use strict';

/**
 * What the language-admin routes accept, and what they say when they refuse
 * (routes/admin/languageRoutes.js).
 *
 * The guards were `typeof x === 'object'` — which an array passes — and
 * `if (!code || !name)` — which a number passes. Four things came out of that,
 * each one answered `{ success: true }`:
 *
 *   - `PUT /:code/gui` with `translations: []` replaced a locale's whole
 *     string table with an array, so every key read as missing and the locale
 *     fell back to English;
 *   - `PUT /:code/prompts/:id` with `text: 42` stored the number as that
 *     locale's system prompt;
 *   - `PUT /:code/email-templates` with a misspelled field name dropped the
 *     edit in the store's own allow-list and answered with the saved row;
 *   - `POST /:code/ai-translate-prompts` with a misspelled id in `promptIds`
 *     matched no prompt and answered "All prompts are already translated".
 *
 * What this file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.translations`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test routes/admin/languageRoutes.validation.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

// Every write lands in `touched`. A refused request must leave it empty.
const touched = [];
const LOCALES = [{ code: 'en', name: 'English', isDefault: true }, { code: 'nl', name: 'Nederlands' }];

mock(path.join(SERVER, 'stores/languageStore'), {
    AVAILABLE_LOCALE_CATALOG: [],
    getAvailableLocales: async () => LOCALES.map((l) => ({ ...l })),
    addLocale: async (code, name) => { touched.push({ what: 'addLocale', args: [code, name] }); return LOCALES; },
    deleteLocale: async () => LOCALES,
    setDefaultLocale: async () => LOCALES,
    getGUITranslations: async () => ({ 'a.b': 'aap' }),
    setGUITranslations: async (locale, t) => { touched.push({ what: 'setGUITranslations', args: [locale, t] }); },
    getAllEmailTemplates: async () => ({}),
    getEffectiveEmailTemplate: async () => ({ subject: 's', title: 't', intro: 'i', body: 'b', ctaLabel: 'c' }),
    setEmailTemplate: async (locale, id, fields) => { touched.push({ what: 'setEmailTemplate', args: [locale, id, fields] }); return {}; },
    getPromptTranslation: async () => null,
    setPromptTranslation: async (locale, id, text) => { touched.push({ what: 'setPromptTranslation', args: [locale, id, text] }); },
    getAllPromptTranslations: async () => ({}),
    exportLocale: async () => ({}),
    importLocale: async () => ({ imported: 0 }),
    getEffectiveGUIStrings: async () => ({}),
});
mock(path.join(SERVER, 'stores/configStore'), {
    getConfig: async () => null,
    setConfig: async (k, v) => { touched.push({ what: 'setConfig', args: [k, v] }); },
    deleteConfig: async (k) => { touched.push({ what: 'deleteConfig', args: [k] }); },
});
mock(path.join(SERVER, 'auth/permissions'), {
    requireAuth: (req, res, next) => next(),
    hasPermission: async () => true,
    getUserPermissions: async () => ['all'],
});
// The variables every preview renders with, so the preview can be held to the
// same links the real letter carries.
const renderedVars = [];
const LEARN_URL = 'https://workspace.example.test/app/settings/learning';
mock(path.join(SERVER, 'utils/emailService'), {
    renderEmailFromTemplate: (_tpl, vars) => { renderedVars.push(vars); return { subject: 's', html: '<p>x</p>' }; },
    welcomeLearnUrl: () => LEARN_URL,
    sendVerificationEmail: async (p) => { touched.push({ what: 'sendVerificationEmail', args: [p] }); return { success: true, messageId: 'm1' }; },
    sendWelcomeEmail: async (p) => { touched.push({ what: 'sendWelcomeEmail', args: [p] }); return { success: true, messageId: 'm1' }; },
});
mock(path.join(SERVER, 'i18n/defaults/promptDefaults'), {
    PROMPT_IDS: ['agent_system', 'title_generator'],
    PROMPT_LABELS: {},
    PROMPT_CATEGORIES: {},
    getAllDefaults: async () => ({ agent_system: 'x', title_generator: 'y' }),
    getDefaultPrompt: async () => 'x',
    clearDefaultsCache: () => {},
});

const router = require('./languageRoutes');
const { terminalErrorHandler } = require(path.join(SERVER, 'core/http/terminalErrorHandler'));

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, query, body, headers: {},
            session: { isAdmin: true, user: { id: 'u1', role: 'admin' } }, get() { return undefined; }, setTimeout() {},
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; }, setHeader() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; renderedVars.length = 0; });

async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, `${what} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
    return res;
}

// ═══ GUI translations ═══════════════════════════════════════════════

test('a translation table that is a list is refused, not written over the locale', async () => {
    // `typeof [] === 'object'` let this through; every key then read as
    // missing and the locale silently fell back to English.
    const res = await refuses({ method: 'PUT', url: '/nl/gui', body: { translations: [] } }, 'body.translations');
    assert.strictEqual(res.body.error, 'translations is a map of keys to strings.');
});

test('a translation that is not text is refused by name', async () => {
    await refuses({ method: 'PUT', url: '/nl/gui', body: { translations: { 'a.b': 42 } } }, 'body.translations.a.b');
});

test('a misspelled key is refused rather than answered with success', async () => {
    await refuses({ method: 'PUT', url: '/nl/gui', body: { translation: { 'a.b': 'aap' } } }, 'body');
});

test('the translations a caller may save still reach the store', async () => {
    const res = await dispatch({ method: 'PUT', url: '/nl/gui', body: { translations: { 'a.b': 'aap' } } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'setGUITranslations').args[1], { 'a.b': 'aap' });
});

test('a reset to the default is still spelled with an empty string or null', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/nl/gui', body: { updates: { 'a.b': null } } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'setGUITranslations').args[1], {});
});

// ═══ Locales ════════════════════════════════════════════════════════

test('a locale code that is a number is refused in words, not with a TypeError', async () => {
    const res = await refuses({ method: 'POST', url: '/', body: { code: 42, name: 'Nederlands' } }, 'body.code');
    assert.strictEqual(res.body.error, 'A locale needs a code, like "nl" or "pt-BR".');
});

test('a language name and a code that look like a locale still add one', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { code: 'pt-BR', name: 'Português' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'addLocale').args, ['pt-br', 'Português']);
});

// ═══ Email templates ════════════════════════════════════════════════

test('a misspelled template field is refused instead of being dropped by the store', async () => {
    await refuses({
        method: 'PUT', url: '/nl/email-templates',
        body: { templateId: 'verification', fields: { subjet: 'Bevestig je adres' } },
    }, 'body.fields');
});

test('a template nobody sends is refused in words', async () => {
    const res = await refuses({
        method: 'PUT', url: '/nl/email-templates',
        body: { templateId: 'verifikation', fields: { subject: 'x' } },
    }, 'body.templateId');
    assert.ok(res.body.error.startsWith('templateId is one of:'), res.body.error);
});

test('a test letter to something that is not an address is refused before it is sent', async () => {
    const res = await refuses({
        method: 'POST', url: '/nl/email-templates/verification/test',
        body: { testRecipient: 'alex at example dot com' },
    }, 'body.testRecipient');
    assert.strictEqual(res.body.error, 'Send the test letter to an e-mail address.');
});

test('a real address still gets the real letter', async () => {
    const res = await dispatch({
        method: 'POST', url: '/nl/email-templates/verification/test',
        body: { testRecipient: '  alex@example.com  ' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'sendVerificationEmail').args[0].email, 'alex@example.com');
});

test('the welcome preview carries the Learning Center link the real letter carries', async () => {
    // BFSF-279: the preview rendered {{learnUrl}} with no value, so an admin
    // checking the welcome letter saw "explore it here:" followed by nothing.
    const res = await dispatch({ method: 'POST', url: '/nl/email-templates/welcome/preview', body: {} });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(renderedVars.length, 1);
    assert.strictEqual(renderedVars[0].learnUrl, LEARN_URL);
});

test('the verification preview gets no Learning Center link', async () => {
    const res = await dispatch({ method: 'POST', url: '/nl/email-templates/verification/preview', body: {} });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(!('learnUrl' in renderedVars[0]));
});

// ═══ Prompts ════════════════════════════════════════════════════════

test('a prompt translation that is a number is refused, not stored as the prompt', async () => {
    await refuses({ method: 'PUT', url: '/nl/prompts/agent_system', body: { text: 42 } }, 'body.text');
});

test('a misspelled prompt id is refused instead of "all prompts are already translated"', async () => {
    await refuses({
        method: 'POST', url: '/nl/ai-translate-prompts',
        body: { modelTier: 'fast', promptIds: ['agent_sytem'] },
    }, 'body.promptIds.0');
});

// ═══ Org default locale ═════════════════════════════════════════════

test('a misspelled key on the org default is refused rather than answered with success', async () => {
    await refuses({ method: 'PUT', url: '/org/default', body: { defaultLocal: 'nl' } }, 'body');
});

test('the org default reaches its own route, not the locale-default one above it', async () => {
    // `/:code/default` is registered first and matched `/org/default` with
    // code='org', so this write answered `Locale 'org' not found` and the
    // org default for new users was never written.
    const res = await dispatch({ method: 'PUT', url: '/org/default', body: { defaultLocale: 'nl' } });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(touched.find((t) => t.what === 'setConfig').args, ['org_default_locale', 'nl']);
});

test('a locale default a platform admin sets still goes to the locale list', async () => {
    const res = await dispatch({ method: 'PUT', url: '/nl/default', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
});
