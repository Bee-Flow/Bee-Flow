import { createRequire } from 'node:module';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import './index'; // side effect: registers every bespoke panel
import MoreOptions from './MoreOptions';
import { planMoreOptions, nestedPath } from './moreOptionsPlan';
import REGISTRY, { getPanelCoverage } from '../registry';
import type { PanelCoverage } from '../registry';
import type { PropSpec, ListItem } from './specProps';
import type { AppDefinition, AppNode } from '../appDefinition';

/**
 * Every bespoke Content panel names the props it edits itself (registerInspector's
 * coverage); "More options" draws the rest from the catalog spec. Together they
 * must be the spec, exactly, for every type with a bespoke panel, down to the
 * item keys of every list the panel edits. A prop the spec gains later (another
 * package's since-3 prop or item key) lands in "More options" by itself.
 */

const require = createRequire(import.meta.url);
const { buildCatalog } = require('../../../../../../../../server/appStudio/componentSpecs.js');
const CATALOG = JSON.parse(JSON.stringify(buildCatalog()));
const SPECS: Record<string, { props: Record<string, PropSpec>; container?: boolean }> = CATALOG.components;


const TYPES = Object.keys(REGISTRY).sort();

/** A value for one key that the validator would accept, so every row has something in it. */
function sample(fs: PropSpec): unknown {
    if (fs.type === 'enum') return fs.default ?? fs.values?.[0];
    if (fs.type === 'boolean') return true;
    if (fs.type === 'int' || fs.type === 'number') return fs.default ?? fs.min ?? 1;
    if (fs.type === 'list') return [];
    return 'x';
}

/** One item with every key set, a nested list holding one row of its own. */
function sampleItem(shape: Record<string, PropSpec>): ListItem {
    const item: ListItem = {};
    for (const [k, fs] of Object.entries(shape)) {
        item[k] = fs.type === 'list' && fs.itemShape ? [sampleItem(fs.itemShape)] : sample(fs);
    }
    return item;
}

function nodeFor(type: string, specs: Record<string, PropSpec>): AppNode {
    const props: Record<string, unknown> = {};
    for (const [key, fs] of Object.entries(specs)) {
        if (fs.type === 'list' && fs.itemShape) props[key] = [sampleItem(fs.itemShape)];
        else props[key] = fs.default === undefined ? null : JSON.parse(JSON.stringify(fs.default));
    }
    const node: AppNode = { id: 'cmp_more1', type, visible: true, props, style: {} };
    if (SPECS[type].container) node.children = [];
    return node;
}

function defWith(node: AppNode): AppDefinition {
    return {
        schemaVersion: 2,
        meta: { name: 'T', description: '', icon: 'LayoutGrid' },
        theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        homeScreenId: 'scr_more1',
        screens: [{ id: 'scr_more1', name: 'T', icon: null, showInNav: true, maxWidth: 'medium', sections: [{ id: 'sec_more1', style: {}, children: [node] }] }],
        actions: {},
    } as unknown as AppDefinition;
}

async function renderMore(type: string, catalog = CATALOG, coverage: PanelCoverage | null = getPanelCoverage(type)) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['studio-apps', 'catalog'], catalog);
    const node = nodeFor(type, catalog.components[type].props);
    const utils = render(
        <QueryClientProvider client={client}>
            <MoreOptions node={node} definition={defWith(node)} onCommit={vi.fn()} coverage={coverage as PanelCoverage} />
        </QueryClientProvider>,
    );
    const toggle = screen.queryByRole('button', { name: /More options/ });
    if (toggle && toggle.getAttribute('aria-expanded') === 'false') await userEvent.setup().click(toggle);
    const shownProps = Array.from(utils.container.querySelectorAll('[data-spec-prop]')).map((el) => el.getAttribute('data-spec-prop'));
    const shownItems = Array.from(utils.container.querySelectorAll('[data-more-item]')).map((el) => el.getAttribute('data-more-item'));
    return { ...utils, shownProps, shownItems: Array.from(new Set(shownItems)) };
}

describe('bespoke panel coverage', () => {
    it.each(TYPES)('%s: names only props and item keys of its spec, and every list it edits', (type) => {
        const coverage = getPanelCoverage(type);
        expect(coverage, `${type} registers no coverage`).toBeTruthy();
        const props = SPECS[type].props;
        const handled = coverage!.props;
        expect(new Set(handled).size, `${type} names a prop twice`).toBe(handled.length);
        for (const key of handled) expect(props, `${type}.${key} is not in the spec`).toHaveProperty(key);
        const paths = new Set(Object.keys(coverage!.items || {}));
        for (const key of handled) {
            const fs = props[key];
            if (fs.type !== 'list' || !fs.itemShape) continue;
            expect(paths.has(key), `${type}.${key}: name the item keys the panel edits`).toBe(true);
            paths.delete(key);
            for (const ik of coverage!.items![key]) {
                expect(fs.itemShape, `${type}.${key}[].${ik} is not in the spec`).toHaveProperty(ik);
                const sub = fs.itemShape[ik];
                if (sub.type === 'list' && sub.itemShape) {
                    const path = nestedPath(key, ik);
                    expect(paths.has(path), `${type}.${path}: name the item keys the panel edits`).toBe(true);
                    paths.delete(path);
                    for (const sk of coverage!.items![path]) expect(sub.itemShape, `${type}.${path}[].${sk} is not in the spec`).toHaveProperty(sk);
                }
            }
        }
        expect([...paths], `${type}: item keys named for a list the panel does not edit`).toEqual([]);
    });
});

describe('handled + "More options" = the spec', () => {
    it.each(TYPES)('%s', async (type) => {
        const coverage = getPanelCoverage(type)!;
        const props = SPECS[type].props;
        const { shownProps, shownItems } = await renderMore(type);
        expect([...coverage.props, ...shownProps].sort()).toEqual(Object.keys(props).sort());
        expect(shownProps.filter((k) => coverage.props.includes(k as string))).toEqual([]);
        const expectedItems: string[] = [];
        for (const list of planMoreOptions(props, coverage).lists) {
            for (const k of list.extraKeys) expectedItems.push(`${list.key}[].${k}`);
            for (const n of list.nested) for (const k of n.extraKeys) expectedItems.push(`${nestedPath(list.key, n.key)}[].${k}`);
        }
        expect(shownItems.sort()).toEqual(expectedItems.sort());
        // Every item key of every edited list is reachable: by the panel or here.
        for (const key of coverage.props) {
            const fs = props[key];
            if (fs.type !== 'list' || !fs.itemShape) continue;
            for (const ik of Object.keys(fs.itemShape)) {
                const byPanel = coverage.items![key].includes(ik);
                expect(byPanel || shownItems.includes(`${key}[].${ik}`), `${type}.${key}[].${ik} has no control`).toBe(true);
            }
        }
    });
});

describe('a prop added to the spec later shows up by itself', () => {
    it('a since-3 prop and a since-3 column key of table appear under More options', async () => {
        const catalog = JSON.parse(JSON.stringify(CATALOG));
        catalog.components.table.props.laterProp = { type: 'string', since: 3, description: 'A prop another package adds.' };
        catalog.components.table.props.columns.itemShape.laterKey = { type: 'boolean', since: 3, description: 'A column key added later.' };
        const { shownProps, shownItems } = await renderMore('table', catalog);
        expect(shownProps).toContain('laterProp');
        expect(shownItems).toContain('columns[].laterKey');
    });

    it('a panel that names every prop shows no block at all', async () => {
        const { container } = await renderMore('heading');
        expect(container.querySelector('[data-more-options]')).toBeNull();
    });
});
