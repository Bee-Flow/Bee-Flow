// @typecheck
/**
 * keyMarks.js: the `since` marks of section, node, nav and nav-group keys, one file per key.
 *
 * The mechanism is proved with directories written per test; what ships is held to the
 * contract in ../catalogContract.test.js.
 * Run: node --test appStudio/componentSpecs/keyMarks.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadKeyMarks, keyMarkProblems, KEY_MARK_FAMILIES, KEY_MARKS } = require('./keyMarks');

/** @type {string[]} */
const made = [];
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

/** A registry directory holding `files` ({ 'family/key.js': mark | source text }). */
function registry(/** @type {Record<string, unknown>} */ files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-key-marks-'));
    made.push(dir);
    for (const [name, body] of Object.entries(files)) {
        const file = path.join(dir, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof body === 'string' ? body : `module.exports = ${JSON.stringify(body)};\n`);
    }
    return dir;
}

const title = { since: 3, shape: 'string ≤80', description: 'A title shown above the section.' };

test('a missing directory is an empty registry with every family', () => {
    const marks = loadKeyMarks(path.join(os.tmpdir(), 'no-such-key-marks-x9'));
    assert.deepEqual(Object.keys(marks), Object.keys(KEY_MARK_FAMILIES));
    for (const family of Object.keys(marks)) assert.deepEqual(Object.keys(marks[family]), []);
    assert.deepEqual(Object.keys(KEY_MARKS), Object.keys(KEY_MARK_FAMILIES));
});

test('loads one mark per file, per family, in file-name order; the file name is the key as a definition spells it', () => {
    const marks = loadKeyMarks(registry({
        'section/title.js': title,
        'section/collapsible.js': { since: 3, shape: 'boolean', description: 'Lets the visitor fold the section.' },
        'section/title.test.js': 'throw new Error("a test file is not a mark");\n',
        'node/styleWhen.js': { since: 4, shape: '[…]', description: 'Conditional style.' },
        'nav/style.js': { valuesSince: { dock: 3 }, shape: 'tabs|dock', description: 'dock pins the screens to the bottom.' },
        'sectionStyle/radius.js': { since: 3, description: 'Rounds the corners of the section.' },
        'README.md': '# not a family\n',
    }));
    assert.deepEqual(Object.keys(marks.section), ['collapsible', 'title']);
    assert.equal(marks.node.styleWhen.since, 4);
    assert.deepEqual(marks.nav.style.valuesSince, { dock: 3 });
    assert.equal(marks.sectionStyle.radius.shape, undefined, 'a knob renders its own shape');
    assert.equal(Object.getPrototypeOf(marks.section), null);
});

test('refuses a mark that is incomplete or sits in the wrong place, and says what to fix', () => {
    /** @type {Array<[Record<string, unknown>, RegExp]>} */
    const cases = [
        [{ 'section/title.js': { ...title, since: undefined } }, /carries "since" \(a new key\) or "valuesSince"/],
        [{ 'section/title.js': { ...title, since: 2 } }, /integer "since" of 3 or more/],
        [{ 'section/title.js': { ...title, since: '3' } }, /integer "since" of 3 or more/],
        [{ 'section/title.js': { ...title, description: ' ' } }, /"description" says in one sentence/],
        [{ 'section/title.js': { ...title, shape: undefined } }, /"shape" gives the value's shape/],
        [{ 'section/style.js': title }, /a base key of its family; only "valuesSince" can mark it/],
        [{ 'node/onClick.js': title }, /a base key of its family/],
        [{ 'nav/footer.js': { valuesSince: { a: 3 }, shape: 's', description: 'd.' } }, /not a base key of its family, so it needs its own "since"/],
        [{ 'nav/style.js': { valuesSince: {}, shape: 's', description: 'd.' } }, /"valuesSince" is \{ <value>: <since> \}/],
        [{ 'nav/style.js': { valuesSince: { dock: 2 }, shape: 's', description: 'd.' } }, /value dock\).*3 or more/],
        [{ 'widgets/title.js': title }, /keys\/widgets\/ is not a family \(section, sectionStyle, node, nav, navGroup, binding, queryShape\)/],
        [{ 'section/my-title.js': title }, /named after the key/],
        [{ 'section/title.js': 'module.exports = null;\n' }, /must export an object/],
    ];
    for (const [files, message] of cases) {
        assert.throws(() => loadKeyMarks(registry(files)), message, JSON.stringify(Object.keys(files)));
    }
    assert.deepEqual(keyMarkProblems('section', 'title', title), []);
    assert.deepEqual(keyMarkProblems('nav', 'style', { valuesSince: { dock: 3 }, shape: 's', description: 'd.' }), []);
});

test('the base keys of each family are the keys the canonicalizer has always written', () => {
    const specs = require('../componentSpecs');
    const { canonicalizeAppDefinition } = require('../canonicalize');
    const def = specs.emptyDefinition('Base keys');
    const screenId = def.screens[0].id;
    /** @type {Record<string, unknown>} */ (def.screens[0].sections[0].style).height = 'fill';
    def.screens[0].sections[0].children = [{
        id: 'cmp_base0001', type: 'card', props: {}, visibleWhen: true, enabledWhen: true, readOnly: false,
        computed: { title: { kind: 'formula', expr: '1' } }, validations: [], visibleToRoles: [], children: [],
    }];
    def.nav = { style: 'sidebar', groups: [{ id: 'nvg_main', label: 'Main', icon: 'home', screens: [screenId] }] };
    const { def: canon } = canonicalizeAppDefinition(def);
    const section = canon.screens[0].sections[0];
    assert.deepEqual(Object.keys(section).filter((k) => !KEY_MARK_FAMILIES.section.includes(k)), []);
    assert.deepEqual(Object.keys(section.children[0]).filter((k) => !KEY_MARK_FAMILIES.node.includes(k)), []);
    assert.deepEqual(Object.keys(canon.nav), [...KEY_MARK_FAMILIES.nav]);
    assert.deepEqual(Object.keys(canon.nav.groups[0]), [...KEY_MARK_FAMILIES.navGroup]);
    // The node family names every base event, and the section style family every knob a section took in the base.
    for (const event of ['onClick', 'onSubmit', 'onRowClick', 'onRowSelect', 'onCardMove', 'onChange', 'onDecided', 'onAttachmentClick']) {
        assert.ok(KEY_MARK_FAMILIES.node.includes(event), event);
    }
    assert.deepEqual([...KEY_MARK_FAMILIES.sectionStyle], specs.expandStyleKnobs(['padding', 'gap', 'background', 'height'], specs.BASE_STYLE_KNOB_GROUPS));
});
