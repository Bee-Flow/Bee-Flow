import { fireEvent, render } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { describe, it, expect } from 'vitest';
import AppRenderer from './AppRenderer';
import { mergeFormValues } from './formValues';
import { EM_DASH } from './uiBits';

/**
 * REGRESSION — a formula-valued binding must never take a component down.
 *
 * ── WHAT HAPPENED ───────────────────────────────────────────────────────────
 * Every formula-valued `stat` in a generated calculator app rendered as "This
 * component failed" (React #301, too many re-renders), while a constant like
 * `2 + 3` and a bare `forms.std.a` were fine. The trigger was uiBits'
 * `useStickyBinding`, which remembered the previously resolved value in state
 * written DURING RENDER behind a `last !== value` guard:
 *
 *     const [last, setLast] = useState(undefined);
 *     if (!isLoading) {
 *         if (last !== value) setLast(value);      // ← render-phase setState
 *
 * React's render-phase update path has no Object.is bailout, so any value that
 * defeats `!==` re-renders the component until RE_RENDER_LIMIT and throws.
 * Two ordinary values do:
 *   1. NaN — `NaN !== NaN` is always true.
 *   2. a freshly allocated array/object — `split()`, `concat()`, `parseJson()`
 *      return a new reference every evaluation. No NaN required.
 *
 * ── WHY IT HIT *EVERY* FORMULA STAT AT ONCE ─────────────────────────────────
 * AppForm publishes its values through registerFormValue in an EFFECT, so on
 * the FIRST render pass the `forms` scope root is still `{}`. Every stat doing
 * arithmetic across form fields therefore evaluated `undefined + undefined` →
 * NaN on frame 1 — and the per-node boundary latched the failure before the
 * real values (`null + null` → a perfectly fine 0) ever arrived. That is why
 * live form binding looked like an architectural limit. It is not: the last
 * test here types into a form and watches the numbers move.
 *
 * `useStickyBinding` now keeps its memory in a REF, which cannot schedule a
 * render, so no value shape can loop there again — and the boundary retries a
 * failed node when the scope changes instead of latching for the session.
 *
 * ── WHICH TEST GUARDS WHICH LAYER ───────────────────────────────────────────
 * Put the old `useState` hook back and MINIMAL, SECOND TRIGGER and both
 * ten-stat tests go red — they are the ones pinning the hook. The two
 * app-shaped ones (RUN / EDITOR) go GREEN on the broken hook, because the
 * boundary's scope retry now rescues a tile that only failed on frame 1. That
 * is the defence-in-depth working as intended, not the test going soft: the
 * ten-stat screen still fails, since two of its formulas are NaN forever and
 * exhaust the retries.
 *
 * The controls in the last block pass BEFORE the fix too. They are kept so the
 * next reader does not have to re-derive which hypotheses are dead ends.
 */

const CRASHED = 'This component failed';

function defWith(children) {
    return {
        schemaVersion: 2,
        meta: { name: 'Calc', description: '', icon: 'LayoutGrid' },
        theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        homeScreenId: 'scr_c',
        screens: [{
            id: 'scr_c', name: 'Calc', icon: null, showInNav: true, maxWidth: 'medium',
            sections: [{ id: 'sec_c', style: { padding: 4, gap: 3, background: 'none' }, children }],
        }],
        actions: {},
    };
}

const stat = (id, expr, label = 'Result') => ({
    id, type: 'stat', visible: true,
    props: { label, value: { kind: 'formula', expr }, caption: null, icon: null },
    style: { span: 3 },
});

const numberField = (id, name, label) => ({
    id, type: 'input_number', visible: true,
    props: { name, label, min: null, max: null, step: 1, required: false, defaultValue: null },
    style: { span: 6 },
});

const form = (id, name, children) => ({
    id, type: 'form', visible: true,
    props: { name, submitLabel: 'Submit', showReset: false, showSubmit: false },
    style: { span: 12, gap: 3 },
    children,
});

const card = (id, children) => ({
    id, type: 'card', visible: true,
    props: { title: null, description: null },
    style: { span: 12, padding: 3, gap: 3, background: 'surface' },
    children,
});

/**
 * The host's form plumbing — the same `mergeFormValues` fold that
 * pages/apps/AppRunPage (RunSurface) and editor/Canvas both use, so this
 * harness cannot drift away from either surface. `mode` is the only difference
 * between the two, and the crash reproduced in both.
 */
function Harness({ definition, mode = 'run' }) {
    const [forms, setForms] = useState({});
    const registerFormValue = useCallback((formName, values) => {
        setForms((prev) => mergeFormValues(prev, formName, values));
    }, []);
    return (
        <AppRenderer
            definition={definition}
            screenId="scr_c"
            mode={mode}
            forms={forms}
            registerFormValue={registerFormValue}
        />
    );
}

const FORM_AND_SUM = () => defWith([
    card('cmp_card_form', [form('cmp_form', 'std', [
        numberField('cmp_a', 'a', 'A'),
        numberField('cmp_b', 'b', 'B'),
    ])]),
    card('cmp_card_stats', [stat('cmp_sum', 'forms.std.a + forms.std.b', 'Sum')]),
]);

describe('AppRenderer — a formula binding never loops the component that reads it', () => {
    it('MINIMAL: one stat, no form, no tabs — a formula resolving to NaN', () => {
        // No `forms` root at all → `forms.std.a` is undefined → undefined/undefined → NaN.
        const def = defWith([stat('cmp_s', 'forms.std.a / forms.std.b')]);
        const { queryByText } = render(<AppRenderer definition={def} screenId="scr_c" mode="run" />);
        expect(queryByText(CRASHED)).toBeNull();
    });

    it('SECOND TRIGGER: a formula returning a FRESH array every render', () => {
        // split() allocates a new array on every evaluation, so `last !== value`
        // was true forever even without a NaN in sight.
        const def = defWith([stat('cmp_s2', 'split("a,b", ",")')]);
        const { queryByText } = render(<AppRenderer definition={def} screenId="scr_c" mode="run" />);
        expect(queryByText(CRASHED)).toBeNull();
    });

    it('RUN surface, app shape: form + sibling stat doing arithmetic across two fields', () => {
        const { queryByText } = render(<Harness definition={FORM_AND_SUM()} />);
        expect(queryByText(CRASHED)).toBeNull();
    });

    it('EDITOR canvas, app shape: the same screen in the editor preview', () => {
        // The user who hit this was in the editor preview, so it has to hold here too.
        const { queryByText } = render(<Harness definition={FORM_AND_SUM()} mode="edit" />);
        expect(queryByText(CRASHED)).toBeNull();
    });

    it('the real app shape: tabs → tab → card(form) + card(stats), every tile survives', () => {
        const tab = (id, name, label) => ({
            id: `cmp_tab_${id}`, type: 'tab', visible: true,
            props: { label, icon: null }, style: { gap: 3, padding: 0 },
            children: [
                card(`cmp_cf_${id}`, [form(`cmp_form_${id}`, name, [
                    numberField(`cmp_${id}_a`, 'a', 'A'),
                    numberField(`cmp_${id}_b`, 'b', 'B'),
                ])]),
                card(`cmp_cs_${id}`, [
                    stat(`cmp_${id}_sum`, `forms.${name}.a + forms.${name}.b`, 'Sum'),
                    stat(`cmp_${id}_ratio`, `forms.${name}.a > 0 ? forms.${name}.b / forms.${name}.a : 0`, 'Ratio'),
                ]),
            ],
        });
        const def = defWith([{
            id: 'cmp_tabs', type: 'tabs', visible: true, props: {}, style: { span: 12, gap: 3, padding: 0 },
            children: [tab('std', 'std', 'Standard'), tab('sci', 'sci', 'Scientific')],
        }]);
        const { queryAllByText } = render(<Harness definition={def} />);
        expect(queryAllByText(CRASHED)).toHaveLength(0);
    });
});

/**
 * THE SHAPE THAT FAILED FOR THE USER, at full size: a screen of ten stats all
 * reading `forms.*` from inside tabs. Every one of them did arithmetic, so
 * every one of them was NaN on frame 1 and all ten latched at once — which is
 * precisely why "live form binding" looked broken rather than "one hook loops".
 */
describe('AppRenderer — ten forms.* stats inside tabs', () => {
    // label, expression, what it shows once A=7 and B=2 have been typed in.
    // The last two stay an em-dash on purpose: they read a field and a form
    // that do not exist, so they are NaN forever — the case that used to be
    // fatal rather than merely blank.
    const EXPRESSIONS = [
        ['Sum', 'forms.std.a + forms.std.b', (9).toLocaleString()],
        ['Difference', 'forms.std.a - forms.std.b', (5).toLocaleString()],
        ['Product', 'forms.std.a * forms.std.b', (14).toLocaleString()],
        ['Quotient', 'forms.std.a / forms.std.b', (3.5).toLocaleString()],
        ['Remainder', 'forms.std.a % forms.std.b', (1).toLocaleString()],
        ['Mean', '(forms.std.a + forms.std.b) / 2', (4.5).toLocaleString()],
        ['Guarded ratio', 'forms.std.b > 0 ? forms.std.a / forms.std.b : 0', (3.5).toLocaleString()],
        ['Missing field', 'forms.std.a * forms.std.missing', EM_DASH],
        ['Missing form', 'forms.nope.x + forms.std.a', EM_DASH],
        ['Rounded', 'round(forms.std.a / forms.std.b, 2)', (3.5).toLocaleString()],
    ];

    /** The big number a stat is painting right now. */
    const statValue = (container, index) => container
        .querySelector(`[data-node-id="cmp_st_${index}"] .app-stat div.font-semibold`)
        ?.textContent;

    function tenStatDef() {
        const stats = EXPRESSIONS.map(([label, expr], i) => stat(`cmp_st_${i}`, expr, label));
        return defWith([{
            id: 'cmp_tabs', type: 'tabs', visible: true, props: {}, style: { span: 12, gap: 3, padding: 0 },
            children: [
                {
                    id: 'cmp_tab_calc', type: 'tab', visible: true,
                    props: { label: 'Calculator', icon: null }, style: { gap: 3, padding: 0 },
                    children: [
                        card('cmp_cf', [form('cmp_form', 'std', [
                            numberField('cmp_a', 'a', 'A'),
                            numberField('cmp_b', 'b', 'B'),
                        ])]),
                        card('cmp_cs', stats),
                    ],
                },
                {
                    id: 'cmp_tab_about', type: 'tab', visible: true,
                    props: { label: 'About', icon: null }, style: { gap: 3, padding: 0 },
                    children: [stat('cmp_const', '2 + 3', 'Constant')],
                },
            ],
        }]);
    }

    it('renders all ten without a single failed tile, on both surfaces', () => {
        for (const mode of ['run', 'edit']) {
            const { queryAllByText, getByText, unmount } = render(<Harness definition={tenStatDef()} mode={mode} />);
            expect(queryAllByText(CRASHED)).toHaveLength(0);
            // Every stat is really on screen — not merely "not crashed".
            for (const [label] of EXPRESSIONS) expect(getByText(label)).toBeTruthy();
            unmount();
        }
    });

    it('the numbers update live as the form is typed into — binding is not broken', () => {
        const { container, getByLabelText, queryAllByText } = render(<Harness definition={tenStatDef()} />);
        // Before anything is typed the tiles are empty, but ALIVE.
        expect(queryAllByText(CRASHED)).toHaveLength(0);

        fireEvent.change(getByLabelText('A'), { target: { value: '7' } });
        fireEvent.change(getByLabelText('B'), { target: { value: '2' } });

        expect(queryAllByText(CRASHED)).toHaveLength(0);
        EXPRESSIONS.forEach(([label, , expected], i) => {
            expect(`${label}: ${statValue(container, i)}`).toBe(`${label}: ${expected}`);
        });
    });
});

describe('AppRenderer — controls that rule the other hypotheses out', () => {
    it('a constant formula is fine (this is the "2 + 3" case that worked)', () => {
        const def = defWith([stat('cmp_k', '2 + 3')]);
        const { queryByText, getByText } = render(<Harness definition={def} />);
        expect(queryByText(CRASHED)).toBeNull();
        expect(getByText('5')).toBeTruthy();
    });

    it('a BARE form read is fine — no arithmetic, no NaN (the case proved to work)', () => {
        const def = defWith([
            card('cmp_cf', [form('cmp_form', 'std', [numberField('cmp_a', 'a', 'A')])]),
            stat('cmp_bare', 'forms.std.a', 'A'),
        ]);
        const { queryByText } = render(<Harness definition={def} />);
        expect(queryByText(CRASHED)).toBeNull();
    });

    it('tabs/tab nesting alone is NOT the trigger', () => {
        const def = defWith([{
            id: 'cmp_tabs', type: 'tabs', visible: true, props: {}, style: { span: 12, gap: 3, padding: 0 },
            children: [
                {
                    id: 'cmp_t1', type: 'tab', visible: true, props: { label: 'One', icon: null }, style: { gap: 3, padding: 0 },
                    children: [
                        card('cmp_cf1', [form('cmp_form1', 'std', [numberField('cmp_a1', 'a', 'A')])]),
                        card('cmp_cs1', [stat('cmp_s1', 'forms.std.a', 'A')]),
                    ],
                },
                {
                    id: 'cmp_t2', type: 'tab', visible: true, props: { label: 'Two', icon: null }, style: { gap: 3, padding: 0 },
                    children: [stat('cmp_s2', '2 + 3', 'Const')],
                },
            ],
        }]);
        const { queryAllByText } = render(<Harness definition={def} />);
        expect(queryAllByText(CRASHED)).toHaveLength(0);
    });

    it('MANY stats reading the same forms root is NOT the trigger', () => {
        const stats = Array.from({ length: 14 }, (_, i) => stat(`cmp_many_${i}`, 'forms.std.a', `M${i}`));
        const def = defWith([
            card('cmp_cf', [form('cmp_form', 'std', [numberField('cmp_a', 'a', 'A')])]),
            card('cmp_cs', stats),
        ]);
        const { queryAllByText } = render(<Harness definition={def} />);
        expect(queryAllByText(CRASHED)).toHaveLength(0);
    });

    it('an input defaultValue authored as a binding object is NOT the trigger', () => {
        // register() seeds defaults through setValues(prev => hasOwn ? prev : …),
        // so a re-registration is a no-op and no loop can start here.
        const field = numberField('cmp_a', 'a', 'A');
        field.props.defaultValue = { kind: 'formula', expr: 'forms.std.b' };
        const def = defWith([
            card('cmp_cf', [form('cmp_form', 'std', [field, numberField('cmp_b', 'b', 'B')])]),
            card('cmp_cs', [stat('cmp_s', 'forms.std.a', 'A')]),
        ]);
        const { queryAllByText } = render(<Harness definition={def} />);
        expect(queryAllByText(CRASHED)).toHaveLength(0);
    });

    it('a formula that ERRORS is not the trigger either — it degrades to undefined', () => {
        const def = defWith([stat('cmp_bad', 'this is not an expression((')]);
        const { queryByText } = render(<Harness definition={def} />);
        expect(queryByText(CRASHED)).toBeNull();
    });
});
