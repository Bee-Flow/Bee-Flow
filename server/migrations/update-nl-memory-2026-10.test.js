/**
 * Dutch for the memory work. Pins: every key exists in English, the rewording
 * only replaces the OLD shipped Dutch (a workspace's own wording survives),
 * placeholders and plural pairs survive, and no memory key is left without
 * Dutch.
 *
 * Run: node --test migrations/update-nl-memory-2026-10.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { NL_TRANSLATIONS, NL_REWORDED, applyNl } = require('./update-nl-memory-2026-10');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

/** Every key some other Dutch catalogue (migration module or data file) already ships. */
function shippedElsewhere() {
    const out = new Set();
    for (const f of fs.readdirSync(__dirname)) {
        if (!/^add-nl-.*\.js$/.test(f) || f.endsWith('.test.js')) continue;
        const mod = require(path.join(__dirname, f));
        for (const k of Object.keys(mod.NL_TRANSLATIONS || {})) out.add(k);
        for (const k of mod.SAME_AS_ENGLISH || []) out.add(k); // the Dutch really is the English word
    }
    const dataDir = path.join(__dirname, 'data');
    for (const f of fs.readdirSync(dataDir)) {
        if (!f.endsWith('.json')) continue;
        const json = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
        for (const k of Object.keys(json.translations || json)) out.add(k);
    }
    return out;
}

const MEMORY_KEY = /^(knowledge\.memory_|settings\.memory_|chat\.memory\.|admin\.org_memory\.)|^(admin\.encryption\.surface_memories|settings\.ai_context)$|^admin\.ai_context\./;

test('every key exists in the English catalog, has Dutch, and is not the English copied over', () => {
    const keys = [...Object.keys(NL_TRANSLATIONS), ...Object.keys(NL_REWORDED)];
    assert.deepStrictEqual(keys.filter((k) => !(k in GUI_DEFAULTS)), []);
    assert.strictEqual(new Set(keys).size, keys.length, 'a key is in both lists');
    for (const k of Object.keys(NL_TRANSLATIONS)) {
        assert.ok(NL_TRANSLATIONS[k].trim(), `${k}: empty`);
    }
    for (const [k, { was, now }] of Object.entries(NL_REWORDED)) {
        assert.ok(now.trim() && was.trim(), `${k}: empty`);
        assert.notStrictEqual(now, was, `${k}: not reworded`);
        assert.notStrictEqual(now, GUI_DEFAULTS[k], `${k}: English copied`);
    }
    // Same word in both languages is legitimate for these only.
    const sameOk = new Set([
        'knowledge.memory_field_type', 'knowledge.memory_sort_recent', 'knowledge.memory_scope_project', 'knowledge.memory_scope_agents',
        'knowledge.memory_type_one_context', 'knowledge.memory_type_one_project', 'knowledge.memory_type_one_workflow',
        'chat.memory.type_context', 'chat.memory.type_project', 'chat.memory.type_workflow',
    ]);
    for (const k of Object.keys(NL_TRANSLATIONS)) {
        if (!sameOk.has(k)) assert.notStrictEqual(NL_TRANSLATIONS[k], GUI_DEFAULTS[k], `${k}: English copied`);
    }
});

test('placeholders survive translation', () => {
    const names = (s) => [...String(s).matchAll(/\{([a-z_]+)\}/gi)].map((m) => m[1]).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) assert.deepStrictEqual(names(v), names(GUI_DEFAULTS[k]), k);
    for (const [k, { now }] of Object.entries(NL_REWORDED)) assert.deepStrictEqual(names(now), names(GUI_DEFAULTS[k]), k);
});

test('plural pairs stay pairs', () => {
    for (const k of Object.keys(NL_TRANSLATIONS)) {
        if (k.endsWith('_plural')) assert.ok(NL_TRANSLATIONS[k.replace(/_plural$/, '')], `${k}: singular missing`);
    }
});

test('no memory key in the English catalog is left without Dutch (a forgotten key fails here)', () => {
    const have = new Set([...shippedElsewhere(), ...Object.keys(NL_TRANSLATIONS), ...Object.keys(NL_REWORDED)]);
    const missing = Object.keys(GUI_DEFAULTS).filter((k) => MEMORY_KEY.test(k) && !have.has(k));
    assert.deepStrictEqual(missing, []);
});

test('the reworded keys are exactly the ones whose English changed meaning', () => {
    assert.deepStrictEqual(Object.keys(NL_REWORDED).sort(), [
        'admin.ai_context.choose', 'admin.ai_context.intro', 'admin.ai_context.load_failed',
        'admin.ai_context.save_failed', 'admin.ai_context.saved', 'admin.ai_context.title',
        'learn.encryption-tiers.weakenings.body', 'settings.ai_context', 'settings.memory_switch_off_desc',
    ]);
    assert.strictEqual(NL_REWORDED['settings.ai_context'].now, 'Context in lange gesprekken');
    assert.match(NL_REWORDED['learn.encryption-tiers.weakenings.body'].now, /Vier onderdelen/);
});

test('"was" is what actually shipped before (so the rewording can match it)', () => {
    const data = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'data', f), 'utf8'));
    const ui = data('ui-complete-2026-10-nl.json');
    const learn = data('learn-content-2026-10-nl.json');
    const learnMap = learn.translations || learn;
    const sw = require('./add-nl-memory-switch-translations').NL_TRANSLATIONS;
    for (const [k, { was }] of Object.entries(NL_REWORDED)) {
        const shipped = k.startsWith('learn.') ? learnMap[k] : (ui.translations || ui)[k] ?? sw[k];
        assert.strictEqual(shipped, was, k);
    }
});

test('applyNl adds missing keys, replaces the old shipped Dutch, and keeps a workspace\'s own wording', () => {
    const [rewordKey, { was, now }] = Object.entries(NL_REWORDED)[0];
    const [otherKey] = Object.keys(NL_REWORDED).slice(1);
    const [newKey, newValue] = Object.entries(NL_TRANSLATIONS)[0];
    const [ownKey] = Object.keys(NL_TRANSLATIONS).slice(1);
    const blob = { [rewordKey]: was, [otherKey]: 'Onze eigen formulering', [ownKey]: 'Ook van ons', unrelated: 'blijft' };
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

test('the boot ladder runs it after the catalogues it corrects and before the routine rename', () => {
    const { NL_TRANSLATIONS: ladder } = require('../boot/bootMigrations');
    const at = (name) => ladder.indexOf(name);
    assert.ok(at('update-nl-memory-2026-10') > at('add-nl-ui-complete-2026-10-translations'));
    assert.ok(at('update-nl-memory-2026-10') > at('add-nl-learn-content-2026-10-translations'));
    assert.ok(at('update-nl-memory-2026-10') > at('add-nl-memory-switch-translations'));
    assert.ok(at('update-nl-memory-2026-10') < at('rename-routine-i18n-2026-10'));
});
