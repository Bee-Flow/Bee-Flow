import { PALETTE_ICON_NAMES, STEP_ICON_NAMES, type FlowDefinition, type PaletteCatalog } from '@/features/flow-editor/model';
import { chain, clone } from '@/features/flow-editor/model/testing/fixtures';
import { isIconName } from '@/shared/ui';

import { layersOf, pickerScope, pickerSections, takesTriggers, type PickerItemRow, type PickerSection } from './pickerModel';

const t = (_key: string, fallback: string) => fallback;

const CATALOG: PaletteCatalog = {
    apps: [
        { id: 'gmail', label: 'Gmail', available: true, actions: [{ name: 'gmail_send_email', label: 'Send email', sideEffect: true }] },
        { id: 'drive', label: 'Google Drive', available: false, actions: [{ name: 'drive_upload', label: 'Upload' }] },
    ],
    flags: { code: false, codeReason: 'runtime' },
};

const items = (sections: PickerSection[]) => sections.flatMap((s) => s.data).filter((r): r is PickerItemRow => r.kind === 'item');
const byKind = (sections: PickerSection[], kind: string) => items(sections).filter((r) => r.payload.kind === kind);
const labels = (sections: PickerSection[]) => items(sections).map((r) => r.label);

void t;

describe('where a trigger may be picked', () => {
    const def = clone(chain);
    const scope = pickerScope(def, { kind: 'after', sourceId: 'c11', handle: null }, { catalog: CATALOG });

    it('only at the flow’s own start', () => {
        expect(takesTriggers({ kind: 'root' })).toBe(true);
        expect(takesTriggers({ kind: 'after', sourceId: 'c1', handle: null })).toBe(false);
        expect(takesTriggers({ kind: 'splice', sourceId: 'c1', targetId: 'c2', identity: {} })).toBe(false);
    });

    it('leaves the triggers out of a "+" in the flow, browsing and searching', () => {
        expect(byKind(pickerSections(scope, '', { triggers: false }), 'trigger')).toHaveLength(0);
        expect(byKind(pickerSections(scope, 'webhook', { triggers: false }), 'trigger')).toHaveLength(0);
        expect(byKind(pickerSections(scope, ''), 'trigger').length).toBeGreaterThan(0);
    });
});

describe('the picker for a "+" in the main flow', () => {
    const def = clone(chain);
    const scope = pickerScope(def, { kind: 'after', sourceId: 'c11', handle: null }, { catalog: CATALOG });

    it('lists the web groups in order: triggers, AI, an app category, the four flow sections', () => {
        const titles = pickerSections(scope, '').map((s) => s.title);
        expect(titles.slice(0, 2)).toEqual(['Trigger', 'AI']);
        expect(titles).toEqual(expect.arrayContaining(['Flow control', 'People & waiting', 'Data & lists', 'Integrations']));
        expect(titles.some((title) => title.startsWith('Action · '))).toBe(true);
    });

    it('offers only the apps the catalog says are available, under their app', () => {
        const sections = pickerSections(scope, '');
        expect(labels(sections)).toContain('Send email');
        expect(labels(sections)).not.toContain('Upload');
        expect(sections.flatMap((s) => s.data).some((r) => r.kind === 'app' && r.label)).toBe(true);
    });

    it('shows Code disabled with the server’s reason', () => {
        const [code] = byKind(pickerSections(scope, ''), 'code');
        expect(code?.disabled).toBe(true);
        expect(code?.reason).toMatch(/installed without the code sandbox/);
    });

    it('disables form pages without a form trigger, and enables them with one', () => {
        expect(byKind(pickerSections(scope, ''), 'form_page').every((r) => r.disabled && !!r.reason)).toBe(true);
        const form: FlowDefinition = { ...def, trigger: { id: 'trg', type: 'trigger', kind: 'form' } };
        const withForm = pickerScope(form, { kind: 'after', sourceId: 'c0', handle: null }, { catalog: CATALOG });
        expect(byKind(pickerSections(withForm, ''), 'form_page').every((r) => !r.disabled)).toBe(true);
    });

    it('offers the Studio App steps as the web palette does: no licence gate', () => {
        const studio = items(pickerSections(scope, '')).filter((r) => r.payload.kind === 'return_to_app' || r.payload.triggerKind === 'app_trigger');
        expect(studio.length).toBeGreaterThanOrEqual(2);
        expect(studio.every((r) => !r.disabled)).toBe(true);
    });

    it('searches every addable thing and disables the hits the same way', () => {
        const hits = pickerSections(scope, 'email');
        expect(hits).toHaveLength(1);
        expect(labels(hits)).toContain('Send email');
        expect(byKind(pickerSections(scope, 'code'), 'code').every((r) => r.disabled)).toBe(true);
        expect(pickerSections(scope, 'zzzz-nothing')).toEqual([]);
    });
});

describe('the picker inside a loop body', () => {
    const scope = pickerScope(clone(chain), { kind: 'inline', container: 'loop_1', branch: null, index: 0 }, { catalog: CATALOG });

    it('leaves out what cannot run inside a loop, every trigger, flowlets and published Steps', () => {
        const sections = pickerSections(scope, '');
        expect(sections.map((s) => s.title)).not.toContain('Trigger');
        for (const kind of ['approval', 'form_page', 'return_to_app', 'trigger']) expect(byKind(sections, kind)).toEqual([]);
        expect(byKind(sections, 'wait')).toHaveLength(1);
        expect(byKind(pickerSections(scope, 'approval'), 'approval')).toEqual([]);
    });

    it('takes the web LoopBodyEditor’s scope: no flowlets, no published Steps', () => {
        const def: FlowDefinition = { ...clone(chain), layers: { l1: { title: 'Lookup', steps: [], edges: [] } } };
        const withSteps: PaletteCatalog = { ...CATALOG, steps: [{ id: 'blk1', title: 'Tidy address', available: true }] };
        const held = pickerScope(def, { kind: 'inline', container: 'loop_1', branch: null, index: 0 }, { catalog: withSteps });
        expect(held).toMatchObject({ isBlockRoot: true, inLayer: true, layers: [] });
        const top = pickerScope(def, { kind: 'after', sourceId: 'c11', handle: null }, { catalog: withSteps });
        expect(top).toMatchObject({ isBlockRoot: false, inLayer: false });
        expect(top.layers).toHaveLength(1);
        expect(byKind(pickerSections(top, ''), 'call_block')).toHaveLength(1);
        expect(byKind(pickerSections(held, ''), 'call_block')).toEqual([]);
        expect(byKind(pickerSections(held, ''), 'call_layer')).toEqual([]);
    });
});

describe('the picker on a graph with no trigger', () => {
    it('offers triggers only', () => {
        const scope = pickerScope({ steps: [], edges: [] }, { kind: 'root' }, { catalog: CATALOG });
        const sections = pickerSections(scope, '');
        expect(sections.map((s) => s.title)).toEqual(['Trigger']);
        expect(items(sections).every((r) => r.payload.kind === 'trigger')).toBe(true);
    });
});

describe('the picker inside a flowlet', () => {
    const layer = (steps: FlowDefinition['steps']): FlowDefinition => ({
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] }, steps, edges: [],
    });
    const root: FlowDefinition = {
        ...clone(chain),
        layers: {
            a: layer([{ id: 'c', type: 'call_layer', layerKey: 'b' }]),
            b: layer([]),
            c: layer([{ id: 'out', type: 'layer_output', fields: {} }]),
        },
    };
    const inside = (key: string) => ({ ...(root.layers?.[key] as FlowDefinition), layers: root.layers });

    it('offers its one Return while it has none, and no trigger', () => {
        const scope = pickerScope(inside('b'), { kind: 'after', sourceId: 'trg', handle: null }, { catalog: CATALOG, flowlet: 'b' });
        expect(scope).toMatchObject({ inLayer: true, canAddLayerOutput: true, canCreateLayer: true });
        expect(byKind(pickerSections(scope, ''), 'layer_output')).toHaveLength(1);
        expect(byKind(pickerSections(scope, ''), 'trigger')).toEqual([]);
        const done = pickerScope(inside('c'), { kind: 'after', sourceId: 'trg', handle: null }, { catalog: CATALOG, flowlet: 'c' });
        expect(done.canAddLayerOutput).toBe(false);
    });

    it('never offers a call that would be a cycle', () => {
        expect(layersOf(inside('b'), 'b').map((l) => l.key)).toEqual(['c']);
        expect(layersOf(root).map((l) => l.key)).toEqual(['a', 'b', 'c']);
    });

    it('offers "Create flowlet" at the top of any graph, never in a loop body', () => {
        expect(pickerScope(root, { kind: 'after', sourceId: 'c11', handle: null }).canCreateLayer).toBe(true);
        expect(pickerScope(root, { kind: 'inline', container: 'loop_1', branch: null, index: 0 }).canCreateLayer).toBe(false);
    });
});

describe('flowlets and glyphs', () => {
    it('lists the routine’s flowlets', () => {
        expect(layersOf({ steps: [], edges: [], layers: { l1: { title: 'Lookup', steps: [], edges: [], params: [{ name: 'q' }] } } })).toEqual([
            { key: 'l1', title: 'Lookup', params: [{ name: 'q' }] },
        ]);
    });

    it('can draw every palette glyph and every step symbol', () => {
        expect([...PALETTE_ICON_NAMES, ...STEP_ICON_NAMES].filter((name) => !isIconName(name))).toEqual([]);
    });
});
