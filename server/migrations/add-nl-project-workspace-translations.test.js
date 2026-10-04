/**
 * The Dutch for the collaborative project workspace. Pins the silent failures
 * of a catalogue this size: a Dutch key that matches no English key (stored,
 * never read, for example a key the workspace round removed), an English key
 * with no Dutch (one English sentence in a Dutch workspace), an English value
 * copied over as "Dutch", and a placeholder that got lost or renamed on the
 * way (the sentence then shows a raw "{actor}" or drops the name).
 *
 * Run: node --test migrations/add-nl-project-workspace-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH } = require('./add-nl-project-workspace-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

/** Whole namespaces this catalogue owns: every key in them needs Dutch. */
const OWNED_NAMESPACES = ['project_home.', 'project_chat.', 'project_content.'];

/**
 * Keys this round added to namespaces other writers share. Listed by name,
 * so a later addition to `sidebar` or `solutions` by someone else is not
 * claimed here.
 */
const OWNED_ELSEWHERE = [
    'sidebar.project_shared_badge',
    'sidebar.project_new_chat',
    'sidebar.project_context_label',
    'sidebar.project_context_open',
    'sidebar.project_context_leave',
    'sidebar.project_chat_shared',
    'sidebar.project_chat_share_failed',
    'sidebar.project_chat_not_shared',
    'sidebar.project_chat_not_started',
    'sidebar.project_agent_unavailable',
    'sidebar.project_thread_agent_unavailable',
    'sidebar.projects_load_failed',
    'sidebar.project_move_failed',
    'sidebar.conv_in_project',
    'sidebar.shared_chat_read_only',
    'solutions.manage_access',
    'solutions.access_title',
    'solutions.access_intro',
    'solutions.access_loading',
    'compliance.dsr_discovery_team_chat_messages',
];

const isOwned = (k) => OWNED_NAMESPACES.some((p) => k.startsWith(p)) || OWNED_ELSEWHERE.includes(k);
const holes = (s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();

test('every Dutch key exists in the English catalog', () => {
    const orphans = [...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH].filter((k) => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, [], 'these Dutch keys have no English counterpart (removed or renamed?)');
});

test('the catalogue only holds keys it owns', () => {
    const strays = [...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH].filter((k) => !isOwned(k));
    assert.deepStrictEqual(strays, [], 'add the key to OWNED_ELSEWHERE, or move it to the catalogue that owns it');
});

/**
 * Later rounds add keys to these namespaces and seed their Dutch from their
 * own catalogue, the pattern every add-nl-* round follows, so a key one of
 * them covers counts as covered here. The whole namespaces stay owned: a key
 * that no catalogue translates still turns this test red.
 */
const LATER_ROUNDS = [
    require('./add-nl-collaboration-wave2-editor-versions-translations'),
    require('./add-nl-project-tasks-translations'),
];

test('every owned English key has Dutch, or is declared identical', () => {
    const covered = new Set([
        ...SAME_AS_ENGLISH,
        ...LATER_ROUNDS.flatMap((c) => [...Object.keys(c.NL_TRANSLATIONS), ...c.SAME_AS_ENGLISH]),
    ]);
    const untranslated = Object.keys(GUI_DEFAULTS).filter((k) => isOwned(k) && !(k in NL_TRANSLATIONS) && !covered.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('no Dutch value is blank or the English copied over, and no key is both', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k}: identical to English; move it to SAME_AS_ENGLISH if that is deliberate`);
    }
    assert.deepStrictEqual(SAME_AS_ENGLISH.filter((k) => k in NL_TRANSLATIONS), []);
    assert.strictEqual(new Set(SAME_AS_ENGLISH).size, SAME_AS_ENGLISH.length, 'SAME_AS_ENGLISH lists a key twice');
});

test('a key declared identical still has the English it was declared for', () => {
    // SAME_AS_ENGLISH keys are not seeded, so a Dutch reader sees the English.
    // That is only right while the English is the word Dutch uses too; a
    // reworded English string would otherwise reach Dutch screens unnoticed.
    const DECLARED_FOR = {
        'project_home.activity.filter_chats': 'Chats',
        'project_home.activity.filter_project': 'Project',
        'project_home.color.amber': 'Amber',
        'project_home.composer.agent': 'Agent',
        'project_home.composer.mode_agent': 'Agent',
        'project_home.composer.mode_team': 'Team',
        'project_home.list.sort_recent': 'Recent',
        'project_home.online': 'Online',
        'project_home.overview.online_count': '{n} online',
        'project_home.rail.project': 'Project',
        'project_home.recent.document': 'Document',
        'project_home.recent.meeting': 'Meeting',
        'project_home.settings.kind_project': 'project',
        'project_home.tab.chats': 'Chats',
        'project_home.tab.meetings': 'Meetings',
        'project_chat.agent_fallback': 'Agent',
        'project_chat.ai_badge': 'AI',
        'project_chat.filter_ai': 'AI',
        'project_chat.filter_team': 'Team',
        'project_chat.count_summary': '{team} team · {ai} AI',
        'project_chat.pick_agent': 'Agent',
        'project_chat.title': 'Chats',
        'project_content.doc_type_document': 'Document',
        'project_content.meetings_title': 'Meetings',
        'sidebar.conv_in_project': 'In project: {name}',
    };
    assert.deepStrictEqual([...SAME_AS_ENGLISH].sort(), Object.keys(DECLARED_FOR).sort());
    for (const k of SAME_AS_ENGLISH) {
        assert.strictEqual(GUI_DEFAULTS[k], DECLARED_FOR[k],
            `${k}: the English changed; translate it instead of declaring it identical`);
    }
});

test('placeholders survive translation exactly', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
    }
});

test('no dashes are used as punctuation', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(!/[–—]/.test(v), `${k} (nl) uses a dash`);
    }
});

test('up() seeds exactly this catalogue into the Dutch strings, never the identical ones', async () => {
    const calls = [];
    // The store is handed in (the up() seam), so nothing reaches into the module system.
    const languageStore = {
        addMissingGUITranslations: async (locale, translations) => {
            calls.push({ locale, translations });
            return { added: 0 };
        },
    };
    const { up } = require('./add-nl-project-workspace-translations');
    assert.deepStrictEqual(await up({ languageStore }), { added: 0 });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].locale, 'nl');
    assert.deepStrictEqual(calls[0].translations, NL_TRANSLATIONS);
    assert.ok(SAME_AS_ENGLISH.every((k) => !(k in calls[0].translations)));
});

test('the migration is registered, or it never runs', () => {
    const { NL_TRANSLATIONS: bootList } = require('../boot/bootMigrations');
    assert.ok(bootList.includes('add-nl-project-workspace-translations'),
        'add it to the NL_TRANSLATIONS list in boot/bootMigrations.js');
});
