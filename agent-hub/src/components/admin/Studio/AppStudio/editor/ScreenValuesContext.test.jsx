import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useCallback, useState } from 'react';
import { describe, it, expect } from 'vitest';
import { ScreenValuesContext, useScreenValues, useScreenValuesStore } from './ScreenValuesContext';
import { formNameOf } from '../inspector/ActionsSection';
import AppRenderer from '../runtime/AppRenderer';
import { mergeFormValues } from '../runtime/formValues';

/**
 * The bridge between "what is in the form on the canvas" and "what the test button in the inspector sends along".
 *
 * Two things can silently break here, and both look on screen like an automation that does nothing:
 *
 *   1. the store itself confuses "this form is not there" with "it is there and is empty" — then the test
 *      button invents empty values instead of reporting that there was nothing;
 *   2. the KEY drifts out of step. AppForm publishes under `props.name || node.id`; if the inspector reads
 *      under a different name, it finds an empty object for a form that publishes perfectly well, and sends
 *      nothing along without anyone noticing.
 */

// ── 1. de store ────────────────────────────────────────────────────────────

function makeStore() {
    return renderHook(() => useScreenValuesStore()).result.current;
}

describe('useScreenValuesStore', () => {
    it('geeft terug wat er gepubliceerd is, per formuliernaam', () => {
        const store = makeStore();
        act(() => store.publish('claim', { title: 'Hallo' }));
        expect(store.readForm('claim')).toEqual({ title: 'Hallo' });
        expect(store.read()).toEqual({ claim: { title: 'Hallo' } });
    });

    it('houdt "staat er niet" en "staat er en is leeg" uit elkaar', () => {
        // This difference is the whole reason readForm can return null: the test button reports the two
        // differently, and without the difference it would invent empty values for a form that is not on screen.
        const store = makeStore();
        expect(store.readForm('claim')).toBeNull();
        act(() => store.publish('claim', {}));
        expect(store.readForm('claim')).toEqual({});
    });

    it('is stabiel — publiceren rendert niets opnieuw', () => {
        // Een gedeelde state-waarde hierboven zou bij elke toetsaanslag de hele
        // editor opnieuw laten renderen. Vandaar een ref.
        const renders = [];
        const { result } = renderHook(() => {
            const store = useScreenValuesStore();
            renders.push(store);
            return store;
        });
        const before = renders.length;
        act(() => result.current.publish('claim', { title: 'x' }));
        expect(renders.length).toBe(before);
        expect(result.current.readForm('claim')).toEqual({ title: 'x' });
    });

    it('een lege naam levert niets, en verandert niets', () => {
        const store = makeStore();
        act(() => store.publish('', { title: 'x' }));
        expect(store.read()).toEqual({});
        expect(store.readForm('')).toBeNull();
        expect(store.readForm(null)).toBeNull();
    });

    it('buiten een provider is er geen store — en dat is null, geen leeg antwoord', () => {
        // The run page has no inspector. An empty store would claim there "the form is empty"; null lets the
        // caller say that it does not know.
        expect(renderHook(() => useScreenValues()).result.current).toBeNull();
    });

    it('levert door de provider heen dezelfde store', () => {
        const store = makeStore();
        const wrapper = ({ children }) => (
            <ScreenValuesContext.Provider value={store}>{children}</ScreenValuesContext.Provider>
        );
        const { result } = renderHook(() => useScreenValues(), { wrapper });
        expect(result.current).toBe(store);
        act(() => result.current.publish('claim', { a: 1 }));
        expect(store.readForm('claim')).toEqual({ a: 1 });
    });
});

// ── 2. de sleutel, in de pas met AppForm ───────────────────────────────────

const textField = (id, name, label) => ({
    id, type: 'input_text', visible: true,
    props: { name, label, required: false, defaultValue: 'seed' },
    style: { span: 6 },
});

function defWithForm(formNode) {
    return {
        schemaVersion: 2,
        meta: { name: 'Claim', description: '', icon: 'LayoutGrid' },
        theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        homeScreenId: 'scr_c',
        screens: [{
            id: 'scr_c', name: 'Claim', icon: null, showInNav: true, maxWidth: 'medium',
            sections: [{ id: 'sec_c', style: { padding: 4, gap: 3, background: 'none' }, children: [formNode] }],
        }],
        actions: {},
    };
}

const formNode = (id, name) => ({
    id, type: 'form', visible: true,
    props: { ...(name ? { name } : {}), submitLabel: 'Submit', showReset: false, showSubmit: false },
    style: { span: 12, gap: 3 },
    children: [textField('cmp_ttl001', 'title', 'Title')],
});

/** Renders the real form and reports every key AppForm publishes under. */
function Harness({ definition, onKeys, onValues = () => {} }) {
    const [forms, setForms] = useState({});
    const registerFormValue = useCallback((name, values) => {
        onKeys(name);
        onValues({ name, values });
        setForms((prev) => mergeFormValues(prev, name, values));
    }, [onKeys, onValues]);
    return (
        <AppRenderer
            definition={definition}
            screenId="scr_c"
            mode="run"
            forms={forms}
            registerFormValue={registerFormValue}
        />
    );
}

describe('formNameOf leest onder dezelfde sleutel waaronder AppForm publiceert', () => {
    for (const [what, node] of [
        ['een formulier met een naam', formNode('cmp_form01', 'claim')],
        ['een formulier zonder naam (dan is het zijn eigen id)', formNode('cmp_form01', null)],
    ]) {
        it(what, () => {
            const definition = defWithForm(node);
            const published = [];
            render(<Harness definition={definition} onKeys={(k) => published.push(k)} />);
            expect(published.length).toBeGreaterThan(0);
            expect(new Set(published).size).toBe(1);
            expect(formNameOf(definition, node)).toBe(published[0]);
        });
    }

    it('en de waarde die daar staat is wat er getypt is', async () => {
        const user = userEvent.setup();
        // The whole point: not the default value from the definition, but what is on the screen at that moment.
        const node = formNode('cmp_form01', 'claim');
        const definition = defWithForm(node);
        const published = [];
        render(<Harness definition={definition} onKeys={() => {}} onValues={(v) => published.push(v)} />);
        const key = formNameOf(definition, node);
        expect(published.at(-1)).toEqual({ name: key, values: { title: 'seed' } });
        await user.clear(screen.getByLabelText('Title'));
        await user.type(screen.getByLabelText('Title'), 'Typed just now');
        expect(published.at(-1)).toEqual({ name: key, values: { title: 'Typed just now' } });
    });
});
