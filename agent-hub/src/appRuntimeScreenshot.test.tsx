import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from './appRuntimeHeadless';
import { SCREENSHOT_ASSET_TOKEN, mergeRecord } from './appRuntimeScreenshot';

/**
 * Screenshot mode of the headless mount: the `screenshot` object the render service sends
 * for app_screenshot. What it pins: the plain mount (the compat DOM gate's) is untouched,
 * and with the object the screen gets its providers, the shell, a start state and assets,
 * while nothing goes over the wire.
 */

type Node = Record<string, unknown>;

function definitionWith(children: Node[], extra: Node = {}) {
    return {
        schemaVersion: 2,
        meta: { name: 'Shot app', icon: 'LayoutGrid' },
        homeScreenId: 'scr_one',
        theme: { primary: '#0F766E', appearance: 'light' },
        screens: [
            { id: 'scr_one', name: 'One', showInNav: true, sections: [{ id: 'sec_one', style: {}, children }] },
            { id: 'scr_two', name: 'Two', showInNav: true, sections: [{ id: 'sec_two', style: {}, children: [] }] },
        ],
        actions: {},
        ...extra,
    };
}

const DATASET_INPUT = { id: 'cmp_ds', type: 'input_dataset', props: { name: 'genome', label: 'Genome file', allowExisting: true }, style: { span: 12 } };
const FORM = {
    id: 'cmp_form', type: 'form', props: { name: 'order' }, style: { span: 12 },
    children: [{ id: 'cmp_qty', type: 'input_text', props: { name: 'customer', label: 'Customer' }, style: { span: 12 } }],
};
const TABS = {
    id: 'cmp_tabs', type: 'tabs', props: {}, style: { span: 12 },
    children: [
        { id: 'cmp_taba', type: 'tab', props: { label: 'First' }, children: [{ id: 'cmp_ha', type: 'heading', props: { text: 'Panel A' }, style: { span: 12 } }] },
        { id: 'cmp_tabb', type: 'tab', props: { label: 'Second' }, children: [{ id: 'cmp_hb', type: 'heading', props: { text: 'Panel B' }, style: { span: 12 } }] },
    ],
};
const MODAL = {
    id: 'cmp_modal', type: 'modal', props: { title: 'Details' }, style: { span: 12 },
    children: [{ id: 'cmp_mh', type: 'heading', props: { text: 'Inside the dialog' }, style: { span: 12 } }],
};
const USER = { id: 'u1', name: 'Ada Owner', email: 'ada@example.com', roleKey: 'owner' };

describe('appRuntimeHeadless screenshot mode', () => {
    let container: HTMLDivElement;
    let fetchSpy: ReturnType<typeof vi.fn>;
    let handles: Array<{ unmount: () => void }>;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        handles = [];
        fetchSpy = vi.fn(() => Promise.reject(new Error('network use is forbidden in headless render')));
        vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
        act(() => { for (const h of handles) h.unmount(); });
        vi.unstubAllGlobals();
        container.remove();
    });

    async function render(definition: Node, screenshot?: Node) {
        await act(async () => {
            handles.push(await mount(container, { definition: definition as never, screenId: 'scr_one', dataState: {}, currentUser: USER, previewRole: null, screenshot: screenshot as never }));
        });
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }

    it('without the screenshot object input_dataset still crashes (the compat gate mounts it that way)', async () => {
        await render(definitionWith([DATASET_INPUT]));
        expect(container.querySelector('[data-app-node-error="input_dataset"]')).toBeTruthy();
    });

    it('with it, input_dataset renders and nothing is fetched', async () => {
        await render(definitionWith([DATASET_INPUT]), {});
        expect(container.querySelector('[data-app-node-error]')).toBeNull();
        expect(container.querySelector('[data-node-id="cmp_ds"]')?.textContent).toContain('Genome file');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('chrome mounts the real shell: brand, navigation and the user menu', async () => {
        await render(definitionWith([]), { chrome: true });
        expect(container.querySelector('[data-app-brand="true"]')?.textContent).toContain('Shot app');
        expect(container.textContent).toContain('Two');
        expect(container.textContent).toContain('AO');
    });

    it('without chrome there is no shell', async () => {
        await render(definitionWith([]), {});
        expect(container.querySelector('[data-app-brand="true"]')).toBeNull();
    });

    it('an asset logo resolves to the in-process asset URL', async () => {
        await render(definitionWith([], { design: { logoUrl: 'asset:logo_1' } }), { chrome: true });
        const img = container.querySelector('[data-app-brand="true"] img');
        expect(img?.getAttribute('src')?.endsWith(`/api/public-app/${SCREENSHOT_ASSET_TOKEN}/assets/logo_1`)).toBe(true);
    });

    it('initialUi starts a modal open, a tab group on its second tab and a form with values', async () => {
        await render(definitionWith([TABS, FORM, MODAL]), {
            initialUi: { cmp_tabs: { activeTab: 'cmp_tabb' }, cmp_form: { values: { customer: 'Globex' } }, cmp_modal: { open: true } },
        });
        const shownPanels = Array.from(container.querySelectorAll('[data-node-id="cmp_tabs"] [role="tabpanel"]')).filter((el) => !(el as HTMLElement).hidden);
        expect(shownPanels.map((el) => el.textContent)).toEqual(['Panel B']);
        expect((container.querySelector('[data-node-id="cmp_qty"] input') as HTMLInputElement | null)?.value).toBe('Globex');
        expect(document.body.textContent).toContain('Inside the dialog');
    });

    it('without initialUi the same screen starts closed, on the first tab, with empty fields', async () => {
        await render(definitionWith([TABS, FORM, MODAL]), {});
        const shownPanels = Array.from(container.querySelectorAll('[data-node-id="cmp_tabs"] [role="tabpanel"]')).filter((el) => !(el as HTMLElement).hidden);
        expect(shownPanels.map((el) => el.textContent)).toEqual(['Panel A']);
        expect(document.body.textContent).not.toContain('Inside the dialog');
        expect((container.querySelector('[data-node-id="cmp_qty"] input') as HTMLInputElement | null)?.value).toBe('');
    });

    it('vars, forms and screen params reach formulas', async () => {
        const text = { id: 'cmp_t', type: 'stat', props: { label: 'Mix', value: { kind: 'formula', expr: 'vars.status + "/" + forms.order.customer + "/" + screen.params.id' } }, style: { span: 3 } };
        await render(definitionWith([text], { variables: [{ name: 'status', type: 'text', default: 'open' }] }), {
            vars: { status: 'done' }, forms: { order: { customer: 'Acme' } }, screenParams: { id: 'r7' },
        });
        expect(container.querySelector('[data-node-id="cmp_t"]')?.textContent).toContain('done/Acme/r7');
    });

    it('mergeRecord only lays a plain object over the base', () => {
        const base = { a: 1 };
        expect(mergeRecord(base, null)).toBe(base);
        expect(mergeRecord(base, [1])).toBe(base);
        expect(mergeRecord(base, { b: 2 })).toEqual({ a: 1, b: 2 });
    });
});
