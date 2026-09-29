import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import LoopNode from './LoopNode';
import LoopItemNode from './LoopItemNode';
import { NodeRuntimeContext } from '../NodeRuntimeContext';
import { statusVar } from '../nodeTypeColors';

// A switchable dictionary over the REAL useTranslation, off by default so every
// other test here reads the shipped English. Switched on below to prove the
// step-count words come from t() — with English defaults a hardcoded "steps"
// and a translated one look identical, which is exactly how the collapsed chip
// kept an "s" glued on in JavaScript while the expanded card had long since
// moved to a key pair.
const { transOverride } = vi.hoisted(() => ({ transOverride: { current: null } }));
vi.mock('../../../../../hooks/useTranslation', async (importOriginal) =>
    (await import('@/test/translationOverride')).overrideTranslation(await importOriginal(), transOverride));

/**
 * A Repeat-for-each has two shapes, like a flowlet call: the ordinary card, and
 * a container its body is drawn inside. The body used to be authorable only as
 * a list in the step editor, so the badge pointed the user there; both the
 * badge and the card now point at the canvas.
 */
const STEP = {
    id: 'lp1', type: 'loop', label: 'Repeat for each',
    overRef: 'steps.src.output.results', itemVar: 'item',
    body: [{ id: 'a', type: 'set' }, { id: 'b', type: 'set' }],
};

function renderLoop({ step = STEP, data = {}, rt = {} } = {}) {
    return render(
        <ReactFlowProvider>
            <NodeRuntimeContext.Provider value={{
                pinnedById: new Set(), disabledById: new Set(),
                triggerIds: new Set(), attachedIds: new Set(),
                ...rt,
            }}>
                <LoopNode id="lp1" data={{
                    step, runStep: null, issues: { errors: [], warnings: [] },
                    stepLabelById: new Map([['src', 'Search email']]),
                    ...data,
                }} />
            </NodeRuntimeContext.Provider>
        </ReactFlowProvider>,
    );
}

describe('LoopNode — collapsed', () => {
    beforeEach(() => { cleanup(); transOverride.current = null; });

    it('counts the body steps by KEY, singular and plural alike', () => {
        // House rule: no grammar in code. `step${bodyLen === 1 ? '' : 's'}`
        // reads correctly in English and cannot be translated at all — a
        // dictionary gets handed "step" and has no say over the "s" that the
        // component welds on afterwards. The two forms are two keys, chosen by
        // a ternary around the KEY, exactly as the expanded card does it.
        // "inside" is part of the sentence, so it lives in the SAME key as the
        // count. It used to sit loose in the JSX: the number translated and the
        // word did not, which is why the override below is the whole clause.
        transOverride.current = {
            'routines.canvas.loop_body_inside': '{n} stap erin',
            'routines.canvas.loop_body_inside_plural': '{n} stappen erin',
        };
        renderLoop();
        expect(screen.getByText(/2 stappen erin/)).toBeTruthy();
        expect(screen.queryByText(/inside/)).toBeNull();
        cleanup();
        renderLoop({ step: { ...STEP, body: [{ id: 'a', type: 'set' }] } });
        expect(screen.getByText(/1 stap erin/)).toBeTruthy();
    });

    it('still reads "▸ 1 step inside" in English — the singular is a real form', () => {
        renderLoop({ step: { ...STEP, body: [{ id: 'a', type: 'set' }] } });
        expect(screen.getByText(/▸\s*1 step inside/)).toBeTruthy();
    });

    it('offers Expand, passing no flowlet key — a body is not shared', () => {
        const onToggleInline = vi.fn();
        renderLoop({ rt: { onToggleInline } });
        fireEvent.click(screen.getByRole('button', { name: /expand/i }));
        expect(onToggleInline).toHaveBeenCalledWith('lp1', null);
    });

    it('shows no Expand affordance on a canvas that cannot expand', () => {
        renderLoop();
        expect(screen.queryByRole('button', { name: /expand/i })).toBeNull();
    });

    it('counts the body and names the list it walks', () => {
        renderLoop();
        expect(screen.getByText('▸ 2 steps inside')).toBeTruthy();
        expect(screen.getByText(/Search email/)).toBeTruthy();
    });

    it('sends the user to the canvas for the body, not to the inspector', () => {
        renderLoop();
        expect(screen.getByTitle(/expand the node to see them/i)).toBeTruthy();
    });

});

/** Everything the collapsed card says, proved to come from the dictionary. */
describe('LoopNode — collapsed, in another language', () => {
    beforeEach(() => { cleanup(); transOverride.current = null; });

    it('says what it walks in ONE translatable sentence, batch clause included', () => {
        // The `· ×{batch}` tail used to be a ternary inside the template
        // string: the dictionary got a stem and JavaScript welded the rest on.
        // Two keys, one per shape, chosen around the KEY.
        transOverride.current = {
            'routines.canvas.loop_over': 'per {list}, als loop.{item}',
            'routines.canvas.loop_over_batched': 'per {list}, als loop.{item}, {batch} tegelijk',
        };
        renderLoop();
        expect(screen.getByText('per ‹Search email›.results, als loop.item')).toBeTruthy();
        cleanup();
        renderLoop({ step: { ...STEP, batchSize: 25 } });
        expect(screen.getByText('per ‹Search email›.results, als loop.item, 25 tegelijk')).toBeTruthy();
    });

    it('translates the "no list yet" line too, instead of leaving it English', () => {
        transOverride.current = { 'routines.canvas.loop_no_list': 'nog geen lijst · als loop.{item}' };
        renderLoop({ step: { ...STEP, overRef: '' } });
        expect(screen.getByText('nog geen lijst · als loop.item')).toBeTruthy();
    });

    it('takes its port labels from the dictionary — they travel as data', () => {
        // sourceHandles is a prop, so the labels leave this file as DATA and
        // are rendered by StepNodeBase. Hardcoded, they were the one part of
        // the card no dictionary could reach.
        transOverride.current = {
            'routines.canvas.loop_port_done': 'Klaar',
            'routines.canvas.loop_port_on_error': 'Bij fout',
        };
        renderLoop();
        expect(screen.getByText('Klaar')).toBeTruthy();
        expect(screen.getByText('Bij fout')).toBeTruthy();
    });

    it('passes t to the node definition, so the type label is translatable', () => {
        // nodeTypeLabel/nodeHelp/nodeDefaultLabel answer in English when they
        // get no `t` — the keys existed all along and the card ignored them.
        transOverride.current = { 'routines.node.loop.typeLabel': 'Herhaal' };
        renderLoop();
        expect(screen.getByText('Herhaal')).toBeTruthy();
    });

    it('names the node from the dictionary when the step has no label of its own', () => {
        transOverride.current = { 'routines.node.loop.defaultLabel': 'Herhaal voor elk' };
        renderLoop({ step: { ...STEP, label: '' } });
        expect(screen.getByText('Herhaal voor elk')).toBeTruthy();
    });

    it('translates the two chip tooltips and the expand affordance', () => {
        transOverride.current = {
            'routines.canvas.loop_body_title': 'Stappen per item',
            'routines.canvas.loop_max_title': 'Max. herhalingen',
            'routines.canvas.loop_expand': 'Uitklappen op het canvas',
        };
        renderLoop({ rt: { onToggleInline: vi.fn() } });
        expect(screen.getByTitle('Stappen per item')).toBeTruthy();
        expect(screen.getByTitle('Max. herhalingen')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Uitklappen op het canvas' })).toBeTruthy();
    });
});

/** The container's own box — the only element that carries its border. */
const box = (container) => container.querySelector('div.rounded-2xl');

describe('LoopNode — expanded container', () => {
    beforeEach(() => { cleanup(); transOverride.current = null; });

    const expanded ={ inlineExpanded: { prefix: 'lp1', kind: 'loop', size: { width: 900, height: 260 } } };

    it('renders header chrome instead of the card body', () => {
        renderLoop({ data: expanded, rt: { onToggleInline: vi.fn() } });
        expect(screen.getByText('Repeat for each')).toBeTruthy();
        expect(screen.getByText(/over .*Search email.* · as loop\.item/)).toBeTruthy();
        // The step count belongs to the collapsed card — expanded, the steps
        // themselves are on screen.
        expect(screen.queryByText('▸ 2 steps inside')).toBeNull();
    });

    it('collapses again from the header', () => {
        const onToggleInline = vi.fn();
        renderLoop({ data: expanded, rt: { onToggleInline } });
        fireEvent.click(screen.getByTitle(/collapse/i));
        expect(onToggleInline).toHaveBeenCalledWith('lp1', null);
    });

    it('says once that per-item steps carry no run status of their own', () => {
        // execLoop passes recordSteps:false, so the cards inside never light up.
        // Without this the user is left waiting for something that cannot come.
        renderLoop({ data: expanded });
        expect(screen.getByTitle(/aren't recorded one by one/i)).toBeTruthy();
    });

    it('keeps both outgoing ports while open', () => {
        const { container } = renderLoop({ data: expanded });
        const ids = [...container.querySelectorAll('.react-flow__handle')]
            .map(h => h.getAttribute('data-handleid'));
        expect(ids).toContain('done');
        expect(ids).toContain('on_error');
    });

    it('borders in the shared status colour, not a ladder of its own', () => {
        // This container used to keep a private running/success/error ladder
        // and spelled `running` amber — on the same canvas where the cards
        // inside it are painted blue for that state, and beside a run panel
        // that says blue too. A status it had never heard of (a loop parked
        // on an approval) simply got no colour at all.
        for (const status of ['running', 'success', 'error', 'awaiting_approval']) {
            cleanup();
            const { container } = renderLoop({ data: { ...expanded, runStep: { status } } });
            expect(box(container).style.border, status).toBe(`2px solid ${statusVar(status)}`);
        }
        cleanup();
        expect(statusVar('running')).toBe('var(--type-ai)');
    });

    it('summarises the loop in one translatable sentence, batch clause and all', () => {
        transOverride.current = {
            'routines.canvas.loop_over_summary': 'over {list} · als loop.{item} · ≤{max}',
            'routines.canvas.loop_over_summary_batched': 'over {list} · als loop.{item} · ×{batch} · ≤{max}',
        };
        renderLoop({ data: expanded });
        expect(screen.getByText('over ‹Search email›.results · als loop.item · ≤100')).toBeTruthy();
        cleanup();
        renderLoop({ step: { ...STEP, batchSize: 25, maxIterations: 40 }, data: expanded });
        expect(screen.getByText('over ‹Search email›.results · als loop.item · ×25 · ≤40')).toBeTruthy();
    });

    it('translates the not-recorded note and the collapse control', () => {
        transOverride.current = {
            'routines.canvas.loop_not_recorded': 'losse stappen worden niet vastgelegd',
            'routines.canvas.loop_not_recorded_title': 'De lus draagt zelf de status.',
            'routines.canvas.loop_collapse': 'Inklappen',
        };
        renderLoop({ data: expanded, rt: { onToggleInline: vi.fn() } });
        expect(screen.getByText('losse stappen worden niet vastgelegd')).toBeTruthy();
        expect(screen.getByTitle('De lus draagt zelf de status.')).toBeTruthy();
        expect(screen.getByTitle('Inklappen')).toBeTruthy();
    });

    it('keeps its dashed family border for a status that makes no claim', () => {
        const { container } = renderLoop({ data: { ...expanded, runStep: { status: 'queued' } } });
        expect(box(container).style.border).toBe('1.5px dashed var(--type-loop)');
    });
});

describe('LoopItemNode', () => {
    beforeEach(cleanup);

    const renderItem = (step) => render(
        <ReactFlowProvider>
            <LoopItemNode id="lp1/__item__" data={{ step }} />
        </ReactFlowProvider>,
    );

    it('names the variable the steps below have to bind against', () => {
        renderItem({ id: '__item__', type: 'loop_item', itemVar: 'invoice', batchSize: 1 });
        expect(screen.getByText('Each item')).toBeTruthy();
        expect(screen.getByText('loop.invoice')).toBeTruthy();
    });

    it('says BATCH when the loop binds a slice, not a single item', () => {
        renderItem({ id: '__item__', type: 'loop_item', itemVar: 'rows', batchSize: 10 });
        expect(screen.getByText('Each batch of 10')).toBeTruthy();
    });

    it('has an output only — nothing connects into the start of an iteration', () => {
        const { container } = renderItem({ id: '__item__', type: 'loop_item', itemVar: 'item', batchSize: 1 });
        const handles = [...container.querySelectorAll('.react-flow__handle')];
        expect(handles.length).toBe(1);
        expect(handles[0].className).toMatch(/source/);
    });
});
