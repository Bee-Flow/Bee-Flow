// @vitest-environment node
import { describe, expect, it, test } from 'vitest';
import nodeLogicSummary, { collectLogicMarks, countLogicMarks, subtreeHasLogic } from './nodeLogicSummary';

/**
 * The canvas drew components and nothing else. "Which button does something?
 * which field refuses a bad value? which card is hidden from most people?" were
 * answerable only by selecting every node in turn and opening three inspector
 * accordions. This is what the canvas says instead — one sentence per rule, in
 * the author's language, so the badge's tooltip needs no further assembly.
 */

const DEFINITION = {
    screens: [
        { id: 'scr_a', name: 'List', sections: [{ id: 'sec_a', children: [
            { id: 'nd_modal', type: 'modal', props: { title: 'Confirm delete' }, children: [] },
        ] }] },
        { id: 'scr_b', name: 'Detail', sections: [{ id: 'sec_b', children: [] }] },
    ],
    actions: {
        act_go: { kind: 'navigate', screenId: 'scr_b' },
        act_flow: { kind: 'sequence', steps: [{ kind: 'toast', message: 'a' }, { kind: 'navigate', screenId: 'scr_b' }] },
        act_dialog: { kind: 'open_modal', modalId: 'nd_modal' },
    },
};

const texts = (node) => nodeLogicSummary(node, DEFINITION).map((m) => m.text);
const kinds = (node) => nodeLogicSummary(node, DEFINITION).map((m) => m.kind);

describe('nodeLogicSummary — what happens when someone uses it', () => {
    it('says the event AND what it does, by name', () => {
        expect(texts({ id: 'b', type: 'button', onClick: 'act_go' }))
            .toEqual(['When clicked: Go to Detail']);
    });

    it('names a dialog rather than its id', () => {
        expect(texts({ id: 'b', type: 'button', onClick: 'act_dialog' }))
            .toEqual(['When clicked: Open the “Confirm delete” dialog']);
    });

    it('counts the steps of a flow', () => {
        expect(texts({ id: 'b', type: 'button', onClick: 'act_flow' }))
            .toEqual(['When clicked: A flow of 2 steps']);
    });

    it('covers every event slot, not just onClick', () => {
        expect(texts({ id: 'g', type: 'data_grid', onRowClick: 'act_go' }))
            .toEqual(['When a row is clicked: Go to Detail']);
        expect(texts({ id: 'f', type: 'form', onSubmit: 'act_go' }))
            .toEqual(['When submitted: Go to Detail']);
    });

    /**
     * A slot pointing at an action that is not in definition.actions is a real
     * break — validate.js rejects it on the next save. Drawing a badge that
     * claims something happens would be worse than drawing none.
     */
    it('says so when the wiring points at nothing', () => {
        expect(texts({ id: 'b', type: 'button', onClick: 'act_deleted' })[0])
            .toContain('no longer exists');
    });
});

describe('nodeLogicSummary — the rules attached to a component', () => {
    it('reports a visibility condition, with the condition in it', () => {
        expect(texts({ id: 'c', type: 'card', visibleWhen: { kind: 'formula', expr: "currentUser.role == 'admin'" } }))
            .toEqual(["Only shown when currentUser.role == 'admin'"]);
    });

    it('reports a plainly hidden component too', () => {
        expect(texts({ id: 'c', type: 'card', visible: false })).toEqual(['Hidden in the running app']);
    });

    it('prefers the condition over the flag when both are set', () => {
        const marks = texts({ id: 'c', type: 'card', visible: false, visibleWhen: { kind: 'formula', expr: 'vars.ok' } });
        expect(marks).toEqual(['Only shown when vars.ok']);
    });

    it('reads a legacy bare expression string as well as the envelope', () => {
        expect(texts({ id: 'c', type: 'card', enabledWhen: 'form.agree == true' }))
            .toEqual(['Only usable when form.agree == true']);
    });

    it('counts validation rules and computed props', () => {
        const node = {
            id: 'i',
            type: 'input_text',
            validations: [{ type: 'required' }, { type: 'formula', expr: 'x' }],
            computed: { label: { kind: 'formula', expr: 'a' } },
        };
        expect(texts(node)).toEqual([
            'Checks 2 rules before submitting',
            'Works out label while the app runs',
        ]);
    });

    it('shortens a long condition so the tooltip stays one line', () => {
        const expr = `form.a == '${'x'.repeat(120)}'`;
        const [text] = texts({ id: 'c', type: 'card', visibleWhen: { kind: 'formula', expr } });
        expect(text.length).toBeLessThan(90);
        expect(text.endsWith('…')).toBe(true);
    });
});

describe('nodeLogicSummary — staying rare enough to mean something', () => {
    it('says nothing about a plain component', () => {
        expect(nodeLogicSummary({ id: 't', type: 'text', props: { text: 'hi' } }, DEFINITION)).toEqual([]);
        expect(nodeLogicSummary(null, DEFINITION)).toEqual([]);
    });

    it('gives each mark a distinct kind so the canvas can draw them apart', () => {
        const node = {
            id: 'x',
            type: 'input_text',
            onClick: 'act_go',
            visibleWhen: { kind: 'formula', expr: 'a' },
            enabledWhen: { kind: 'formula', expr: 'b' },
            validations: [{ type: 'required' }],
            computed: { label: { kind: 'formula', expr: 'c' } },
        };
        expect(kinds(node)).toEqual(['action', 'visibility', 'enablement', 'validation', 'computed']);
        // Keys are unique — they become React keys on the badge strip.
        const ks = nodeLogicSummary(node, DEFINITION).map((m) => m.key);
        expect(new Set(ks).size).toBe(ks.length);
    });
});

describe('subtreeHasLogic', () => {
    it('sees logic on a descendant, not just on the node itself', () => {
        const container = {
            id: 'c', type: 'card', children: [
                { id: 'inner', type: 'container', children: [{ id: 'b', type: 'button', onClick: 'act_go' }] },
            ],
        };
        expect(subtreeHasLogic(container, DEFINITION)).toBe(true);
    });

    it('is false for a wholly plain subtree', () => {
        const container = { id: 'c', type: 'card', children: [{ id: 't', type: 'text', props: {} }] };
        expect(subtreeHasLogic(container, DEFINITION)).toBe(false);
    });
});

/**
 * The header's "Logic n" segment and the canvas's named pill (Studio artboard
 * 1b) read the SAME marks: `countLogicMarks` is the segment's badge,
 * `collectLogicMarks` is the Logic view's rows, and the extra fields on an
 * action mark (`actionKind`, `actionTitle`) are what let the pill say "start
 * automation · <name>" instead of drawing an icon.
 */
const WIRED = {
    screens: [
        {
            id: 'scr_a',
            name: 'New request',
            sections: [{
                id: 'sec_a',
                children: [
                    { id: 'nd_btn', type: 'button', onClick: 'act_auto' },
                    {
                        id: 'nd_card',
                        type: 'card',
                        children: [{ id: 'nd_inner', type: 'button', onClick: 'act_go' }],
                    },
                    { id: 'nd_plain', type: 'text', visibleWhen: { kind: 'formula', expr: 'a' } },
                ],
            }],
        },
        { id: 'scr_b', name: 'Detail', sections: [{ id: 'sec_b', children: [] }] },
    ],
    actions: {
        act_auto: { kind: 'run_automation', automationId: 'auto_1' },
        act_go: { kind: 'navigate', screenId: 'scr_b' },
    },
};

describe('countLogicMarks — the header segment badge', () => {
    it('counts wired events across screens and inside containers', () => {
        expect(countLogicMarks(WIRED)).toBe(2);
    });

    it('does not count rules that only shape a component', () => {
        // nd_plain carries a visibility rule and nothing else.
        expect(countLogicMarks({ ...WIRED, actions: {} })).toBe(2);
        expect(countLogicMarks({ screens: WIRED.screens.slice(1), actions: {} })).toBe(0);
    });

    it('never throws on a half-built definition', () => {
        expect(countLogicMarks(null)).toBe(0);
        expect(countLogicMarks({})).toBe(0);
        expect(countLogicMarks({ screens: [{ id: 's' }] })).toBe(0);
    });
});

describe('collectLogicMarks — the Logic view rows', () => {
    it('carries the screen and the component each mark sits on', () => {
        const rows = collectLogicMarks(WIRED);
        expect(rows.map((r) => [r.screenName, r.nodeId, r.mark.kind])).toEqual([
            ['New request', 'nd_btn', 'action'],
            ['New request', 'nd_inner', 'action'],
            ['New request', 'nd_plain', 'visibility'],
        ]);
    });
});

describe('an action mark names the automation behind it', () => {
    it('reports the action kind, so the pill can pick its colour and icon', () => {
        const [mark] = nodeLogicSummary({ id: 'b', type: 'button', onClick: 'act_auto' }, WIRED);
        expect(mark.actionKind).toBe('run_automation');
        expect(mark.event).toBe('onClick');
        expect(mark.actionId).toBe('act_auto');
    });

    it('resolves the title through titleFor, and stays null without one', () => {
        const node = { id: 'b', type: 'button', onClick: 'act_auto' };
        expect(nodeLogicSummary(node, WIRED)[0].actionTitle).toBeNull();
        const named = nodeLogicSummary(node, WIRED, (id) => (id === 'auto_1' ? 'Calculate quote' : null));
        expect(named[0].actionTitle).toBe('Calculate quote');
        expect(named[0].text).toBe('When clicked: Run automation — Calculate quote');
    });

    it('leaves actionTitle null for a kind that is not an automation', () => {
        const [mark] = nodeLogicSummary({ id: 'b', type: 'button', onClick: 'act_go' }, WIRED, () => 'nope');
        expect(mark.actionKind).toBe('navigate');
        expect(mark.actionTitle).toBeNull();
    });
});
/**
 * Every sentence in this module is a KEY now, not a literal. Only a t() that
 * answers in another language can tell the two apart: the English fallback
 * renders identically whether `t` is threaded all the way down or quietly
 * dropped on the next refactor, so a test asserting English would go on
 * passing over a module that had stopped translating.
 *
 * The five event wordings are the inspector's own keys — the same sentence in
 * two places is one key, not two.
 */
describe('nodeLogicSummary — the wording comes from the dictionary', () => {
    const NL = {
        'app_studio.inspector.when_clicked': 'Bij klikken',
        'app_studio.canvas.mark_event': '{event} → {what}',
        'app_studio.canvas.mark_visible_when': 'Alleen zichtbaar als {expr}',
        'app_studio.canvas.mark_validations_plural': 'Controleert {n} regels',
        'app_studio.canvas.mark_missing_action': 'wijst naar een actie die niet meer bestaat',
    };
    const t = (key, en, params) => Object.entries(params || {})
        .reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), NL[key] ?? en);

    it('asks t() for the event wording and for the sentence around it', () => {
        const [mark] = nodeLogicSummary({ id: 'b', type: 'button', onClick: 'act_go' }, DEFINITION, null, t);
        expect(mark.text).toBe('Bij klikken → Go to Detail');
    });

    it('translates the rules attached to a component, and the plural picks its own key', () => {
        const node = {
            id: 'c',
            type: 'card',
            visibleWhen: { kind: 'formula', expr: 'vars.ok' },
            validations: [{ type: 'required' }, { type: 'formula', expr: 'x' }],
        };
        expect(nodeLogicSummary(node, DEFINITION, null, t).map((m) => m.text))
            .toEqual(['Alleen zichtbaar als vars.ok', 'Controleert 2 regels']);
    });

    it('translates the broken-wiring sentence too', () => {
        const [mark] = nodeLogicSummary({ id: 'b', type: 'button', onClick: 'act_deleted' }, DEFINITION, null, t);
        expect(mark.text).toBe('Bij klikken → wijst naar een actie die niet meer bestaat');
    });

    it('hands the same t() down to the Logic view rows', () => {
        const rows = collectLogicMarks(WIRED, null, t);
        expect(rows[0].mark.text).toBe('Bij klikken → Run automation');
    });

    it('falls back to English for a caller that has no t() at all', () => {
        // countLogicMarks and every existing caller relies on this.
        expect(texts({ id: 'b', type: 'button', onClick: 'act_go' })).toEqual(['When clicked: Go to Detail']);
    });
});


// From P5's own adversarial round. `onChange` is in NODE_EVENTS beside the
// other five, so the `default` arm was not unreachable: it printed the raw
// JavaScript property name into a sentence a builder reads. The wording was
// already in both dictionaries, one module over.
test('every wired event slot reads as words, never as its property name', async () => {
    const { NODE_EVENTS } = await import('../state/definitionOps');
    expect(NODE_EVENTS.length).toBeGreaterThan(0);
    for (const event of NODE_EVENTS) {
        // A real action from DEFINITION, so the mark is actually produced —
        // the first version of this test handed a NODE where a DEFINITION was
        // expected, got an empty array back, and passed no matter what.
        const marks = nodeLogicSummary({ id: 'nd_x', type: 'button', [event]: 'act_go' }, DEFINITION);
        expect(marks.length, `${event} produces a mark`).toBe(1);
        expect(marks[0].text, `${event} must not leak its identifier`).not.toContain(event);
    }
});
