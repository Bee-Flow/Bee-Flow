/**
 * DIFFERENTIAL lockstep for the words of the value slot: the phone's
 * pickLabel, formulaSummary and pickSentence against the web's
 * `Builder/valueSlot/usePickLabel.ts` and `PickSentence.tsx`, run on the same
 * picks and intents with a `t` that hands back the key and the parameters, so
 * a different key, a different parameter or a different English fails here.
 * The sheet's option names: the web says `mapping.slot.options.<id>` for every
 * option the core offers, and the phone's table must name the same key for
 * every id, with the English the dictionary gives it.
 *
 * The model under these words is the shared core's (no port); these three are
 * the phone's spelling of the web's wording, kept because the web's live in
 * React components.
 */

import type { TranslateFn } from '@/core/i18n';
import { BUILDER, requireWeb } from '@/features/flow-editor/bindings/testing/web';
import { optionsFor, type PickIntent } from '@/shared/mapping';

import { formulaSummary, pickLabel, type PickLike } from './pickLabel';
import { optionLabel } from './PickOptionsSheet';
import { pickSentence } from './pickSentence';

// The web modules import their hook beside the pure functions; only the pure ones run here.
jest.mock('../../../../../agent-hub/src/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (_k: string, f: string) => f }) }));

/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const EN = require('../../../../../server/i18n/defaults/en/mapping.js') as Record<string, string>;

type Labels = Map<string, string> | null;
const webLabel = requireWeb(`${BUILDER}/valueSlot/usePickLabel.ts`) as unknown as {
    pickLabel: (t: TranslateFn, pick: unknown, ctx: { groupLabel: string }) => string;
    formulaSummary: (t: TranslateFn, binding: unknown, labels: Labels) => string;
};
const webSentence = requireWeb(`${BUILDER}/valueSlot/PickSentence.tsx`) as unknown as {
    pickSentence: (t: TranslateFn, intent: PickIntent, count?: number | null) => string;
};

/** What was said, not how it reads: the key, the English and the parameters. */
const said = ((key: string, english: string, params?: Record<string, unknown>) =>
    `${key}|${english}|${JSON.stringify(params ?? {})}`) as unknown as TranslateFn;

const TAKES = [undefined, 'one', 'all', 'first', 'last', 'count', 'each'];
const WILD = { wild: true };
const PATHS: unknown[][] = [
    [],
    ['email'],
    ['klant', 'email'],
    ['Klant', 'IBAN'],
    ['orders', 'product'],
    ['orders', 0],
    ['orders', 2],
    ['orders', 0, 'id'],
    ['orders', 3, 'id'],
    ['orders', WILD, 'sku'],
    ['first_name'],
    ['API key'],
    ['customerId', 'billingAddress', 'postCode'],
    [0],
    [1, 'name'],
];
const FROMS = (path: unknown[]) => [
    { root: 'steps', id: 'act_1', path },
    { root: 'trigger', path },
    { root: 'run', path },
    { root: 'vars', path },
    { root: 'item', path },
];

function picks(): PickLike[] {
    const out: PickLike[] = [];
    for (const path of PATHS) {
        for (const from of FROMS(path)) {
            for (const take of TAKES) out.push({ from, ...(take ? { take } : {}) } as PickLike);
        }
    }
    out.push({ from: { root: 'steps', id: 'a', path: ['x'] }, label: '  Stored name  ' }, { from: null }, { label: '' });
    return out;
}

describe('pickLabel against the web', () => {
    it.each(['', 'gmail search', 'Orderregels', 'CRM'])('words every pick the same, step %j', (group) => {
        for (const pick of picks()) {
            expect([pick, pickLabel(said, pick, group)]).toEqual([pick, webLabel.pickLabel(said, pick, { groupLabel: group })]);
        }
        expect(pickLabel(said, null, group)).toBe(webLabel.pickLabel(said, null, { groupLabel: group }));
    });
});

describe('formulaSummary against the web', () => {
    const labels = new Map([['act_1', 'Orders ophalen']]);
    it.each([
        { kind: 'ref', path: 'steps.act_1.output.items[*].email' },
        { kind: 'ref', path: 'trigger.output.naam' },
        { kind: 'ref', path: 'trigger.firedAt' },
        { kind: 'ref', path: 'steps.unknown.output.a[2].b' },
        { kind: 'ref', path: 'not a path' },
        { kind: 'expr', value: 'steps.act_1.output.total > 1 && "steps.act_1.output.x" == trigger.output.y' },
        { kind: 'expr', value: "join(steps.act_1.output.items[*].sku, ', ')" },
        { kind: 'template', value: 'Hoi {{ trigger.output.naam }},\n  je {{steps.act_1.output.items[0].sku}}' },
        { kind: 'literal', value: 'steps.act_1.output.x' },
        null,
        'text',
    ])('%j', (binding) => {
        expect(formulaSummary(said, binding, labels)).toBe(webLabel.formulaSummary(said, binding, labels));
        expect(formulaSummary(said, binding, null)).toBe(webLabel.formulaSummary(said, binding, null));
    });
});

describe('pickSentence against the web', () => {
    const intents: PickIntent[] = [];
    for (const take of ['one', 'all', 'first', 'last', 'count', 'each'] as const) {
        for (const as of ['native', 'text', 'list', 'number', 'date', 'yesno', 'json'] as const) {
            for (const join of [undefined, 'lines', 'comma', 'bullets'] as const) intents.push(join ? { take, as, join } : { take, as });
        }
    }
    it.each([undefined, null, 0, 1, 12, Number.NaN])('says the same for count %j', (count) => {
        for (const intent of intents) {
            expect([intent, pickSentence(said, intent, count)]).toEqual([intent, webSentence.pickSentence(said, intent, count)]);
        }
    });
});

describe('the sheet names an option the way the web does', () => {
    const ids = new Set<string>();
    for (const shape of ['missing', 'single', 'object', 'list', 'table', 'unknown'] as const) {
        for (const as of ['native', 'text', 'list', 'number', 'date', 'yesno', 'json'] as const) {
            for (const multiLine of [true, false]) {
                for (const repeat of [true, false]) {
                    for (const o of optionsFor(shape, { as, multiLine }, { repeat })) ids.add(o.id);
                }
            }
        }
    }

    it.each([...ids])('%s: mapping.slot.options.<id>, with the dictionary English', (id) => {
        const key = `mapping.slot.options.${id}`;
        expect(EN[key]).toEqual(expect.any(String));
        expect(optionLabel(said, id)).toBe(`${key}|${EN[key]}|{}`);
    });
});
