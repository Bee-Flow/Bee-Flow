/**
 * The bespoke editors' WORDS, held to the web editors they port and to the
 * two English dictionaries:
 *
 *   - a borrowed key (anything but `mobile.*`) is in both dictionaries, and
 *     where it travels as data (`msg(…)`) its English is the dictionary's;
 *   - a `mobile.*` key is shaped like a key, and one key always carries the
 *     same English;
 *   - TEXTUAL: every sentence a `mobile.*` key carries is the web editor's own
 *     words (each part between `{placeholders}`), except the ones listed in
 *     OWN_WORDS, each with the reason the phone words it itself.
 * A failure means the web editor's words changed: update the port.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CLIENT_DICT, SERVER_DICT, readDict } from '@/core/i18n/dictionaryText';

const HERE = __dirname;
const BUILDER = path.resolve(HERE, '../../../../../../agent-hub/src/components/automation/Builder');

/** Each bespoke editor folder, and the web files it ports. */
const WEB: Record<string, string[]> = {
    trigger: [
        'flow/settings/triggerEditors.jsx',
        'flow/settings/triggerFilters.jsx',
        'flow/settings/FormTriggerFields.jsx',
        'flow/ScheduleBuilder.jsx',
        'webhooks/TriggerWebhookPanel.jsx',
        'webhooks/useWebhooks.js',
        'WebhookPanel.jsx',
    ],
    params: ['flow/settings/fieldDesigner.jsx', 'flow/settings/triggerEditors.jsx'],
    form: ['flow/settings/FormBuilderFields.jsx', 'flow/settings/fieldDesigner.jsx', 'flow/settings/triggerEditors.jsx'],
    route: [
        'flow/settings/routeEditors.jsx',
        'flow/settings/routeEditorsOutputs.tsx',
        'flow/settings/SourceNotices.tsx',
        'mapping/ConditionBuilder.jsx',
        'mapping/ConditionBuilderRow.tsx',
        'mapping/ConditionBuilderValueSlot.tsx',
        'flow/settings/collectionEditors.jsx',
        'flow/settings/RouteAssist.jsx',
        'flow/settings/RouteAssistParts.tsx',
    ],
    loop: ['flow/settings/actionEditors/loopFields.jsx', 'mapping/LoopOverPicker.jsx'],
    ai: ['flow/settings/aiStepEditors.jsx', 'flow/settings/structuredOutputFields.tsx', 'flow/settings/agentStepFields.tsx', 'flow/settings/collectionEditors.jsx'],
    shared: ['flow/settings/collectionEditors.jsx', 'mapping/FieldPicker.jsx', 'flow/settings/SetOperationsEditor.jsx'],
    set: ['flow/settings/setEditors.jsx', 'flow/settings/SetOperationsEditor.jsx', 'flow/setOperations.js', 'mapping/JsonTreePicker.jsx'],
    approval: ['flow/settings/approvalEditors.jsx', 'flow/settings/approvalStages.jsx'],
    datatable: ['flow/settings/datatableEditors.jsx'],
    http: ['flow/settings/actionEditors/httpRequestFields.jsx', 'flow/settings/HttpAuthPicker.jsx', 'flow/settings/actionEditors/cacheIntoRow.jsx'],
    code: ['flow/settings/actionEditors/codeFields.tsx', 'flow/settings/codeStep/CodeSourceBlock.tsx', 'flow/settings/codeStep/ReachPanel.tsx'],
    document: ['flow/settings/actionEditors/documentFields.jsx'],
};

/**
 * Sentences the phone says in its own words, with the reason. Everything else
 * a `mobile.*` key says must be the web editor's.
 */
const OWN_WORDS: Record<string, string> = {
    // A phone has no Input panel to drag from, no {} button and no hover.
    'mobile.flow.ai.prompt_hint': 'the web says "Drag data from the Input panel (or use the {} button)"; the phone has Insert data',
    'mobile.flow.form.vars_hint': 'same: the web says "Drag a value from the Input panel (or use the {} button)"',
    'mobile.flow.params.unnamed': 'a row card needs a title; the web row has none',
    'mobile.flow.trigger.open_in_forms': 'the web builder hides the link (SHOW_PUBLIC_LINK_IN_BUILDER); the phone points at Forms instead',
    'mobile.flow.schedule.unreadable': 'the web shows the server’s error only',
    'mobile.flow.webhook.url_copied': 'the web shows a tick; the phone a toast',
    'mobile.flow.webhook.curl_copied': 'same',
    'mobile.flow.webhook.secret_copied': 'same',
    'mobile.flow.form.answer_type': 'the web’s type select is unlabelled (aria "Question n type")',
    'mobile.flow.form.app_searches_own_unconnected': 'the web builds one sentence from two halves; the phone has it whole',
    'mobile.flow.route.collapse_title': 'the web asks inline, the phone in a confirmation sheet',
    'mobile.flow.route.value_to_match': 'the web’s placeholder "value to match", as a label',
    'mobile.flow.route.assist.losing_one': 'the web assembles it from conditionals (is/are, its/their); the phone words each case whole',
    'mobile.flow.route.assist.losing_many': 'same',
    'mobile.flow.condition.test': 'the web’s condition row has no labels; the phone stacks field, test and value',
    'mobile.flow.condition.match_all': 'the web: "Match [all] of these conditions"',
    'mobile.flow.condition.match_any': 'the web: "Match [any] of these conditions"',
    'mobile.flow.condition.join': 'an accessibility name for that switch',
    'mobile.flow.loop.body_empty': 'the web edits the body inline; the phone points at the outline',
    'mobile.flow.ai.no_apps': 'the web’s tool picker shows an empty list',
    'mobile.flow.ai.kb_unreadable': 'the web shows "No knowledge bases yet" on a failed read too — the phone does not claim that',
    'mobile.flow.params.renamed_one': 'the web builds it with ternaries; params.lockstep.test.ts checks it word for word',
    'mobile.flow.params.renamed_many': 'same',
    'mobile.flow.form.file_to_offer_hint': 'the web writes the example as {\'{{steps.doc_1.output.fileId}}\'} in a code mark; the phone says to pick it with Insert data',
    'mobile.flow.set.json_pick_hint': 'the web says "Click a value"; a phone is tapped',
    'mobile.flow.datatable.value_placeholder': 'the web says "or drag one in from an earlier step"; the phone has no drag',
    'mobile.flow.http.url_hint': 'the web says "Click a value in the right panel to insert it"; the phone has Insert data, and its example reads as the pill does',
    'mobile.flow.http.body_hint': 'same',
    // The web teaches the syntax under a pill ({{ }}, loop.item, trigger.output.<name>, a path as a
    // placeholder); on a phone keyboard a person picks with Insert data and reads the pill's words.
    'mobile.flow.approval.question_hint': 'the web says "Use {{ }} to pull in values"; the phone says Insert data',
    'mobile.flow.ai.iteration_hint': 'the web says "then reference {{loop.item…}}"; the phone names the picker group',
    'mobile.flow.datatable.iteration_hint': 'same',
    'mobile.flow.loop.available_as_each': 'the web shows loop.{name} in a code mark; the phone the words its pill reads',
    'mobile.flow.loop.batch_size_hint': 'the web says "bind an ARRAY … to loop.<name>"; the phone says what the steps inside get',
    'mobile.flow.loop.list_path_prompt': 'the web’s placeholder is a path (steps.s1.output.results); the phone points at Insert data',
    'mobile.flow.condition.field_prompt': 'the web’s placeholder is a path (steps.step1.output.total); the phone points at Insert data',
    'mobile.flow.route.value_to_check_prompt': 'the web’s placeholder is a path (trigger.output.value); the phone points at Insert data',
    'mobile.flow.set.json_source_prompt': 'the web’s placeholder is a path (item.body); the phone points at Insert data',
    'mobile.flow.trigger.app_inputs_hint': 'the web says "Bind them in steps as trigger.output.<name>"; the phone names the pill',
    'mobile.flow.trigger.flowlet_inputs_hint': 'same',
    'mobile.flow.trigger.input_parameters_hint': 'same',
    'mobile.flow.filter.nc_forms_note': 'the web says "bound to trigger.output.formId and …submissionId"; the phone names the pills',
    'mobile.flow.filter.nc_tag_note': 'the web says "bound to trigger.output.fileId"; the phone names the pill',
    'mobile.flow.fill.list_with_fields': 'the web assembles the sentence from a template literal; the phone words each case whole, so each can be translated',
    'mobile.flow.fill.list_whole': 'same',
};

// ── Reading the words ──────────────────────────────────────────────────

interface Use {
    key: string;
    english: string;
    file: string;
    data: boolean;
}

const STR = `'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)"`;
const CALL = new RegExp(`\\b(t|msg)\\(\\s*'([a-z0-9_.]+)'\\s*,\\s*(?:${STR})`, 'g');
const unescape = (s: string) => s.replace(/\\(['"\\])/g, '$1');

function sources(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...sources(p));
        else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) && e.name !== 'testing.tsx') out.push(p);
    }
    return out;
}

function usesIn(folder: string): Use[] {
    const out: Use[] = [];
    for (const file of sources(path.join(HERE, folder))) {
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(CALL)) {
            out.push({ key: m[2] as string, english: unescape((m[3] ?? m[4]) as string), file: path.relative(HERE, file), data: m[1] === 'msg' });
        }
    }
    return out;
}

/**
 * The web files as the words a person reads, twice over: as written (the
 * words inside attributes and string literals), and with the inline marks a
 * sentence wraps a word in (`<code>`, `<strong>`, `<span …>`) taken out.
 */
function webText(files: string[]): string {
    const raw = files
        .map((f) => fs.readFileSync(path.join(BUILDER, f), 'utf8'))
        .join('\n')
        .replace(/\{\s*['"] ['"]\s*\}/g, ' ')
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&rarr;/g, '→')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\\'/g, "'")
        .replace(/[’‘]/g, "'")
        .replace(/[“”]/g, '"');
    const unmarked = raw.replace(/<\/?(?:code|strong|span|em|b|a|br|p)(?:\s[^>]*)?>/g, ' ');
    return `${raw.replace(/\s+/g, ' ')}\n${unmarked.replace(/\s+/g, ' ').replace(/ ([.,:;])/g, '$1')}`;
}

const norm = (s: string) => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

const FOLDERS = Object.keys(WEB);
const ALL = FOLDERS.flatMap(usesIn);

describe('the editors’ words', () => {
    const client = readDict(CLIENT_DICT);
    const server = readDict(SERVER_DICT);

    it('found words at all', () => {
        expect(ALL.length).toBeGreaterThan(300);
    });

    it('borrow only keys both dictionaries have, with their English where it travels as data', () => {
        const problems: string[] = [];
        for (const u of ALL) {
            if (u.key.startsWith('mobile.')) continue;
            if (!client.has(u.key) || !server.has(u.key)) problems.push(`missing ${u.key} (${u.file})`);
            else if (u.data && unescape(server.get(u.key) as string) !== u.english) problems.push(`${u.key}: "${u.english}" ≠ "${server.get(u.key)}"`);
        }
        expect(problems).toEqual([]);
    });

    it('shape their own keys like keys, and say one thing per key', () => {
        const seen = new Map<string, string>();
        const problems: string[] = [];
        for (const u of ALL) {
            if (!u.key.startsWith('mobile.')) continue;
            if (!/^mobile\.[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(u.key)) problems.push(`malformed ${u.key}`);
            const before = seen.get(u.key);
            if (before !== undefined && before !== u.english) problems.push(`${u.key}: "${before}" vs "${u.english}"`);
            seen.set(u.key, u.english);
        }
        expect(problems).toEqual([]);
    });

    /** Does the web say these words (each part between placeholders)? */
    const webSays = (text: string, english: string) =>
        norm(english)
            .split(/\{\w+\}/)
            .map((p) => p.trim())
            .filter((p) => p.length > 2)
            .every((p) => text.includes(p));

    it.each(FOLDERS)('%s: its own sentences are the web editor’s words', (folder) => {
        const text = webText(WEB[folder] as string[]);
        const strays = new Set<string>();
        for (const u of usesIn(folder)) {
            if (!u.key.startsWith('mobile.') || OWN_WORDS[u.key]) continue;
            // A key borrowed from another area's spec (the collection rows) is checked there.
            if (/^mobile\.flow\.(list|section|foreach|retry)\./.test(u.key) && !text.includes(norm(u.english).split('{')[0] as string)) continue;
            if (!webSays(text, u.english)) strays.add(`${u.key} "${u.english}"`);
        }
        expect([...strays]).toEqual([]);
    });

    it('lists as its own only words the web does not have', () => {
        const needless = new Set<string>();
        for (const folder of FOLDERS) {
            const text = webText(WEB[folder] as string[]);
            for (const u of usesIn(folder)) if (OWN_WORDS[u.key] && webSays(text, u.english)) needless.add(u.key);
        }
        const unused = Object.keys(OWN_WORDS).filter((k) => !ALL.some((u) => u.key === k));
        expect({ needless: [...needless], unused }).toEqual({ needless: [], unused: [] });
    });
});
