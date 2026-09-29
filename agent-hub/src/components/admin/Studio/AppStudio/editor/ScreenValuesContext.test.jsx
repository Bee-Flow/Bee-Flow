import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { describe, it, expect } from 'vitest';
import { ScreenValuesContext, useScreenValues, useScreenValuesStore } from './ScreenValuesContext';
import { formNameOf } from '../inspector/ActionsSection';
import AppRenderer from '../runtime/AppRenderer';
import { mergeFormValues } from '../runtime/formValues';

/**
 * De brug tussen "wat staat er in het formulier op de canvas" en "wat stuurt de
 * testknop in de inspector mee".
 *
 * Twee dingen kunnen hier stilletjes stukgaan, en allebei zien er op het scherm
 * uit als een routine die niets doet:
 *
 *   1. de store zelf verwart "dit formulier staat er niet" met "het staat er en
 *      is leeg" — dan verzint de testknop lege waarden in plaats van te melden
 *      dat er niets was;
 *   2. de SLEUTEL loopt uit de pas. AppForm publiceert onder
 *      `props.name || node.id`; leest de inspector onder een andere naam, dan
 *      vindt hij een leeg object bij een formulier dat prima publiceert, en
 *      stuurt hij niets mee zonder dat iemand het merkt.
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
        // Dit verschil is de hele reden dat readForm null kan teruggeven: de
        // testknop meldt de twee anders, en zonder het verschil zou hij bij een
        // formulier dat niet op het scherm staat lege waarden verzinnen.
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
        // De run-pagina heeft geen inspector. Een lege store zou daar "het
        // formulier is leeg" beweren; null laat de aanroeper zeggen dat hij het
        // niet weet.
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

    it('en de waarde die daar staat is wat er getypt is', () => {
        // Het hele punt: niet de standaardwaarde uit de definitie, maar wat er
        // op dat moment op het scherm staat.
        const node = formNode('cmp_form01', 'claim');
        const definition = defWithForm(node);
        const published = [];
        render(<Harness definition={definition} onKeys={() => {}} onValues={(v) => published.push(v)} />);
        const key = formNameOf(definition, node);
        expect(published.at(-1)).toEqual({ name: key, values: { title: 'seed' } });
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Typed just now' } });
        expect(published.at(-1)).toEqual({ name: key, values: { title: 'Typed just now' } });
    });
});
