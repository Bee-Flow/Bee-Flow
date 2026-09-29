import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { describeAction } from './actionLabels';
import {
    CARD_COPY, EDITOR_BY_KIND, KIND_OPTIONS, NOT_OFFERED_HERE, PRIMARY_KINDS,
    defaultActionForKind,
} from './actionKindCatalog';
import { ACTION_KINDS as EDITABLE_ACTION_KINDS } from './styleKnobMeta';

const require = createRequire(import.meta.url);
const specs = require('../../../../../../../server/appStudio/componentSpecs.js');

/**
 * ACTION-kind lockstep between this editor and the server catalog.
 *
 * `catalogLockstep.test.js` pins components, style knobs, events and the screen
 * enums. It says nothing at all about action kinds — and the lists had already
 * drifted three ways before anyone looked: the server shipped eleven kinds, the
 * select offered eleven (a different eleven's worth of labels), and
 * styleKnobMeta declared seven with a comment describing a fourth set.
 *
 * A naive equality test cannot be the guard, because "the editor does not offer
 * this kind" is sometimes a real decision. So the rule is two-directional and
 * leaves no silent third option:
 *
 *   • every kind this editor knows must exist on the server, and
 *   • every kind the server ships must be either OFFERED here or listed in
 *     NOT_OFFERED_HERE with a reason.
 *
 * Adding a kind on one side only therefore fails, in either direction.
 *
 * The runtime half of the same question — "does the kind actually DO anything
 * when clicked" — is `runtime/useActionRunner.actionKinds.test.jsx`. A kind can
 * be perfectly editable and still be a silent no-op, which is the worse bug.
 */

const offered = KIND_OPTIONS.map((o) => o.value);

describe('action kinds — the editor and the server agree', () => {
    it('offers no kind the server does not have', () => {
        for (const kind of offered) {
            expect(specs.ACTION_KINDS, `the select offers unknown kind "${kind}"`).toContain(kind);
        }
    });

    it('accounts for every kind the server ships — offered, or refused on the record', () => {
        for (const kind of specs.ACTION_KINDS) {
            const accounted = offered.includes(kind) || kind in NOT_OFFERED_HERE;
            expect(
                accounted,
                `server action kind "${kind}" is neither offered by the inspector nor listed in NOT_OFFERED_HERE`,
            ).toBe(true);
        }
    });

    it('refuses nothing it also offers', () => {
        for (const kind of Object.keys(NOT_OFFERED_HERE)) {
            expect(offered, `"${kind}" is both offered and refused`).not.toContain(kind);
            expect(specs.ACTION_KINDS, `NOT_OFFERED_HERE names unknown kind "${kind}"`).toContain(kind);
            expect(String(NOT_OFFERED_HERE[kind]).length, `"${kind}" is refused with no reason`).toBeGreaterThan(0);
        }
    });

    it('lists each kind exactly once', () => {
        expect(offered).toEqual([...new Set(offered)]);
    });

    it('styleKnobMeta agrees with the select', () => {
        // The old list was a hand-maintained subset with a comment that no
        // longer described it (open_modal/sequence "are AI-only" — they had
        // been in the select for months, and send_email/close_modal were
        // missing from BOTH the list and the comment).
        expect([...EDITABLE_ACTION_KINDS].sort()).toEqual([...offered].sort());
    });
});

describe('action kinds — every offered kind is presentable and editable', () => {
    it('has a label that is not the raw id', () => {
        for (const o of KIND_OPTIONS) {
            expect(o.labelEn.length, `"${o.value}" has no English label`).toBeGreaterThan(0);
            expect(o.labelEn, `"${o.value}" is labelled with its own id`).not.toBe(o.value);
            expect(o.labelKey.startsWith('app_studio.'), `"${o.value}" has no i18n key`).toBe(true);
        }
    });

    it('names an editor for every kind — an unrendered kind looks like a kind with no settings', () => {
        for (const kind of offered) {
            expect(EDITOR_BY_KIND[kind], `no editor declared for "${kind}"`).toBeTruthy();
            expect(['builtin', 'ai', 'spec', 'flow']).toContain(EDITOR_BY_KIND[kind]);
        }
    });

    it('declares an editor for nothing that is not a kind', () => {
        for (const kind of Object.keys(EDITOR_BY_KIND)) {
            expect(specs.ACTION_KINDS, `EDITOR_BY_KIND names unknown kind "${kind}"`).toContain(kind);
        }
    });

    it('describeAction names every kind without falling back to the id', () => {
        const definition = { screens: [{ id: 'scr_1', name: 'Home', sections: [] }], actions: {} };
        for (const kind of specs.ACTION_KINDS) {
            const action = defaultActionForKind(kind, definition, []);
            const described = describeAction('act_abc123', action, definition);
            expect(described, `describeAction fell back to the id for "${kind}"`).not.toBe('act_abc123');
            expect(String(described).length).toBeGreaterThan(0);
        }
    });
});

describe('the four cards', () => {
    it('are all real kinds the server ships', () => {
        for (const kind of PRIMARY_KINDS) {
            expect(specs.ACTION_KINDS, `card kind "${kind}" does not exist server-side`).toContain(kind);
            expect(offered, `card kind "${kind}" is not offered in the select`).toContain(kind);
        }
    });

    it('each carry a label AND a consequence — a card without one is a pill', () => {
        expect(Object.keys(CARD_COPY).sort()).toEqual([...PRIMARY_KINDS].sort());
        for (const kind of PRIMARY_KINDS) {
            const copy = CARD_COPY[kind];
            expect(copy.labelEn.length).toBeGreaterThan(0);
            expect(copy.blurbEn.length, `card "${kind}" has no description`).toBeGreaterThan(8);
            expect(copy.labelKey.startsWith('app_studio.')).toBe(true);
            expect(copy.blurbKey.startsWith('app_studio.')).toBe(true);
        }
    });

    it('agree with the select on what each kind is called', () => {
        for (const kind of PRIMARY_KINDS) {
            const inSelect = KIND_OPTIONS.find((o) => o.value === kind);
            expect(CARD_COPY[kind].labelKey).toBe(inSelect.labelKey);
            expect(CARD_COPY[kind].labelEn).toBe(inSelect.labelEn);
        }
    });
});

/**
 * A fresh action has to be VALID the moment it lands, or switching kind opens
 * the editor on a validation error the author did not cause. Mirrors
 * `flow/stepCatalog.lockstep.test.js`'s newStep checks.
 */
describe('defaultActionForKind — a fresh action the schema accepts', () => {
    const definition = {
        screens: [{ id: 'scr_1', name: 'Home', sections: [{ id: 'sec_1', children: [{ id: 'cmp_m1', type: 'modal', props: {} }] }] }],
        actions: {},
    };

    // A realistic enclosing form: ai_extract's required `source` can only be a
    // file input, so a form without one is a separate case (below).
    const formFields = [{ name: 'doc', type: 'input_file', multiple: false }];

    for (const kind of specs.ACTION_KINDS) {
        it(`${kind}: carries every required field and nothing the spec rejects`, () => {
            const action = defaultActionForKind(kind, definition, formFields);
            expect(action.kind).toBe(kind);
            const fields = specs.ACTION_SPECS[kind].fields;
            for (const [field, fs] of Object.entries(fields)) {
                if (!fs.required) continue;
                // `steps` is the sequence's own body — an empty flow is legal,
                // and the canvas is where it gets filled.
                if (fs.type === 'steps') continue;
                expect(action[field], `${kind}.${field} is required but missing`).not.toBe(undefined);
            }
            for (const key of Object.keys(action)) {
                if (key === 'kind') continue;
                expect(key in fields, `${kind}: default writes unknown field "${key}"`).toBe(true);
            }
        });
    }

    /**
     * The one default that could cost data. Guessing a table would make a fresh
     * "add a row" button write into a real table nobody chose — silently, on
     * the first click, into whichever table happened to be first.
     */
    it('create_record picks NO table — a guessed table is a write nobody asked for', () => {
        const withTables = defaultActionForKind('create_record', definition, []);
        expect(withTables.tableId).toBe('');
        expect(withTables.values).toEqual({});
    });

    /**
     * The one required field a default legitimately cannot fill. ai_extract
     * reads a FILE, and a form with no file input has nothing to point at —
     * inventing a binding to a field that does not exist would be a save-time
     * error blamed on the author. The gap is deliberate; this pins that it
     * stays a gap rather than becoming a wrong guess.
     */
    it('ai_extract with no file input leaves `source` unset rather than guessing', () => {
        const action = defaultActionForKind('ai_extract', definition, []);
        expect(action.source).toBeUndefined();
        expect(Array.isArray(action.schema)).toBe(true);
    });

    it('an unknown kind falls back to a run_automation, not to a broken object', () => {
        const action = defaultActionForKind('teleport_user', definition, []);
        expect(specs.ACTION_KINDS).toContain(action.kind);
    });
});
