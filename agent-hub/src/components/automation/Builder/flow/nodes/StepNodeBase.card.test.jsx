import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import StepNodeBase from './StepNodeBase';
import { NodeRuntimeContext } from '../NodeRuntimeContext';

/**
 * The 240×72 card of the builder redesign (artboard 1g).
 *
 * Vitest runs with css:false, so nothing here reads a computed colour. What
 * CAN be proven: the inline styles the card writes, and the source of every
 * node file — that no node paints its own status/type colour any more. The
 * colour recipes themselves are covered by flow/nodeTypeColors.test.js; this
 * file proves the card USES them.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

function renderCard(props = {}, rt = {}) {
    return render(
        <ReactFlowProvider>
            <NodeRuntimeContext.Provider value={{
                pinnedById: new Set(), disabledById: new Set(), triggerIds: new Set(), attachedIds: new Set(),
                typeGroupById: new Map([['s7', 'ai']]),
                stepTypeById: new Map([['s7', 'ai_step']]),
                stepNumberById: new Map([['s7', 7]]),
                ...rt,
            }}>
                <StepNodeBase nodeId="s7" icon={null} typeLabel="AI step" name="Forecast" sub="banking & sector · 3 years" {...props} />
            </NodeRuntimeContext.Provider>
        </ReactFlowProvider>,
    );
}

const cardEl = (container) => container.querySelector('.group');

describe('StepNodeBase — anatomy', () => {
    beforeEach(cleanup);

    it('is a fixed 240×72 box on the card surface, whatever the content', () => {
        const { container } = renderCard();
        const s = cardEl(container).style;
        expect(s.width).toBe('240px');
        expect(s.height).toBe('72px');
        expect(s.background).toContain('var(--bg-card)');
    });

    it('paints the family as a 4px inset bar — never a border-left', () => {
        const { container } = renderCard();
        const s = cardEl(container).style;
        expect(s.boxShadow).toContain('inset 4px 0 0 var(--type-ai)');
        expect(s.borderLeft === '' || s.borderLeft === s.border).toBe(true);
        expect(s.border).toBe('1px solid var(--border-default)');
    });

    it('leads with the kicker in the family colour and the step number, then name, then summary', () => {
        const { container } = renderCard();
        const kicker = screen.getByText('AI step');
        expect(kicker.style.color).toBe('var(--type-ai)');
        expect(screen.getByTestId('node-step-number').textContent).toBe('· 7');
        expect(screen.getByTestId('node-name').textContent).toBe('Forecast');
        expect(screen.getByTestId('node-sub').textContent).toBe('banking & sector · 3 years');
        // Order in the DOM = order on the card.
        const col = screen.getByTestId('node-name').parentElement;
        expect([...col.children].map(c => c.dataset?.testid || c.className.slice(0, 4))).toEqual(['flex', 'node-name', 'node-sub']);
        void container;
    });

    it('renders a muted summary as the "not answered yet" state', () => {
        renderCard({ sub: { muted: 'no prompt yet' } });
        const sub = screen.getByTestId('node-sub');
        expect(sub.textContent).toBe('no prompt yet');
        expect(sub.className).toContain('italic');
        expect(sub.className).toContain('--text-tertiary');
    });

    it('still renders a legacy `body` slot while a node file is unconverted', () => {
        renderCard({ name: undefined, sub: undefined, body: <div>legacy body</div> });
        expect(screen.getByText('legacy body')).toBeTruthy();
        expect(screen.queryByTestId('node-name')).toBeNull();
    });

    it('a step with no context still gets a neutral card, not a crash', () => {
        render(
            <ReactFlowProvider>
                <StepNodeBase nodeId="x" icon={null} typeLabel="Wait" name="Wait a bit" />
            </ReactFlowProvider>,
        );
        expect(screen.getByTestId('node-name').textContent).toBe('Wait a bit');
        expect(screen.queryByTestId('node-step-number')).toBeNull();
    });
});

describe('StepNodeBase — status beats type', () => {
    beforeEach(cleanup);

    it('a run status paints the border and ring; the bar keeps the family colour', () => {
        const { container } = renderCard({ runStep: { status: 'error' } });
        const s = cardEl(container).style;
        expect(s.border).toBe('1.5px solid var(--error)');
        expect(s.boxShadow).toContain('inset 4px 0 0 var(--type-ai)');
        expect(s.boxShadow).toContain('0 0 0 4px color-mix(in srgb, var(--error) 22%, transparent)');
        expect(cardEl(container).dataset.status).toBe('error');
    });

    it('running pulses a 3px outline and shows the ordinal in the badge', () => {
        const { container } = renderCard(
            { runStep: { status: 'running' } },
            { runIndexById: new Map([['s7', 3]]), runTotal: 8 },
        );
        const s = cardEl(container).style;
        // Blue: `running` is --type-ai in the shared status table, the same
        // colour the run panel beside this canvas draws the step in. It was
        // amber here — and amber is what `paused` wore too (CW-04).
        expect(s.outline).toBe('3px solid var(--type-ai)');
        expect(s.animation).toContain('bf-node-pulse');
        expect(screen.getByTestId('node-status-badge').textContent).toBe('running 3/8');
    });

    it('the status badge replaces the type badge — one slot, status wins', () => {
        renderCard({ runStep: { status: 'success' }, badges: <span>thinking</span> });
        expect(screen.getByTestId('node-status-badge').textContent).toBe('done');
        expect(screen.queryByText('thinking')).toBeNull();
        cleanup();
        renderCard({ badges: <span>thinking</span> });
        expect(screen.queryByTestId('node-status-badge')).toBeNull();
        expect(screen.getByText('thinking')).toBeTruthy();
    });

    it('a pinned card reads as pinned until a live status outranks it', () => {
        const { container } = renderCard({}, { pinnedById: new Set(['s7']) });
        expect(cardEl(container).style.border).toBe('1.5px solid var(--pinned)');
        expect(screen.getByTestId('node-status-badge').textContent).toBe('pinned');
    });

    it('disabled dashes the border and fades the card; skipped fades it less', () => {
        const { container } = renderCard({}, { disabledById: new Set(['s7']) });
        expect(cardEl(container).style.border).toBe('1px dashed var(--text-tertiary)');
        expect(cardEl(container).style.opacity).toBe('0.55');
        cleanup();
        const { container: c2 } = renderCard({ runStep: { status: 'skipped' } });
        expect(c2.querySelector('.group').style.opacity).toBe('0.7');
    });

    it('an error-toned end card paints its bar red instead of the family colour', () => {
        const { container } = renderCard({ tone: 'error' }, { typeGroupById: new Map([['s7', 'end']]) });
        expect(cardEl(container).style.boxShadow).toContain('inset 4px 0 0 var(--error)');
        expect(screen.getByText('AI step').style.color).toBe('var(--error)');
    });
});

describe('StepNodeBase — while the drawer edits a step (design 1h)', () => {
    beforeEach(cleanup);

    it('the edited card reads as selected', () => {
        const { container } = renderCard({}, { editingStepId: 's7' });
        expect(cardEl(container).style.border).toBe('2px solid var(--text-primary)');
    });

    it('its source is drawn dashed in the family colour and says so in the kicker', () => {
        const { container } = renderCard({}, { editingStepId: 'other', editingSourceIds: new Set(['s7']) });
        expect(cardEl(container).style.border).toBe('2px dashed var(--type-ai)');
        expect(screen.getByTestId('node-source-tag').textContent).toContain('source');
    });

    it('what comes next is dimmed, without losing its own run status', () => {
        const { container } = renderCard({ runStep: { status: 'success' } }, { editingStepId: 'other', editingTargetIds: new Set(['s7']) });
        expect(cardEl(container).style.opacity).toBe('0.7');
        expect(cardEl(container).style.border).toBe('1.5px solid var(--success)');
    });
});

describe('StepNodeBase — validation dot', () => {
    beforeEach(cleanup);

    it('is a 12px dot outside the corner, red for errors, and the card stays neutral', () => {
        const { container } = renderCard({ issues: { errors: [{ code: 'x.missing', message: 'Missing x' }], warnings: [] } });
        const dot = screen.getByTestId('node-validation-dot');
        expect(dot.style.width).toBe('12px');
        expect(dot.style.right).toBe('-5px');
        expect(dot.dataset.tone).toBe('error');
        expect(dot.style.background).toBe('var(--error)');
        // The sentence, then the code in brackets — never the code first.
        // What the tooltip says, and why, is pinned in
        // StepNodeBase.errorLanguage.test.jsx.
        expect(dot.title).toBe('Missing x (x.missing)');
        expect(cardEl(container).style.border).toBe('1px solid var(--border-default)');
    });

    it('keeps a second tone for warnings — a warning-only node must not read as broken', () => {
        renderCard({ issues: { errors: [], warnings: [{ code: 'ref.forward', message: 'Refers ahead' }] } });
        const dot = screen.getByTestId('node-validation-dot');
        expect(dot.dataset.tone).toBe('warning');
        expect(dot.style.background).toBe('var(--warning)');
    });
});

describe('StepNodeBase — the icon tile', () => {
    beforeEach(cleanup);

    it('becomes a button when the type has something to do there (expand a container)', () => {
        let clicked = 0;
        renderCard({ onTileClick: () => { clicked += 1; }, tileLabel: 'Expand the loop' });
        const tile = screen.getByRole('button', { name: 'Expand the loop' });
        tile.click();
        expect(clicked).toBe(1);
    });

    it('is inert otherwise', () => {
        renderCard();
        expect(screen.queryByRole('button', { name: /expand/i })).toBeNull();
    });
});

describe('node files — no private colour vocabularies remain', () => {
    // Every card used to pick its own emerald/amber/red. The redesign moved
    // the whole vocabulary into flow/nodeTypeColors.js; a node file naming a
    // Tailwind colour class or a hex again is the drift this catches.
    const dir = HERE;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsx') && !f.includes('.test.'));
    const BANNED = /\b(?:border|bg|text|ring)-(?:emerald|red|amber|cyan|sky|blue|green|rose)-\d{3}\b/;

    for (const f of files) {
        if (f === 'NoteNode.jsx' || f === 'AiToolNode.jsx' || f === 'LoopItemNode.jsx' || f === 'GroupNode.jsx' || f === 'IntegrationLogo.jsx') continue;
        it(`${f} paints with tokens only`, () => {
            const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
            expect(src).not.toMatch(BANNED);
            expect(src).not.toMatch(/var\(--accent\)/);
        });
    }

    it('nothing imports the retired NodeSummaryLine', () => {
        for (const f of files) {
            const src = fs.readFileSync(path.join(dir, f), 'utf8');
            expect(src, `${f} still imports NodeSummaryLine`).not.toMatch(/NodeSummaryLine/);
        }
        expect(fs.existsSync(path.join(dir, 'NodeSummaryLine.jsx'))).toBe(false);
    });
});
