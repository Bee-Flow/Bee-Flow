/**
 * Dutch for the settings menu clean-up. Pins: every key exists in English,
 * every `was` is Dutch that really shipped (so the rewording can match it), the
 * new Dutch names the new menu path, a workspace's own wording survives, and
 * the boot ladder runs it after the catalogues whose Dutch it rewords.
 *
 * Run: node --test migrations/update-nl-settings-nav-2026-10.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { NL_TRANSLATIONS, NL_REWORDED, applyNl } = require('./update-nl-settings-nav-2026-10');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

/** Every Dutch value any other catalogue (module table, module source or data file) ships. */
function shippedDutch() {
    const out = [];
    for (const f of fs.readdirSync(__dirname)) {
        if (!/^(add|update)-nl-.*\.js$/.test(f) || f.endsWith('.test.js') || f.startsWith('update-nl-settings-nav')) continue;
        // Source text, not the exports: some catalogues keep their table private.
        out.push(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    }
    const dataDir = path.join(__dirname, 'data');
    for (const f of fs.readdirSync(dataDir)) {
        if (f.endsWith('.json')) out.push(fs.readFileSync(path.join(dataDir, f), 'utf8'));
    }
    return out.join('\n');
}

test('every key exists in the English catalog and is in one list only', () => {
    const keys = [...Object.keys(NL_TRANSLATIONS), ...Object.keys(NL_REWORDED)];
    assert.deepStrictEqual(keys.filter((k) => !(k in GUI_DEFAULTS)), []);
    assert.strictEqual(new Set(keys).size, keys.length, 'a key is in both lists');
});

test('the Dutch is Dutch: not blank and not the English copied over', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(v.trim(), `${k}: empty`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k}: English copied`);
    }
    for (const [k, { was, now }] of Object.entries(NL_REWORDED)) {
        assert.ok(Array.isArray(was) && was.length > 0, `${k}: no old text`);
        assert.ok(now.trim(), `${k}: empty`);
        assert.ok(!was.includes(now), `${k}: not reworded`);
        assert.notStrictEqual(now, GUI_DEFAULTS[k], `${k}: English copied`);
    }
});

test('placeholders survive translation', () => {
    const names = (s) => [...String(s).matchAll(/\{([a-z_]+)\}/gi)].map((m) => m[1]).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) assert.deepStrictEqual(names(v), names(GUI_DEFAULTS[k]), k);
    for (const [k, { now }] of Object.entries(NL_REWORDED)) assert.deepStrictEqual(names(now), names(GUI_DEFAULTS[k]), k);
});

test('"was" is Dutch that actually shipped before, JSON- or JS-escaped', () => {
    const shipped = shippedDutch();
    for (const [k, { was }] of Object.entries(NL_REWORDED)) {
        for (const w of was) {
            const forms = [w, JSON.stringify(w).slice(1, -1), w.replace(/'/g, "\\'")];
            assert.ok(forms.some((f) => shipped.includes(f)), `${k}: "${w.slice(0, 60)}…" never shipped`);
        }
    }
});

test('the old menu paths are gone from the reworded Dutch, and the new ones are named', () => {
    for (const [k, { now }] of Object.entries(NL_REWORDED)) {
        assert.ok(!now.includes('Instellingen → Integraties'), `${k}: still names Integraties`);
        assert.ok(!now.includes('Organisatie-instellingen'), `${k}: still names Organisatie-instellingen`);
        if (GUI_DEFAULTS[k].includes('Settings → Connections')) {
            assert.ok(now.includes('Instellingen → Koppelingen'), `${k}: English names Connections, Dutch does not`);
        }
    }
    assert.strictEqual(NL_REWORDED['settings.ai_context'].now, 'AI & samenwerking');
    assert.deepStrictEqual(NL_REWORDED['settings.ai_context'].was, ['Context in lange gesprekken']);
});

test('applyNl adds missing keys, replaces old shipped Dutch, and keeps a workspace\'s own wording', () => {
    const [rewordKey, { was, now }] = Object.entries(NL_REWORDED)[0];
    const [otherKey] = Object.keys(NL_REWORDED).slice(1);
    const [newKey, newValue] = Object.entries(NL_TRANSLATIONS)[0];
    const [ownKey] = Object.keys(NL_TRANSLATIONS).slice(1);
    const blob = { [rewordKey]: was[0], [otherKey]: 'Onze eigen formulering', [ownKey]: 'Ook van ons', unrelated: 'blijft' };
    const { merged, added, reworded } = applyNl({ ...blob });
    assert.strictEqual(merged[rewordKey], now);
    assert.strictEqual(merged[otherKey], 'Onze eigen formulering');
    assert.strictEqual(merged[newKey], newValue);
    assert.strictEqual(merged[ownKey], 'Ook van ons');
    assert.strictEqual(merged.unrelated, 'blijft');
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length - 1);
    assert.strictEqual(reworded, Object.keys(NL_REWORDED).length - 1);
    const again = applyNl({ ...merged });
    assert.deepStrictEqual(again.merged, merged);
    assert.strictEqual(again.added, 0);
    assert.strictEqual(again.reworded, 0);
});

test('the personal page is "Koppelingen", also where a workspace still has the older "Verbindingen"', () => {
    // The copy that points at the page says "Instellingen → Koppelingen"; a
    // workspace from before the public history still named the page itself
    // "Verbindingen" (add-nl-connections-translations' header), so menu and
    // copy disagreed. Anything else stays the workspace's own wording.
    assert.deepStrictEqual(NL_REWORDED['settings.connections'], { was: ['Verbindingen'], now: 'Koppelingen' });
    assert.strictEqual(applyNl({ 'settings.connections': 'Verbindingen' }).merged['settings.connections'], 'Koppelingen');
    assert.strictEqual(applyNl({ 'settings.connections': 'Mijn koppelingen' }).merged['settings.connections'], 'Mijn koppelingen');
    for (const [k, { now }] of Object.entries(NL_REWORDED)) {
        if (now.includes('Instellingen →') && GUI_DEFAULTS[k].includes('Settings → Connections')) {
            assert.ok(now.includes(`Instellingen → ${NL_REWORDED['settings.connections'].now}`), `${k}: names another page than the menu`);
        }
    }
});

test('every variant an earlier catalogue shipped is matched', () => {
    const { was, now } = NL_REWORDED['solutions.install_grant_not_connected'];
    assert.strictEqual(was.length, 2);
    for (const w of was) assert.strictEqual(applyNl({ 'solutions.install_grant_not_connected': w }).merged['solutions.install_grant_not_connected'], now);
});

test('the boot ladder runs it after the catalogues it rewords and before the routine rename', () => {
    const { NL_TRANSLATIONS: ladder } = require('../boot/bootMigrations');
    const at = (name) => ladder.indexOf(name);
    const me = at('update-nl-settings-nav-2026-10');
    assert.ok(me > -1, 'not registered in boot/bootMigrations.js');
    for (const earlier of [
        'add-nl-ui-complete-2026-10-translations',
        'add-nl-learn-content-2026-10-translations',
        'add-nl-hardcoded-pages-shell-2026-10-translations',
        'add-nl-hardcoded-studio-admin-2026-10-translations',
        'add-nl-hardcoded-integrations-agents-2026-10-translations',
        'add-nl-hardcoded-automation-builder-2026-10-translations',
        'add-nl-solution-install-wizard-translations',
        'add-nl-personal-privacy-shield-translations',
        'update-nl-memory-2026-10',
        'add-nl-fix-english-2026-10-translations',
    ]) {
        assert.ok(at(earlier) > -1 && at(earlier) < me, `must run after ${earlier}`);
    }
    assert.ok(me < at('rename-routine-i18n-2026-10'));
});
