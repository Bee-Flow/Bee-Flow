/**
 * Differential test: the web's skillModel.js and this port, run on the same
 * fixtures, must give the same answers. When this fails the web side changed —
 * update the port, never loosen the test (ARCHITECTURE "Sharing logic with the
 * web app").
 */

import fs from 'node:fs';
import path from 'node:path';

import * as port from './skillModel';

const STUDIO = path.resolve(__dirname, '../../../../../agent-hub/src/components/admin/Studio');

/**
 * The web module, evaluated from its source text. It is an ES module with one
 * relative import (KnowledgeStudio/plural.js); requiring it through Babel
 * would pull `@babel/runtime` from agent-hub's node_modules, which the mobile
 * job does not install. Both files are plain functions, so inlining the one
 * import and dropping the `export` keywords evaluates exactly the web's code.
 */
function loadWeb(): Record<string, (...args: unknown[]) => unknown> {
    const strip = (src: string) => src.replace(/^import .*$/gm, '').replace(/^export (default )?/gm, '');
    const plural = strip(fs.readFileSync(path.join(STUDIO, 'KnowledgeStudio/plural.js'), 'utf8'));
    const model = fs.readFileSync(path.join(STUDIO, 'SkillsStudio/skillModel.js'), 'utf8');
    const names = [...model.matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1] as string);
    return new Function(`${plural}\n${strip(model)}\nreturn { ${names.join(', ')} };`)() as Record<
        string,
        (...args: unknown[]) => unknown
    >;
}

const web = loadWeb();
const PORT: Record<string, unknown> = port;

/** Echo the key and the params, so a different key or count is a different answer. */
const t = (key: string, fallback: string, params: Record<string, unknown> = {}) =>
    `${key}|${fallback.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ''))}`;

const FULL = {
    id: 's1',
    name: 'Quotes',
    description: 'Answer quote questions',
    instructions: 'Use when a quote is asked about',
    icon: '',
    isShared: 1,
    dynamicActivation: 0,
    sharedGroups: ['g1', '', 3],
    enabledIntegrations: ['gmail'],
    steps: [
        { id: 'a', text: 'Look up', refs: [{ kind: 'kb', id: 7 }, { kind: 'bogus', id: 'x' }, { kind: 'table', id: '' }] },
        { text: 5, refs: 'no' },
        null,
        { id: 'c', text: 'Answer', refs: [{ kind: 'kb', id: '7' }, { kind: 'automation', id: 'r1' }] },
    ],
    rulesV2: [{ id: 'r', polarity: 'never', text: 'No dates' }, { polarity: 'maybe' }, 'x'],
    examplesV2: [{ id: 'e', question: 'Q', good: 'G', bad: 1 }, {}],
    outputSchema: { type: 'object', properties: { total: { type: 'number' } } },
    knowledgeBaseIds: ['kb1'],
    allowedAutomationIds: 'nope',
    lastUsedAt: '2026-09-01T00:00:00Z',
};
const EMPTY = { id: 's2', name: 'Blank', description: '  ', steps: null };
const LEGACY = { id: 's3', name: 'Alpha', description: 'Old', steps: [{ id: 'x', text: 'Go' }] };
const SKILLS = [FULL, EMPTY, LEGACY, { id: 's4', name: 'alpha' }];
const SUMMARY = {
    s1: { agents: 2, automations: 1, lastUsedAt: '2026-01-01T00:00:00Z' },
    s3: { agents: 0, automations: 0, lastUsedAt: '2026-09-20T00:00:00Z' },
    s4: { agents: 0, automations: 0, automationsUnchecked: true, lastUsedAt: null },
};

const same = (name: keyof typeof port, ...args: unknown[]) => {
    const mine = (PORT[name] as (...a: unknown[]) => unknown)(...args);
    const theirs = web[name]!(...args);
    expect({ name, value: mine }).toEqual({ name, value: theirs });
};

describe('skillModel ↔ the web skillModel.js', () => {
    it('normalises every facet the same way', () => {
        for (const skill of [...SKILLS, null, undefined, {}]) {
            same('stepsOf', skill);
            same('rulesOf', skill);
            same('examplesOf', skill);
            same('draftOf', skill);
            same('isEmptySkill', skill);
            same('idsOf', skill, 'sharedGroups');
            same('refIdsOfKind', skill, 'kb');
        }
    });

    it('says the same meta line, usage subline and test chip', () => {
        for (const skill of SKILLS) {
            same('metaLine', skill, t);
            for (const entry of [undefined, ...Object.values(SUMMARY), { agents: 1, automations: 0 }]) {
                same('usageSubline', skill, entry, t);
            }
        }
        for (const last of [null, {}, { status: 'error' }, { status: 'ok', adviceCount: 2 }, { status: 'warning' }, { status: 'ok' }]) {
            same('testChip', last, t);
        }
    });

    it('filters, sorts and moves the same way', () => {
        for (const q of ['', 'alpha', 'QUOTE', 'nothing']) same('filterSkills', SKILLS, q);
        for (const mode of port.SORT_MODES) {
            same('sortSkills', SKILLS, mode, SUMMARY);
            same('sortSkills', SKILLS, mode, null);
        }
        for (const [from, to] of [[0, 2], [2, 0], [0, 9], [-1, 1], [1, 1]]) same('moveItem', ['a', 'b', 'c'], from, to);
    });

    it('builds the same save payload and agrees on callable routines', () => {
        same('buildSavePayload', port.draftOf(FULL));
        for (const a of [
            { definition: { trigger: { kind: 'agent_call' } }, triggerType: 'manual' },
            { triggerKind: 'agent_call' },
            { triggerType: 'agent_call' },
            { triggerType: 'manual' },
            {},
        ]) {
            same('isAgentCallable', a);
        }
        for (const kind of ['kb', 'table', 'automation', 'other']) same('refKindKey', kind);
    });

    it('keeps the same fixed vocabularies', () => {
        expect([...port.REF_KINDS]).toEqual(web.REF_KINDS);
        expect([...port.RULE_POLARITIES]).toEqual(web.RULE_POLARITIES);
        expect([...port.SORT_MODES]).toEqual(web.SORT_MODES);
    });
});
