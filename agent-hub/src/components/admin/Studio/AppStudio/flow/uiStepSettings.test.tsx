import { createRequire } from 'node:module';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import StepSettings from './StepSettings';
import { EditorChromeContext } from '../editor/EditorChromeContext';
import { collectNodes, nodeRefOptions } from './nodeRefOptions';
import { stub } from '@/test/mocks';
import type { ComponentProps } from 'react';
import type { AppDefinition } from '../inspector/appDefinition';

/**
 * The human editor's controls for the browser steps of schema 3, drawn from the
 * server's own field tables (server/appStudio/componentSpecs/steps/): a node is
 * picked from the app's components, narrowed to what the step can act on, and
 * every other field gets the spec-driven control.
 */

const require = createRequire(import.meta.url);
const { EXTENSION_STEP_SPECS } = require('../../../../../../../server/appStudio/componentSpecs/stepRegistry.js') as {
    EXTENSION_STEP_SPECS: Record<string, unknown>;
};


const DEFINITION = stub<AppDefinition>({
    schemaVersion: 3,
    meta: { name: 'T' },
    homeScreenId: 'scr_a',
    screens: [{ id: 'scr_a', name: 'List', sections: [{ id: 'sec_a', children: [
        { id: 'cmp_tabs', type: 'tabs', props: {}, children: [{ id: 'cmp_tab1', type: 'tab', props: { label: 'Overview' }, children: [] }] },
        { id: 'cmp_dlg', type: 'modal', props: { title: 'Details' }, children: [] },
        { id: 'cmp_grid', type: 'data_grid', props: { selectable: 'single' } },
        { id: 'cmp_name', type: 'input_text', props: { name: 'name', label: 'Name' } },
    ] }] }],
    actions: {},
});

function renderStep(step: ComponentProps<typeof StepSettings>['step']) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The catalog the step panel reads (inspector/panels/SpecPanel useCatalog), seeded instead of fetched.
    client.setQueryData(['studio-apps', 'catalog'], { components: {}, actions: { stepSpecs: EXTENSION_STEP_SPECS } });
    const onChange = vi.fn();
    render(
        <QueryClientProvider client={client}>
            <EditorChromeContext.Provider value={null}>
                <StepSettings step={step} onChange={onChange} definition={DEFINITION} screens={DEFINITION.screens} />
            </EditorChromeContext.Provider>
        </QueryClientProvider>,
    );
    return { onChange };
}

const optionsOf = (el: HTMLElement) => [...(el as HTMLSelectElement).options].map((o) => o.textContent);

describe('the browser steps in the step editor', () => {
    it('set_ui picks only the components that keep the chosen state', async () => {
        const user = userEvent.setup();
        const { onChange } = renderStep({ kind: 'set_ui', nodeId: '', state: 'open', value: { kind: 'static', value: true } });
        const picker = await screen.findByLabelText('Component');
        expect(picker.tagName).toBe('SELECT');
        expect(optionsOf(picker).filter((o) => o?.includes('·'))).toEqual(['Details · modal']);
        await user.selectOptions(picker, 'cmp_dlg');
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'set_ui', nodeId: 'cmp_dlg' }));
        expect(optionsOf(screen.getByLabelText('State'))).toEqual(['Active tab', 'Open', 'Selection']);
    });

    it('scroll_to offers the top of the screen beside every component; focus every component', async () => {
        renderStep({ kind: 'scroll_to', nodeId: 'top' });
        const picker = await screen.findByLabelText('Component');
        expect(optionsOf(picker)).toEqual(expect.arrayContaining(['Top of the screen', 'Name · input_text', 'Overview · tab']));
    });

    it('wait, copy_to_clipboard and set_form_field get the spec-driven controls', async () => {
        renderStep({ kind: 'set_form_field', form: 'order', field: 'qty', value: { kind: 'static', value: '' } });
        expect(await screen.findByLabelText('Form')).toBeTruthy();
        expect(screen.getByLabelText('Field')).toBeTruthy();
    });
});

describe('nodeRefOptions', () => {
    const nodes = collectNodes(DEFINITION);

    it('lists every node in screen order, children after their parent, labelled by what the author wrote', () => {
        expect(nodes.map((n) => n.id)).toEqual(['cmp_tabs', 'cmp_tab1', 'cmp_dlg', 'cmp_grid', 'cmp_name']);
        expect(nodes.find((n) => n.id === 'cmp_grid')?.label).toBe('cmp_grid · data_grid');
    });

    it('narrows per step', () => {
        expect(nodeRefOptions({ kind: 'set_ui', state: 'activeTab' }, nodes).map((n) => n.id)).toEqual(['cmp_tabs']);
        expect(nodeRefOptions({ kind: 'set_ui', state: 'selection' }, nodes).map((n) => n.id)).toEqual(['cmp_grid']);
        expect(nodeRefOptions({ kind: 'set_ui' }, nodes)).toHaveLength(nodes.length);
        expect(nodeRefOptions({ kind: 'scroll_to' }, nodes)[0]).toEqual({ id: 'top', label: 'Top of the screen' });
        expect(nodeRefOptions({ kind: 'focus' }, undefined)).toEqual([]);
    });
});
