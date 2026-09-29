import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render } from '@testing-library/react';
import { createRequire } from 'node:module';
import { describe, it, expect, vi } from 'vitest';
import './index'; // side effect: registers every bespoke panel
import SpecPanel from './SpecPanel';
import REGISTRY, { getInspectorForType } from '../registry';
import { findNode } from '../../state/definitionOps';

// The generic panel renders from the SERVER catalog — feed it the real thing.
const require = createRequire(import.meta.url);
const { buildCatalog, COMPONENT_SPECS } = require('../../../../../../../../server/appStudio/componentSpecs.js');
const CATALOG = JSON.parse(JSON.stringify(buildCatalog()));

vi.mock('../../studioAppsApi', () => ({
    studioAppsApi: { getCatalog: vi.fn(async () => { throw new Error('network down'); }) },
}));

function specDefaultProps(spec) {
    const out = {};
    for (const [key, fs] of Object.entries(spec.props || {})) {
        out[key] = fs.default === undefined ? null : JSON.parse(JSON.stringify(fs.default ?? null));
    }
    return out;
}

function defWith(node) {
    return {
        schemaVersion: 2,
        meta: { name: 'T', description: '', icon: 'LayoutGrid' },
        theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        homeScreenId: 'scr_t',
        screens: [{ id: 'scr_t', name: 'T', icon: null, showInNav: true, maxWidth: 'medium', sections: [{ id: 'sec_t', style: {}, children: [node] }] }],
        actions: {},
    };
}

function nodeFor(type) {
    const node = { id: 'cmp_specx', type, visible: true, props: specDefaultProps(COMPONENT_SPECS[type]), style: {} };
    if (COMPONENT_SPECS[type].container) node.children = [];
    return node;
}

/** Render SpecPanel with the catalog pre-seeded in the react-query cache. */
function renderSpecPanel(node, { seedCatalog = true } = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    if (seedCatalog) client.setQueryData(['studio-apps', 'catalog'], CATALOG);
    const onCommit = vi.fn();
    const definition = defWith(node);
    const utils = render(
        <QueryClientProvider client={client}>
            <SpecPanel node={node} definition={definition} onCommit={onCommit} disabled={false} />
        </QueryClientProvider>,
    );
    const committedProps = () => findNode(onCommit.mock.calls.at(-1)[0], node.id).node.props;
    return { onCommit, committedProps, definition, ...utils };
}

describe('registry fallback', () => {
    it('falls back to SpecPanel for every catalog type without a bespoke panel (prop-less types get none)', () => {
        for (const [type, spec] of Object.entries(COMPONENT_SPECS)) {
            const panel = getInspectorForType(type);
            if (REGISTRY[type]) {
                expect(panel, type).toBe(REGISTRY[type]);
            } else if (Object.keys(spec.props).length === 0) {
                expect(panel, `${type} has no props — no Content panel`).toBeNull();
            } else {
                expect(panel, `${type} should fall back to SpecPanel`).toBe(SpecPanel);
            }
        }
        // divider gained `orientation`, so the prop-less exception no longer
        // applies — the catalog-driven fallback renders its one enum for free.
        expect(getInspectorForType('divider')).toBe(SpecPanel);
        // container gained `look` in the look pass and registers a bespoke
        // panel — the bespoke registration wins over the SpecPanel fallback.
        expect(getInspectorForType('container')).toBe(REGISTRY.container);
        expect(getInspectorForType('nope_unknown')).toBeNull();
    });
});

describe('SpecPanel — renders a Content panel for every fallback type', () => {
    const fallbackTypes = Object.keys(COMPONENT_SPECS)
        .filter((t) => !REGISTRY[t] && Object.keys(COMPONENT_SPECS[t].props).length > 0);

    it('covers the expected v2.1 fallback set', () => {
        // `pane` deliberately has no bespoke inspector: direction + scroll are
        // two enums the catalog-driven SpecPanel renders for free.
        // Neither `pane` nor `message_thread` gets a bespoke inspector: their
        // props are enums, strings and one list, all of which the catalog-driven
        // SpecPanel renders for free.
        // file_preview joins them: a binding, a string and a boolean — the
        // three controls SpecPanel already renders, so a bespoke panel would
        // be pure cost.
        // The v3 trio is the same story: stepper's one list, file_gallery's
        // keys and column count, and connector_status's id + boolean are all
        // controls the catalog already knows how to draw.
        // input_dataset and browser_view join for the same reason: strings,
        // booleans and one enum only — the picker/upload/live-frame UX all lives
        // in the runtime component, not here.
        // divider joined when it gained `orientation` — a single enum is
        // exactly what the generic panel exists for.
        expect(fallbackTypes.sort()).toEqual(['approval_list', 'badge_list', 'browser_view', 'calendar', 'connector_status', 'divider', 'file_gallery', 'file_preview', 'input_dataset', 'markdown', 'message_thread', 'page_header', 'pane', 'progress', 'stepper', 'timeline']);
    });

    for (const type of fallbackTypes) {
        it(`${type}: renders at least one control per prop spec`, () => {
            const { container } = renderSpecPanel(nodeFor(type));
            expect(container.querySelector(`[data-spec-panel="${type}"]`)).toBeTruthy();
            expect(container.querySelector('input, select, textarea, button')).toBeTruthy();
        });
    }
});

describe('SpecPanel — emits usePatch updates with spec-correct shapes', () => {
    it('string prop (page_header.title)', () => {
        const { getByPlaceholderText, committedProps } = renderSpecPanel(nodeFor('page_header'));
        fireEvent.change(getByPlaceholderText('Page title'), { target: { value: 'Projects' } });
        expect(committedProps().title).toBe('Projects');
    });

    it('boolean prop (page_header.showDivider) toggles', () => {
        const { getByText, committedProps } = renderSpecPanel(nodeFor('page_header'));
        fireEvent.click(getByText('Show divider'));
        expect(committedProps().showDivider).toBe(false);
    });

    it('markdown prop (markdown.content) commits the raw string', () => {
        const { container, committedProps } = renderSpecPanel(nodeFor('markdown'));
        fireEvent.change(container.querySelector('textarea'), { target: { value: '# New' } });
        expect(committedProps().content).toBe('# New');
    });

    // progress.max used to be the `number` example here; it is a BINDING now
    // (a capacity bar's ceiling is data, not a literal), so the plain-number
    // case needs a prop that is still one.
    it('number prop (chart.series bar width / table.rowLimit) commits a number', () => {
        const { container, committedProps } = renderSpecPanel(nodeFor('table'));
        const num = container.querySelector('input[type="number"]');
        fireEvent.change(num, { target: { value: '50' } });
        expect(committedProps().rowLimit).toBe(50);
    });

    it('int prop (timeline.rowLimit) clamps to the spec range', () => {
        const { container, committedProps } = renderSpecPanel(nodeFor('timeline'));
        const num = container.querySelector('input[type="number"]');
        fireEvent.change(num, { target: { value: '500' } });
        expect(committedProps().rowLimit).toBe(100);
    });

    it('enum prop (calendar.view) commits a legal value via select', () => {
        const { getByLabelText, committedProps } = renderSpecPanel(nodeFor('calendar'));
        fireEvent.change(getByLabelText('View'), { target: { value: 'list' } });
        expect(committedProps().view).toBe('list');
    });

    // The look pass: the fallback types' `look` enums need no bespoke panel —
    // the catalog-driven select must list every value, in spec order (the
    // first is the identity default), and commit a non-default one.
    it.each([['page_header'], ['progress'], ['badge_list']])('%s: look select lists the catalog values and commits one', (type) => {
        const spec = COMPONENT_SPECS[type].props.look;
        const { getByLabelText, committedProps } = renderSpecPanel(nodeFor(type));
        const select = getByLabelText('Look');
        expect(Array.from(select.options).map((o) => o.value)).toEqual(spec.values);
        expect(select).toHaveValue(spec.default); // = spec.values[0], the identity
        fireEvent.change(select, { target: { value: spec.values[1] } });
        expect(committedProps().look).toBe(spec.values[1]);
    });

    it('list prop (badge_list.colorMap) adds an itemShape-complete row', () => {
        const { getByText, committedProps } = renderSpecPanel(nodeFor('badge_list'));
        fireEvent.click(getByText(/Add color map/));
        // `label` joined the itemShape so a pill grouped by a status column can
        // read "Waiting on customer" instead of the stored "awaiting_user".
        expect(committedProps().colorMap).toEqual([{ value: '', label: '', color: 'neutral' }]);
    });

    it('binding prop renders a BindingField (badge_list.source)', () => {
        const { getByText } = renderSpecPanel(nodeFor('badge_list'));
        expect(getByText('Type the values myself')).toBeTruthy(); // BindingField chooser (nothing set yet)
    });

    it('falls back to inferred specs when the catalog is unavailable', () => {
        const { getByText, committedProps } = renderSpecPanel(nodeFor('page_header'), { seedCatalog: false });
        // boolean inferred from the registry defaultProps → Toggle still works
        fireEvent.click(getByText('Show divider'));
        expect(committedProps().showDivider).toBe(false);
    });
});
