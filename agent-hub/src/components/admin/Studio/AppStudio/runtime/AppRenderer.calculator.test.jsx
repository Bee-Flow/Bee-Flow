import { createRequire } from 'node:module';
import { act, fireEvent, render } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

/**
 * ACCEPTANCE, BROWSER SIDE — the calculator really mounts and really adds up.
 *
 * The definition under test is not written here: it is
 * server/appStudio/fixtures/calculatorApp.json, the app that
 * appStudio/fixtures/calculatorApp.test.js builds through the real builder
 * tools and pins. Both runtimes execute the SAME bytes, so "the server says
 * it's valid" and "the browser can run it" cannot drift apart.
 *
 * WHY THIS IS THE TEST THAT MATTERS. A user asked the builder AI for an
 * advanced calculator; it produced a screen where every formula tile read
 * "This component failed", concluded that live form binding was an
 * architectural limit, and rebuilt the app around a Calculate button. This
 * file is the counter-evidence, in the actual React runtime:
 *   • the keypad screen mounts with no failed nodes,
 *   • pressing digit buttons moves the display,
 *   • the four operators, equals and the scientific keys give real answers,
 *   • and the finance screen's tiles track a form AS IT IS TYPED INTO, with no
 *     submit button anywhere on the screen.
 *
 * The harness is AppRunPage's RunSurface with the data layer removed (the app
 * has no tables): useActionRunner above, AppRenderer below, mergeFormValues in
 * between — the same three pieces, wired the same way.
 */

// useActionRunner reaches for these at module scope. The calculator is a pure
// CLIENT sequence (set_variable/switch only), so nothing here is ever called —
// an assertion at the bottom proves it.
vi.mock('../../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../../../shared/Toast', () => {
    const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    return { default: toast, toast };
});

import AppRenderer from './AppRenderer';
import { mergeFormValues } from './formValues';
import { EM_DASH } from './uiBits';
import useActionRunner from './useActionRunner';
import { authFetch } from '../../../../../utils/helpers';

const nodeRequire = createRequire(import.meta.url);
const DEFINITION = nodeRequire('../../../../../../../server/appStudio/fixtures/calculatorApp.json');

const CRASHED = 'This component failed';
const CALC_SCREEN = DEFINITION.screens.find((s) => s.name === 'Calculator');
const FINANCE_SCREEN = DEFINITION.screens.find((s) => s.name === 'Finance');

/** Every node of a type on a screen, in document order. */
function collect(screen, type) {
    const out = [];
    (function walk(nodes) {
        for (const n of nodes || []) {
            if (n.type === type) out.push(n);
            walk(n.children);
        }
    }(screen.sections.flatMap((s) => s.children)));
    return out;
}

const DISPLAY_ID = collect(CALC_SCREEN, 'stat').find((s) => s.props.label === 'Display').id;
const KEY_LABELS = collect(CALC_SCREEN, 'button').map((b) => b.props.label);

/** AppRunPage's RunSurface, minus AppDataScope (this app reads no tables). */
function Harness({ screenId }) {
    const [forms, setForms] = useState({});
    const registerFormValue = useCallback((formName, values) => {
        setForms((prev) => mergeFormValues(prev, formName, values));
    }, []);
    const { actionState, runAction, vars, setVar } = useActionRunner('app-calc', DEFINITION, {
        forms,
        screen: { id: screenId, params: {} },
    });
    return (
        <AppRenderer
            definition={DEFINITION}
            screenId={screenId}
            mode="run"
            actionState={actionState}
            runAction={runAction}
            vars={vars}
            setVar={setVar}
            forms={forms}
            registerFormValue={registerFormValue}
        />
    );
}

function mountCalculator() {
    const view = render(<Harness screenId={CALC_SCREEN.id} />);
    const display = () => view.container
        .querySelector(`[data-node-id="${DISPLAY_ID}"] .app-stat div.font-semibold`)
        ?.textContent;
    const press = async (...labels) => {
        for (const label of labels) {
            // Sequential on purpose: a keypad is pressed one key at a time, and
            // each key's sequence must settle before the next one reads vars.
            await act(async () => { fireEvent.click(view.getByRole('button', { name: label })); });
        }
        return display();
    };
    return { ...view, display, press };
}

describe('the calculator fixture — the keypad screen', () => {
    it('mounts with every key on screen and not one failed node', () => {
        const { queryAllByText, getByRole } = mountCalculator();
        expect(queryAllByText(CRASHED)).toHaveLength(0);
        expect(KEY_LABELS).toHaveLength(22);
        for (const label of KEY_LABELS) expect(getByRole('button', { name: label })).toBeTruthy();
    });

    it('the display starts at 0 — the variable default, painted', () => {
        const { display } = mountCalculator();
        expect(display()).toBe('0');
    });

    it('pressing a digit moves the display', async () => {
        const { press } = mountCalculator();
        expect(await press('7')).toBe('7');
        expect(await press('8')).toBe('78');
        expect(await press('⌫')).toBe('7');
        expect(await press('C')).toBe('0');
    });

    it('7 + 5 = 12, clicked through the real buttons', async () => {
        const { press, queryAllByText } = mountCalculator();
        expect(await press('7', '+', '5', '=')).toBe('12');
        expect(queryAllByText(CRASHED)).toHaveLength(0);
    });

    it('all four operators, and a chain that evaluates as it goes', async () => {
        const a = mountCalculator();
        expect(await a.press('9', '−', '4', '=')).toBe('5');
        expect(await a.press('C', '6', '×', '7', '=')).toBe('42');
        expect(await a.press('C', '8', '÷', '2', '=')).toBe('4');
        expect(await a.press('C', '2', '+', '3', '+', '4', '=')).toBe('9');
    });

    it('the decimal point, and a divide by zero that says so', async () => {
        const a = mountCalculator();
        expect(await a.press('3', '.', '1', '4')).toBe('3.14');
        expect(await a.press('C', '9', '÷', '0', '=')).toBe('Cannot divide by 0');
        expect(await a.press('C', '4', '+', '1', '=')).toBe('5');
    });

    it('THE SCIENTIFIC KEYS: √ x² ln sin — the maths that did not exist before', async () => {
        const a = mountCalculator();
        expect(await a.press('2', '√')).toBe('1.41421356');
        expect(await a.press('C', '7', 'x²')).toBe('49');
        expect(await a.press('C', '1', '0', 'ln')).toBe('2.30258509');
        expect(await a.press('C', '3', '0', 'sin')).toBe('0.5');
        // A scientific result is an ordinary operand afterwards.
        expect(await a.press('C', '4', '√', '+', '1', '=')).toBe('3');
    });

    it('a domain error paints "Error" — never NaN, never a failed tile', async () => {
        const { press, queryAllByText } = mountCalculator();
        expect(await press('5', '⌫', 'ln')).toBe('Error');
        expect(queryAllByText(CRASHED)).toHaveLength(0);
        expect(await press('C', '2', '+', '2', '=')).toBe('4');
    });

    it('nothing on this screen touches the network — it is all client state', async () => {
        authFetch.mockClear();
        const { press } = mountCalculator();
        await press('7', '+', '5', '=', '√');
        expect(authFetch).not.toHaveBeenCalled();
    });
});

/**
 * THE DIRECT REBUTTAL. "A stat cannot follow a form's value" was the claim that
 * sent the original build off a cliff. Here four tiles do exactly that, with
 * pow() and ^ inside them, and there is no submit button to press.
 */
describe('the calculator fixture — the finance screen binds live to a form', () => {
    const FINANCE_LABELS = ['Monthly payment', 'Total repaid', 'Total interest', 'Future value'];
    const statValue = (container, label) => {
        const node = collect(FINANCE_SCREEN, 'stat').find((s) => s.props.label === label);
        return container.querySelector(`[data-node-id="${node.id}"] .app-stat div.font-semibold`)?.textContent;
    };

    it('mounts with no failed tiles and no submit button', () => {
        const { queryAllByText, container } = render(<Harness screenId={FINANCE_SCREEN.id} />);
        expect(queryAllByText(CRASHED)).toHaveLength(0);
        expect(container.querySelectorAll('button')).toHaveLength(0);
    });

    it('the field defaults alone already produce the right numbers', () => {
        // The inputs carry defaultValue, so the form publishes real values one
        // frame after mount — this is the exact window the old crash lived in.
        const { container, queryAllByText } = render(<Harness screenId={FINANCE_SCREEN.id} />);
        expect(queryAllByText(CRASHED)).toHaveLength(0);
        expect(statValue(container, 'Monthly payment')).toBe((1266.71).toLocaleString());
        expect(statValue(container, 'Total repaid')).toBe((456015.6).toLocaleString());
        expect(statValue(container, 'Total interest')).toBe((206015.6).toLocaleString());
        expect(statValue(container, 'Future value')).toBe((16470.09).toLocaleString());
    });

    it('editing the form moves the tiles, with no Calculate button in sight', () => {
        const { container, getAllByLabelText, getByLabelText, queryAllByText } = render(<Harness screenId={FINANCE_SCREEN.id} />);

        // A 100,000 loan at 6% over 20 years: hand-computed below. Both cards
        // have an "Annual interest %" field; [0] is the loan's.
        fireEvent.change(getByLabelText('Loan amount'), { target: { value: '100000' } });
        fireEvent.change(getByLabelText('Term (years)'), { target: { value: '20' } });
        fireEvent.change(getAllByLabelText('Annual interest %')[0], { target: { value: '6' } });

        const r = 0.06 / 12;
        const n = 20 * 12;
        const expected = Math.round((100000 * r / (1 - (1 + r) ** -n)) * 100) / 100;
        expect(expected).toBe(716.43);

        expect(queryAllByText(CRASHED)).toHaveLength(0);
        expect(statValue(container, 'Monthly payment')).toBe(expected.toLocaleString());
    });

    it('emptying the amount gives 0, not NaN — an empty field behaves as zero', () => {
        const { container, getByLabelText, queryAllByText } = render(<Harness screenId={FINANCE_SCREEN.id} />);
        fireEvent.change(getByLabelText('Loan amount'), { target: { value: '' } });
        expect(statValue(container, 'Monthly payment')).toBe('0');
        expect(statValue(container, 'Total repaid')).toBe('0');
        expect(queryAllByText(CRASHED)).toHaveLength(0);
        // The savings card reads a different form, so it is untouched.
        expect(statValue(container, 'Future value')).toBe((16470.09).toLocaleString());
    });

    it('emptying the term blanks the tile instead of painting Infinity', () => {
        // The degenerate case: n = 0 makes the annuity denominator
        // 1 - pow(1+r, 0) = 0, so the division is Infinity. round() collapses
        // that to null and the stat paints an em-dash — no "Infinity" on
        // screen and no failed node.
        const { container, getByLabelText, queryAllByText } = render(<Harness screenId={FINANCE_SCREEN.id} />);
        fireEvent.change(getByLabelText('Term (years)'), { target: { value: '' } });
        expect(statValue(container, 'Monthly payment')).toBe(EM_DASH);
        expect(queryAllByText(CRASHED)).toHaveLength(0);
    });
});
