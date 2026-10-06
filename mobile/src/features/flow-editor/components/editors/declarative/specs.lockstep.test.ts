/**
 * The declarative specs, held to the web editors they stand in for
 * (agent-hub `Builder/flow/settings/**`), to nodeDefs, and to the two
 * English dictionaries:
 *
 *   - STRUCTURE: every section is one of its type's nodeDefs `sectionKeys`,
 *     in that order;
 *   - WORDS: a borrowed key exists in both dictionaries with the same English;
 *     a `mobile.*` key is shaped like a key (i18nGuard cannot see these — they
 *     travel as data, not as `t('…')` calls);
 *   - TEXTUAL: every section title and field label the phone words itself is
 *     the web editor's own words, and every option list the web writes out as
 *     `<option value>` rows or a const array is the same list in the same order;
 *   - DIFFERENTIAL: the Privacy Shield's modes and its edge-cost rule run
 *     beside the web's privacyModel.js.
 * A failure here means the web editor changed: update the spec, don't loosen
 * the test.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CLIENT_DICT, SERVER_DICT, readDict } from '@/core/i18n/dictionaryText';
import type { FlowCatalog } from '@/features/flow-editor/api';
import type { FlowNode } from '@/features/flow-editor/bindings';
import type { FormDraft } from '@/features/flow-editor/formState';
import { nodeDef } from '@/features/flow-editor/model';

import { fieldId, resolveOptions, specDraft, writeField } from './runtime';
import type { EditorSpec, FieldSpec, Msg, SpecContext, Words } from './spec';
import {
    CHART_TYPES,
    DECK_FONTS,
    droppedEdgesOnModeChange,
    FALLBACK_STRATEGIES,
    NOTE_COLORS,
    PII_CATEGORY_KEYS,
    PRIVACY_MODE_WORDS,
    SLIDE_LAYOUTS,
    SLIDE_VISUALS,
    SPECS,
} from './specs';
import { specContext } from './testing';

const REPO = path.resolve(__dirname, '../../../../../../..');
const BUILDER = path.join(REPO, 'agent-hub/src/components/automation/Builder');
const read = (rel: string) => fs.readFileSync(path.join(BUILDER, rel), 'utf8');
/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const webPrivacy = require(path.join(BUILDER, 'flow/privacyModel.js'));

/** The web files each spec stands in for. */
const WEB: Record<string, string[]> = {
    wait: ['flow/settings/collectionEditors.jsx'],
    limit: ['flow/settings/collectionEditors.jsx'],
    dedupe: ['flow/settings/collectionEditors.jsx'],
    aggregate: ['flow/settings/collectionEditors.jsx'],
    summarize: ['flow/settings/collectionEditors.jsx'],
    datetime: ['flow/settings/collectionEditors.jsx'],
    notification: ['flow/settings/actionEditors/notificationFields.jsx', 'flow/settings/collectionEditors.jsx'],
    stop_error: ['flow/settings/actionEditors/stopErrorFields.jsx'],
    return_to_app: ['flow/settings/returnToAppEditor.jsx'],
    layer_output: ['flow/settings/actionEditors/flowletCallFields.jsx'],
    knowledge_write: ['flow/settings/knowledgeWriteEditors.jsx', 'flow/settings/collectionEditors.jsx'],
    data_extraction: ['flow/settings/actionEditors/dataExtractionFields.jsx'],
    generate_document: ['flow/settings/actionEditors/documentFields.jsx'],
    fill_document: ['flow/settings/actionEditors/documentFields.jsx'],
    slide: ['flow/settings/actionEditors/slideFields.jsx'],
    presentation: ['flow/settings/actionEditors/presentationFields.jsx'],
    guard: ['flow/settings/privacyEditors.jsx'],
    tokenize: ['flow/settings/privacyEditors.jsx'],
    untokenize: ['flow/settings/privacyEditors.jsx'],
    call_block: ['flow/settings/actionEditors/flowletCallFields.jsx', 'flow/CallContractFields.jsx'],
    call_layer: ['flow/settings/actionEditors/flowletCallFields.jsx', 'flow/CallContractFields.jsx'],
    note: ['flow/nodes/NoteNode.jsx'],
    integration_action: ['flow/settings/actionEditors/integrationActionFields.jsx'],
    flatten: ['flow/settings/FlattenFields.tsx', 'flow/settings/FlattenColumnsPanel.tsx', 'flow/settings/collectionEditors.jsx'],
};
/** The editor function a type's spec stands in for, where several share one file. */
const FN: Record<string, string> = {
    wait: 'WaitFields',
    limit: 'LimitFields',
    dedupe: 'DedupeFields',
    aggregate: 'AggregateFields',
    summarize: 'SummarizeFields',
    datetime: 'DateTimeFields',
    generate_document: 'GenerateDocumentFields',
    fill_document: 'FillDocumentFields',
};

/** One function's source: from its `function Name(` to the next top-level function or export. */
function fnSource(src: string, name: string): string {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) return '';
    const rest = src.slice(start + 1);
    const end = rest.search(/\n(?:function |export |const [A-Z_]+ = )/);
    return src.slice(start, end < 0 ? undefined : start + 1 + end);
}

/** The web source a spec is checked against: its editor function, or its whole files. */
function webText(type: string): string {
    const files = (WEB[type] || []).map(read);
    const fn = FN[type];
    if (!fn) return files.join('\n');
    // The shared rows (the collection source, forEach, retry) live beside the editor.
    return [fnSource(files[0] as string, fn), ...files.slice(1), fnSource(files[0] as string, 'CollectionArrayRefField')].join('\n');
}

/**
 * Words the phone says in its own way, each with the reason. Everything else a
 * spec labels with a `mobile.*` key must be the web editor's own words.
 */
const OWN_WORDS: Record<string, string> = {
    'mobile.flow.note.section': 'the web edits a note on the canvas; it has no settings band',
    'mobile.flow.note.text': 'same',
    'mobile.flow.note.color': 'same (the web shows swatches, not a word)',
    'mobile.flow.slide.stacked': 'the web labels the checkbox row "Stacked" and the box "Stack the series"; the phone has one row',
    'mobile.flow.deck.use_house_style': 'the web labels the row "House style" and the box "Use the house style"',
    'mobile.flow.doc.keep_copy': 'the web labels the row "Also keep it in Documents" and the box "Keep a copy"; the phone has one row',
    'mobile.flow.privacy.stop': 'a checkbox\'s words on the web, a toggle row\'s label here',
    'mobile.flow.privacy.mask': 'same',
    'mobile.flow.privacy.what': 'the web\'s row label; kept, checked as a label below',
    'mobile.flow.call.flowlet': 'the web passes it as headerTitle="Flowlet"',
    'mobile.flow.call.step': 'the web passes it as headerTitle="Step"',
};

// ── Walking a spec ─────────────────────────────────────────────────────

const CATALOG = {
    apps: [],
    knowledgeBases: [
        { id: 'kb1', name: 'Handbook', canWrite: true, scope: 'org' },
        { id: 'kb2', name: 'Private', canWrite: false, scope: null },
    ],
    knowledgeWriteStrategies: [],
    steps: [],
} as unknown as FlowCatalog;

function isMsg(v: unknown): v is Msg {
    return Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string' && /^[a-z_]+\./.test(v[0]);
}

function selectLike(f: FieldSpec): f is Extract<FieldSpec, { options: unknown }> {
    return 'options' in f;
}

/** The drafts a spec's words depend on: the step as it opens, and every static option chosen in turn. */
function draftsFor(spec: EditorSpec, ctx: SpecContext): FormDraft[] {
    const base = specDraft(spec, ctx.step);
    const drafts: FormDraft[] = [base, { ...base, documentId: 'd1', arrayRef: '', saveCopy: true, visual: 'chart' }];
    for (const section of spec.sections) {
        for (const f of section.fields) {
            if (!selectLike(f) || typeof f.options === 'function') continue;
            for (const o of f.options) drafts.push(writeField(f, o.value, base, ctx));
        }
    }
    return drafts;
}

function wordsIn(words: Words | undefined, drafts: FormDraft[], ctx: SpecContext): Msg[] {
    if (!words) return [];
    if (typeof words !== 'function') return [words];
    return drafts.map((d) => words(d, ctx)).filter((m): m is Msg => !!m);
}

function fieldMsgs(f: FieldSpec, drafts: FormDraft[], ctx: SpecContext): Msg[] {
    const out = [...wordsIn(f.label, drafts, ctx), ...wordsIn(f.hint, drafts, ctx)];
    if (f.prompt) out.push(f.prompt);
    if (f.kind === 'number' && f.suffix) out.push(f.suffix);
    if (f.kind === 'toggle') out.push(...wordsIn(f.description, drafts, ctx));
    if (selectLike(f)) {
        for (const d of drafts) {
            for (const o of resolveOptions(f.options, d, ctx)) out.push(...[o.label, o.blurb].filter(isMsg));
        }
    }
    return out;
}

function msgsOf(spec: EditorSpec): Msg[] {
    const ctx = specContext({ id: 's1', type: spec.type } as FlowNode, { catalog: CATALOG });
    const drafts = draftsFor(spec, ctx);
    const out: Msg[] = [];
    for (const section of spec.sections) {
        out.push(section.title, ...(section.intro ? [section.intro] : []));
        for (const f of section.fields) out.push(...fieldMsgs(f, drafts, ctx));
    }
    return out;
}

const TYPES = Object.keys(SPECS);
const spec = (type: string) => SPECS[type] as EditorSpec;

// ── Structure ──────────────────────────────────────────────────────────

/** One editor over three runtime types: its sections are any of the three's. */
const PRIVACY_TYPES = ['guard', 'tokenize', 'untokenize'];
const sectionKeysOf = (type: string): string[] =>
    PRIVACY_TYPES.includes(type)
        ? [...new Set(PRIVACY_TYPES.flatMap((t) => nodeDef(t)?.sectionKeys ?? []))]
        : (nodeDef(type)?.sectionKeys ?? []);

describe('structure', () => {
    it.each(TYPES)('%s: its sections are nodeDefs sectionKeys, in order', (type) => {
        const keys = sectionKeysOf(type);
        const own = spec(type).sections.map((s) => s.key);
        expect(own.every((k) => keys.includes(k))).toBe(true);
        expect(own).toEqual(keys.filter((k) => own.includes(k)));
    });

    it.each(TYPES)('%s: every field has its own id', (type) => {
        const ids = spec(type).sections.flatMap((s) => s.fields.map(fieldId));
        expect(ids.length).toBe(new Set(ids).size);
    });
});

// ── Words ──────────────────────────────────────────────────────────────

describe('words', () => {
    const client = readDict(CLIENT_DICT);
    const server = readDict(SERVER_DICT);
    const unescape = (v: string | undefined) => (v ?? '').replace(/\\(['"\\])/g, '$1');

    it.each(TYPES)('%s: a borrowed key is in both dictionaries with the same English; an own key is shaped like one', (type) => {
        const problems: string[] = [];
        for (const [key, english] of msgsOf(spec(type))) {
            if (key.startsWith('mobile.')) {
                if (!/^mobile\.[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(key)) problems.push(`malformed ${key}`);
                continue;
            }
            if (!client.has(key) || !server.has(key)) problems.push(`missing ${key}`);
            else if (unescape(server.get(key)) !== english) problems.push(`${key}: "${english}" ≠ "${unescape(server.get(key))}"`);
        }
        expect(problems).toEqual([]);
    });
});

// ── Textual, against the web editors ───────────────────────────────────

/**
 * The words in a web editor: `title="…"`, `label="…"`, `headerTitle="…"`,
 * `<span>…</span>` and the string literals its ternaries choose between.
 */
function webWords(src: string): Set<string> {
    const out = new Set<string>();
    for (const m of src.matchAll(/\b(?:title|label|headerTitle)=\{?["']([^"']+)["']/g)) out.add(m[1] as string);
    for (const m of src.matchAll(/<span>([^<{]+)<\/span>/g)) out.add((m[1] as string).trim());
    for (const m of src.matchAll(/'([^'\n]{2,})'/g)) out.add(m[1] as string);
    return out;
}

describe('against the web editors', () => {
    it.each(TYPES)('%s: the section titles and field labels are the web editor’s words', (type) => {
        const words = webWords(webText(type));
        const ctx = specContext({ id: 's1', type } as FlowNode, { catalog: CATALOG });
        const drafts = draftsFor(spec(type), ctx);
        const strays: string[] = [];
        for (const section of spec(type).sections) {
            const labels = [section.title, ...section.fields.flatMap((f) => wordsIn(f.label, drafts, ctx))];
            for (const [key, english] of labels) {
                if (!key.startsWith('mobile.') || OWN_WORDS[key]) continue;
                if (!words.has(english.replace(/’/g, '\''))) strays.push(`${key} "${english}"`);
            }
        }
        expect(strays).toEqual([]);
    });

    /** The `<option value>` rows of the web `<select>` whose onChange sets `key`. */
    function webOptions(src: string, key: string): string[] | null {
        const at = src.indexOf(`set('${key}', e.target.value)`);
        if (at < 0) return null;
        const chunk = src.slice(src.lastIndexOf('<select', at), src.indexOf('</select>', at));
        // A list mapped from a const is checked on its own (the slide's and the deck's lists).
        if (chunk.includes('.map(')) return null;
        return [...chunk.matchAll(/<option[^>]*?value="([^"]*)"/g)].map((m) => m[1] as string);
    }

    /** Every static option list of a spec beside the web's, where the web writes it out. */
    function optionLists(type: string): { field: string; ours: string[]; web: string[] }[] {
        const src = webText(type);
        const out: { field: string; ours: string[]; web: string[] }[] = [];
        for (const section of spec(type).sections) {
            for (const f of section.fields) {
                if (!selectLike(f) || typeof f.options === 'function' || !f.key) continue;
                const web = webOptions(src, f.key);
                if (web && web.length) out.push({ field: f.key, ours: f.options.map((o) => o.value), web });
            }
        }
        return out;
    }

    it.each(TYPES)('%s: every option list the web writes out is the same list', (type) => {
        for (const { field, ours, web } of optionLists(type)) expect({ field, values: ours }).toEqual({ field, values: web });
    });

    it('found the web’s option lists at all', () => {
        expect(TYPES.flatMap(optionLists).length).toBeGreaterThan(15);
    });

    /** `const NAME = [ ['v', 'Label'], … ]` in a web file. */
    function webPairs(src: string, name: string): [string, string][] {
        const start = src.indexOf(`const ${name} = [`);
        const body = src.slice(start, src.indexOf('];', start));
        return [...body.matchAll(/\['([^']*)',\s*'([^']*)'\]/g)].map((m) => [m[1] as string, m[2] as string]);
    }

    it('the slide’s layouts, visuals and chart types', () => {
        const src = read('flow/settings/actionEditors/slideFields.jsx');
        const pairs = (list: typeof SLIDE_LAYOUTS) => list.map((o) => [o.value, (o.label as Msg)[1]]);
        expect(pairs(SLIDE_LAYOUTS)).toEqual(webPairs(src, 'SLIDE_LAYOUT_OPTIONS'));
        expect(pairs(SLIDE_VISUALS)).toEqual(webPairs(src, 'SLIDE_VISUAL_OPTIONS'));
        expect(pairs(CHART_TYPES)).toEqual(webPairs(src, 'CHART_TYPE_OPTIONS'));
    });

    it('the deck’s typefaces', () => {
        const src = read('flow/settings/actionEditors/presentationFields.jsx');
        const list = /const DECK_FONT_OPTIONS = \[([^\]]*)\]/.exec(src)?.[1] ?? '';
        expect([...DECK_FONTS]).toEqual([...list.matchAll(/'([^']+)'/g)].map((m) => m[1]));
    });

    it('the note’s colours', () => {
        const list = /const COLOR_KEYS = \[([^\]]*)\]/.exec(read('flow/nodes/NoteNode.jsx'))?.[1] ?? '';
        expect([...NOTE_COLORS]).toEqual([...list.matchAll(/'([^']+)'/g)].map((m) => m[1]));
    });

    it('the knowledge base’s fallback strategies', () => {
        const src = read('flow/settings/knowledgeWriteEditors.jsx');
        const web = [...src.matchAll(/\{ value: '([^']+)', label: '([^']+)', blurb: '([^']+)' \}/g)].map((m) => [m[1], m[2], m[3]]);
        expect(FALLBACK_STRATEGIES.map((o) => [o.value, (o.label as Msg)[1], (o.blurb as Msg)[1]])).toEqual(web);
    });

    it('the PII categories, with the web’s label keys, in the web’s order', () => {
        const src = fs.readFileSync(path.join(REPO, 'agent-hub/src/config/piiCategories.ts'), 'utf8');
        const web = [...src.matchAll(/\{ id: '([^']+)',[^}]*i18nKey: '([^']+)' \}/g)].map((m) => [m[1], m[2]]);
        expect(web.length).toBeGreaterThan(15);
        expect(PII_CATEGORY_KEYS.map(([id, key]) => [id, key])).toEqual(web);
    });
});

// ── Differential, against privacyModel.js ──────────────────────────────

describe('the Privacy Shield against privacyModel.js', () => {
    it('offers the web’s modes, words and all', () => {
        const web = webPrivacy.PRIVACY_MODES as { id: string; label: string; blurb: string }[];
        expect(PRIVACY_MODE_WORDS.map((o) => [o.value, (o.label as Msg)[1], (o.blurb as Msg)[1]])).toEqual(web.map((m) => [m.id, m.label, m.blurb]));
    });

    const EDGES = [
        { from: 'g', to: 'a', label: 'then' },
        { from: 'g', to: 'b', label: 'else' },
        { from: 'g', to: 'c', label: 'on_error' },
        { from: 'x', to: 'g' },
    ];
    const STEPS = [
        { id: 'g', type: 'guard' },
        { id: 'g', type: 'guard', onFound: { tokenize: true } },
        { id: 'g', type: 'tokenize' },
        { id: 'g', type: 'untokenize' },
        { id: '', type: 'guard' },
        null,
    ];
    it.each(STEPS.flatMap((s) => ['check', 'check_hide', 'hide', 'reveal', 'nonsense'].map((m) => [s, m] as const)))(
        'costs the same connections for %j → %s',
        (step, mode) => {
            expect(droppedEdgesOnModeChange(step as FlowNode, mode, EDGES)).toEqual(webPrivacy.droppedEdgesOnModeChange(step, mode, EDGES));
        },
    );
});
