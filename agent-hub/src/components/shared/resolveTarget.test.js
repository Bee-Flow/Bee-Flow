// @vitest-environment node
import { describe, expect, it } from 'vitest';

import resolveTarget, { detectKind } from './resolveTarget';
import { nodeLabel } from '../admin/Studio/AppStudio/editor/dryRunIssues';

/**
 * The one deep-link resolver, both directions, for both kinds of definition.
 * The app half replaces PublishModal.resolveIssueTarget (path → node) and
 * dryRunIssues.nodeLabel (node → label), so their old edge cases are pinned
 * here: a trailing `props.x` stops at the node, a path that does not start
 * at a screen is null, an unknown id is null.
 */

const APP = {
    screens: [
        {
            id: 'scr_home', name: 'Home',
            sections: [
                { id: 'sec_top', children: [{ id: 'cmp_title', type: 'heading', props: { text: 'Welcome' } }] },
                {
                    id: 'sec_main',
                    children: [
                        {
                            id: 'cmp_card', type: 'card', props: {},
                            children: [{ id: 'cmp_inner', type: 'button', props: { label: 'Send the quote to the customer now' } }],
                        },
                        { id: 'cmp_bare', type: 'table', props: {} },
                        { type: 'divider', props: {} },
                    ],
                },
            ],
        },
        { id: 'scr_orders', name: 'Orders', sections: [{ id: 'sec_orders', children: [{ id: 'cmp_list', type: 'list', props: { title: '  Order list  ' } }] }] },
    ],
};

describe('resolveTarget — app definitions', () => {
    it('walks a validator path to the deepest addressed node and the screen it sits on', () => {
        expect(resolveTarget(APP, { path: 'screens[0].sections[1].children[0].children[0].props.onClick' })).toEqual({
            kind: 'app',
            screenId: 'scr_home',
            screenName: 'Home',
            nodeId: 'cmp_inner',
            label: 'Send the quote to the customer',
            labelIsText: true,
        });
    });

    it('stops at trailing segments that address a field, and at a section when that is all the path names', () => {
        expect(resolveTarget(APP, { path: 'screens[1].sections[0].children[0].props.title' }).nodeId).toBe('cmp_list');
        const section = resolveTarget(APP, { path: 'screens[1].sections[0]' });
        expect(section).toMatchObject({ screenId: 'scr_orders', nodeId: 'sec_orders', label: 'sec_orders', labelIsText: false });
    });

    it('a path naming only a screen is a hit on the screen, labelled by its name', () => {
        expect(resolveTarget(APP, { path: 'screens[1].name' })).toEqual({
            kind: 'app', screenId: 'scr_orders', screenName: 'Orders', nodeId: null, label: 'Orders', labelIsText: true,
        });
    });

    it('keeps the last id when a deeper node has none, and keeps what it found past a stale index', () => {
        expect(resolveTarget(APP, { path: 'screens[0].sections[1].children[2]' }).nodeId).toBe('sec_main');
        expect(resolveTarget(APP, { path: 'screens[0].sections[1].children[9].props.x' }).nodeId).toBe('sec_main');
    });

    it('is null for a path that does not start at a real screen', () => {
        expect(resolveTarget(APP, { path: 'meta.name' })).toBeNull();
        expect(resolveTarget(APP, { path: 'actions.go.steps[0]' })).toBeNull();
        expect(resolveTarget(APP, { path: 'screens[7].sections[0]' })).toBeNull();
        expect(resolveTarget(APP, { path: 'screens' })).toBeNull();
    });

    it('finds a node by id, however deep, and labels it by its own words, its type, or its id', () => {
        expect(resolveTarget(APP, { nodeId: 'cmp_inner' })).toMatchObject({ screenId: 'scr_home', nodeId: 'cmp_inner', label: 'Send the quote to the customer', labelIsText: true });
        expect(resolveTarget(APP, { nodeId: 'cmp_bare' })).toMatchObject({ label: 'table', labelIsText: false });
        expect(resolveTarget(APP, { nodeId: 'cmp_list' })).toMatchObject({ screenId: 'scr_orders', screenName: 'Orders', label: 'Order list' });
        expect(resolveTarget(APP, { nodeId: 'sec_top' })).toMatchObject({ nodeId: 'sec_top', label: 'sec_top' });
    });

    it('is null for an unknown id, an empty ref, or no definition', () => {
        expect(resolveTarget(APP, { nodeId: 'cmp_ghost' })).toBeNull();
        expect(resolveTarget(APP, {})).toBeNull();
        expect(resolveTarget(APP)).toBeNull();
        expect(resolveTarget(null, { nodeId: 'cmp_inner' })).toBeNull();
        expect(resolveTarget({ screens: 'nope' }, { path: 'screens[0]' })).toBeNull();
    });

    it('tries the path first and falls back to the id when the path addresses nothing', () => {
        expect(resolveTarget(APP, { path: 'meta.name', nodeId: 'cmp_list' }).nodeId).toBe('cmp_list');
        expect(resolveTarget(APP, { path: 'screens[0].sections[0].children[0]', nodeId: 'cmp_list' }).nodeId).toBe('cmp_title');
    });
});

describe('nodeLabel still reads the way the dry-run sentences expect', () => {
    it('quotes a node\'s own words, leaves a type bare, falls back to the id', () => {
        expect(nodeLabel(APP, 'cmp_list')).toBe('“Order list”');
        expect(nodeLabel(APP, 'cmp_inner')).toBe('“Send the quote to the customer”');
        expect(nodeLabel(APP, 'cmp_bare')).toBe('table');
        expect(nodeLabel(APP, 'cmp_ghost')).toBe('cmp_ghost');
        expect(nodeLabel(APP, null)).toBe('A component');
        expect(nodeLabel(null, 'cmp_list')).toBe('cmp_list');
    });
});

const FLOW = {
    trigger: { id: 'trg', kind: 'schedule' },
    triggers: [{ id: 'trg_form', kind: 'form' }],
    steps: [
        { id: 's_fetch', type: 'http_request', title: 'Fetch KvK' },
        {
            id: 's_loop', type: 'loop',
            body: [{ id: 's_inner', type: 'set' }, { id: 's_par', type: 'parallel', branches: [[{ id: 's_deep', type: 'notification', name: 'Ping' }]] }],
        },
    ],
    edges: [],
    layers: { enrich: { title: 'Enrich the lead', trigger: { id: 'ltrg', kind: 'layer_input' }, steps: [{ id: 'l_ai', type: 'ai_step' }], edges: [] } },
};

describe('resolveTarget — automation definitions', () => {
    it('detects the kind from the shape', () => {
        expect(detectKind(APP)).toBe('app');
        expect(detectKind(FLOW)).toBe('automation');
        expect(detectKind({ layers: {} })).toBe('automation');
        expect(detectKind({})).toBeNull();
    });

    it('resolves the validator\'s mixed addressing: index at the top, id when nested, the trigger by name', () => {
        expect(resolveTarget(FLOW, { path: 'steps[0].url' })).toEqual({
            kind: 'automation', screenId: null, screenName: null, nodeId: 's_fetch', label: 'Fetch KvK', labelIsText: true,
        });
        expect(resolveTarget(FLOW, { path: 'steps[s_fetch]' }).nodeId).toBe('s_fetch');
        expect(resolveTarget(FLOW, { path: 'steps[1].body.steps[s_inner].value' }).nodeId).toBe('s_inner');
        expect(resolveTarget(FLOW, { path: 'steps[1].body.steps[s_par].branches[0].steps[s_deep]' })).toMatchObject({ nodeId: 's_deep', label: 'Ping' });
        expect(resolveTarget(FLOW, { path: 'trigger.schedule.cron' })).toMatchObject({ nodeId: 'trg', label: 'schedule', labelIsText: false });
        expect(resolveTarget(FLOW, { path: 'triggers[trg_form].kind' }).nodeId).toBe('trg_form');
        expect(resolveTarget(FLOW, { path: 'triggers[0].kind' }).nodeId).toBe('trg_form');
    });

    it('treats a layer as the "screen" a step sits on', () => {
        expect(resolveTarget(FLOW, { path: 'layers.enrich.steps[0].prompt' })).toEqual({
            kind: 'automation', screenId: 'enrich', screenName: 'Enrich the lead', nodeId: 'l_ai', label: 'ai_step', labelIsText: false,
        });
        expect(resolveTarget(FLOW, { nodeId: 'l_ai' })).toMatchObject({ screenId: 'enrich', nodeId: 'l_ai' });
        expect(resolveTarget(FLOW, { nodeId: 'ltrg' })).toMatchObject({ screenId: 'enrich', nodeId: 'ltrg' });
    });

    it('finds nested steps and triggers by id, and is null for what does not exist', () => {
        expect(resolveTarget(FLOW, { nodeId: 's_deep' })).toMatchObject({ screenId: null, nodeId: 's_deep', label: 'Ping', labelIsText: true });
        expect(resolveTarget(FLOW, { nodeId: 'trg_form' })).toMatchObject({ nodeId: 'trg_form' });
        expect(resolveTarget(FLOW, { nodeId: 's_ghost' })).toBeNull();
        expect(resolveTarget(FLOW, { path: 'edges[0].from' })).toBeNull();
        expect(resolveTarget(FLOW, { path: 'layers.ghost.steps[0]' })).toBeNull();
        expect(resolveTarget(FLOW, { path: 'steps[9].url' })).toBeNull();
    });

    it('can be forced to a kind, which keeps a lookalike shape from being misread', () => {
        expect(resolveTarget(FLOW, { path: 'steps[0]', kind: 'app' })).toBeNull();
        expect(resolveTarget(APP, { nodeId: 'cmp_list', kind: 'automation' })).toBeNull();
    });
});
