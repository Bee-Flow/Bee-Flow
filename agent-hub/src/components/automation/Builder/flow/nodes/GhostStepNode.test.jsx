import { render, screen, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import GhostStepNode from './GhostStepNode';

/**
 * The ghost slot ahead of the build frontier.
 *
 * Caption precedence is decided upstream (useBuildChoreography: narration >
 * first open todo > null); what this node owns is rendering whatever it is
 * handed, falling back to the neutral line when handed nothing, and never
 * showing anything but that one string — the raw reasoning never reaches it.
 */
function renderGhost(data) {
    return render(
        <ReactFlowProvider>
            <GhostStepNode data={data} />
        </ReactFlowProvider>,
    );
}

describe('GhostStepNode', () => {
    beforeEach(cleanup);

    it('shows the caption it is handed', () => {
        renderGhost({ caption: 'Wiring the error branch', synthetic: true });
        expect(screen.getByTestId('ghost-step-caption').textContent).toBe('Wiring the error branch');
    });

    it('falls back to the neutral line when the caption is null, empty or blank', () => {
        for (const caption of [null, undefined, '', '   ']) {
            cleanup();
            renderGhost({ caption, synthetic: true });
            expect(screen.getByTestId('ghost-step-caption').textContent).toBe('Working on the next step…');
        }
    });

    it('is a 240×72 dashed, inert box with the test id the canvas tests look for', () => {
        const { container } = renderGhost({ caption: null });
        const root = screen.getByTestId('ghost-step');
        expect(root.style.width).toBe('240px');
        expect(root.style.height).toBe('72px');
        expect(root.style.border).toBe('1.5px dashed var(--border-default)');
        expect(root.style.opacity).toBe('0.7');
        expect(root.className).toContain('pointer-events-none');
        expect(root.className).toContain('select-none');
        // Three dots, the existing bounce, staggered.
        const dots = container.querySelectorAll('.animate-bounce');
        expect(dots.length).toBe(3);
        expect([...dots].map(d => d.style.animationDelay)).toEqual(['0ms', '150ms', '300ms']);
    });

    it('the caption is the wipe hook and remounts on change so the wipe replays', () => {
        const { rerender } = renderGhost({ caption: 'One' });
        const first = screen.getByTestId('ghost-step-caption');
        expect(first.className).toContain('bf-rv-sub');
        rerender(
            <ReactFlowProvider>
                <GhostStepNode data={{ caption: 'Two' }} />
            </ReactFlowProvider>,
        );
        const second = screen.getByTestId('ghost-step-caption');
        expect(second.textContent).toBe('Two');
        expect(second).not.toBe(first);
    });

    it('never renders anything but the caption as text', () => {
        renderGhost({ caption: 'Choosing the schedule', thought: 'the raw reasoning dump', synthetic: true });
        expect(screen.getByTestId('ghost-step').textContent).toBe('Choosing the schedule');
    });
});

/**
 * With `data.draft` (flow/ghostDraft.js) the slot is the card being drawn:
 * still 240×72 and inert, but solid-bordered, with the family tile, the name
 * as typed with a caret, the kind and the "Step i of n" pill; the dots move
 * under the name. The name updates IN PLACE — no remount per character.
 */
const stepDraft = (over = {}) => ({
    kind: 'step', app: { id: 'gmail', name: 'Gmail' }, tool: 'gmail_send', type: 'integration_action', typeLabel: 'App action',
    label: 'Send the sum', partial: true, index: 2, count: 3, stepOf: 'Step 2 of 3', caption: 'Send the sum', ...over,
});

describe('GhostStepNode — the card being drawn', () => {
    beforeEach(cleanup);

    it('renders the tile with the app logo, the typed name with a caret, the kind and the pill — and still no accent', () => {
        const { container } = renderGhost({ caption: 'Narrated thought', synthetic: true, draft: stepDraft() });
        const root = screen.getByTestId('ghost-step');
        expect(root.style.width).toBe('240px');
        expect(root.style.height).toBe('72px');
        expect(root.style.borderStyle).toBe('solid');
        expect(root.style.opacity).toBe('0.85');
        expect(root.getAttribute('data-draft-kind')).toBe('step');
        expect(root.className).toContain('pointer-events-none');
        expect(root.getAttribute('style') || '').not.toContain('--accent');
        const tile = screen.getByTestId('ghost-step-tile');
        expect(tile.getAttribute('data-family')).toBe('app');
        // IntegrationLogo: the brand SVG or the letter mark, either way something with Gmail on it.
        expect(tile.querySelector('svg, img, [aria-label]')).toBeTruthy();
        expect(screen.getByTestId('ghost-step-label').textContent).toBe('Send the sum');
        expect(screen.getByTestId('ghost-step-caret').className).toContain('bf-caret');
        expect(screen.getByTestId('ghost-step-kind').textContent).toBe('App action');
        expect(screen.getByTestId('ghost-step-pill').textContent).toBe('Step 2 of 3');
        // The dots are still there, now under the name; the narrated caption is not shown.
        expect(container.querySelectorAll('.animate-bounce').length).toBe(3);
        expect(screen.queryByTestId('ghost-step-caption')).toBeNull();
        expect(root.textContent).not.toContain('Narrated thought');
    });

    it('the name updates in place while typing; the caret leaves when the label is complete', () => {
        const { rerender } = renderGhost({ draft: stepDraft({ label: 'Send th', caption: 'Send th' }) });
        const first = screen.getByTestId('ghost-step-label');
        rerender(
            <ReactFlowProvider>
                <GhostStepNode data={{ draft: stepDraft({ label: 'Send the sum', caption: 'Send the sum' }) }} />
            </ReactFlowProvider>,
        );
        const second = screen.getByTestId('ghost-step-label');
        expect(second).toBe(first);
        expect(second.textContent).toBe('Send the sum');
        expect(screen.getByTestId('ghost-step-caret')).toBeTruthy();
        rerender(
            <ReactFlowProvider>
                <GhostStepNode data={{ draft: stepDraft({ partial: false }) }} />
            </ReactFlowProvider>,
        );
        expect(screen.queryByTestId('ghost-step-caret')).toBeNull();
    });

    it('no name yet: the placeholder caption wipes in (keyed on its text) and no pill for a single card', () => {
        const { rerender } = renderGhost({ draft: stepDraft({ label: null, caption: 'Placing Gmail…', count: 1, stepOf: null }) });
        const cap = screen.getByTestId('ghost-step-caption');
        expect(cap.textContent).toBe('Placing Gmail…');
        expect(cap.className).toContain('bf-rv-sub');
        expect(screen.queryByTestId('ghost-step-label')).toBeNull();
        expect(screen.queryByTestId('ghost-step-pill')).toBeNull();
        // The same text again: no remount. A different text: the wipe replays on a new element.
        rerender(<ReactFlowProvider><GhostStepNode data={{ draft: stepDraft({ label: null, caption: 'Placing Gmail…', count: 1, stepOf: null }) }} /></ReactFlowProvider>);
        expect(screen.getByTestId('ghost-step-caption')).toBe(cap);
        rerender(<ReactFlowProvider><GhostStepNode data={{ draft: stepDraft({ label: null, caption: 'Writing the next step…', app: null, tool: null, count: 1, stepOf: null }) }} /></ReactFlowProvider>);
        expect(screen.getByTestId('ghost-step-caption')).not.toBe(cap);
    });

    it('a kind step without an app shows the kind\'s own icon in its family tile', () => {
        renderGhost({ draft: stepDraft({ app: null, tool: null, type: 'condition', typeLabel: 'Condition', label: 'If overdue', caption: 'If overdue', count: 1, stepOf: null }) });
        const tile = screen.getByTestId('ghost-step-tile');
        expect(tile.getAttribute('data-family')).toBe('branch');
        expect(tile.querySelector('svg')).toBeTruthy();
    });

    it('an activity (inspect, test, plan…) is the caption with the kind\'s icon and the dots, no label, no pill', () => {
        renderGhost({ draft: { kind: 'inspect', app: { id: 'gmail', name: 'Gmail' }, tool: 'gmail_send', type: null, typeLabel: null, label: null, partial: true, index: 1, count: 1, stepOf: null, caption: 'Looking at Gmail…' } });
        expect(screen.getByTestId('ghost-step').getAttribute('data-draft-kind')).toBe('inspect');
        expect(screen.getByTestId('ghost-step-caption').textContent).toBe('Looking at Gmail…');
        expect(screen.queryByTestId('ghost-step-label')).toBeNull();
        expect(screen.queryByTestId('ghost-step-pill')).toBeNull();
        cleanup();
        const { container } = renderGhost({ draft: { kind: 'testing', app: null, tool: null, type: null, typeLabel: null, label: null, partial: true, index: 0, count: 0, stepOf: null, caption: 'Running a test…' } });
        expect(screen.getByTestId('ghost-step-caption').textContent).toBe('Running a test…');
        expect(screen.getByTestId('ghost-step-tile').querySelector('svg')).toBeTruthy();
        expect(container.querySelectorAll('.animate-bounce').length).toBe(3);
    });

    it('draft: null is the legacy slot, exactly', () => {
        renderGhost({ caption: 'One', synthetic: true, draft: null });
        const root = screen.getByTestId('ghost-step');
        expect(root.style.border).toBe('1.5px dashed var(--border-default)');
        expect(root.style.opacity).toBe('0.7');
        expect(screen.getByTestId('ghost-step-caption').textContent).toBe('One');
        expect(screen.queryByTestId('ghost-step-tile')).toBeNull();
    });
});
