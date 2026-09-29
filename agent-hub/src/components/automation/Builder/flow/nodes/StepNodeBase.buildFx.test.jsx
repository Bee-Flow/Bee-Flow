import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The build-choreography flags on the card root (flow/useBuildChoreography.js
 * → NodeRuntimeContext → StepNodeBase).
 *
 * What is pinned: the card wears exactly one `data-build` value, taken from
 * the flag map first and the frontier second; the reveal delay and the family
 * ring travel as custom properties; the live outline is never claimed while a
 * run status is on the card (the stylesheet selects it with
 * `[data-build=live]:not([data-status])`, and the card mirrors that so the
 * attribute is not even written); and the summary-line wipe hook exists only
 * at near LOD.
 *
 * The store is mocked the way useZoomLod.test.jsx does it, so the zoom — and
 * with it the level of detail — can be set per test.
 */
let transform = [0, 0, 1];
vi.mock('@xyflow/react', async (importOriginal) => {
    const orig = await importOriginal();
    return { ...orig, useStore: (selector) => selector({ transform, nodeLookup: new Map() }) };
});

const { default: StepNodeBase } = await import('./StepNodeBase');
const { NodeRuntimeContext } = await import('../NodeRuntimeContext');
const { ReactFlowProvider } = await import('@xyflow/react');

function renderCard(rt = {}, props = {}) {
    return render(
        <ReactFlowProvider>
            <NodeRuntimeContext.Provider value={{
                pinnedById: new Set(), disabledById: new Set(), triggerIds: new Set(), attachedIds: new Set(),
                typeGroupById: new Map([['s7', 'ai']]),
                stepTypeById: new Map([['s7', 'ai_step']]),
                stepNumberById: new Map([['s7', 7]]),
                buildFxById: new Map(),
                frontierId: null,
                ...rt,
            }}>
                <StepNodeBase nodeId="s7" icon={null} typeLabel="AI step" name="Forecast" sub="banking & sector · 3 years" {...props} />
            </NodeRuntimeContext.Provider>
        </ReactFlowProvider>,
    );
}

const cardEl = (container) => container.querySelector('.group');

describe('StepNodeBase — build choreography flags', () => {
    beforeEach(() => { cleanup(); transform = [0, 0, 1]; });

    it('a fresh card carries data-build="fresh", its reveal delay as a <time> and the family ring', () => {
        const { container } = renderCard({ buildFxById: new Map([['s7', { kind: 'fresh', delayMs: 800, at: 1 }]]) });
        const card = cardEl(container);
        expect(card.getAttribute('data-build')).toBe('fresh');
        expect(card.style.getPropertyValue('--bf-reveal-delay')).toBe('800ms');
        expect(card.style.getPropertyValue('--bf-ring')).toBe('var(--type-ai)');
        // The chrome underneath is untouched.
        expect(card.style.border).toBe('1px solid var(--border-default)');
        expect(card.getAttribute('data-status')).toBeNull();
    });

    it('a touched card carries data-build="touched" with a zero delay', () => {
        const { container } = renderCard({ buildFxById: new Map([['s7', { kind: 'touched', delayMs: 0, at: 1, touchedAt: 2 }]]) });
        const card = cardEl(container);
        expect(card.getAttribute('data-build')).toBe('touched');
        expect(card.style.getPropertyValue('--bf-reveal-delay')).toBe('0ms');
    });

    it('the frontier carries data-build="live"', () => {
        const { container } = renderCard({ frontierId: 's7' });
        const card = cardEl(container);
        expect(card.getAttribute('data-build')).toBe('live');
        expect(card.style.getPropertyValue('--bf-ring')).toBe('var(--type-ai)');
    });

    it('a flag beats the frontier: a fresh card that is also live reveals first', () => {
        const { container } = renderCard({ frontierId: 's7', buildFxById: new Map([['s7', { kind: 'fresh', delayMs: 0, at: 1 }]]) });
        expect(cardEl(container).getAttribute('data-build')).toBe('fresh');
    });

    it('live + a running status: data-build is absent, data-status and cardChrome\'s outline stand', () => {
        const { container } = renderCard({ frontierId: 's7' }, { runStep: { status: 'running' } });
        const card = cardEl(container);
        expect(card.getAttribute('data-build')).toBeNull();
        expect(card.getAttribute('data-status')).toBe('running');
        expect(card.style.outline).toBe('3px solid var(--type-ai)');
        expect(card.style.getPropertyValue('--bf-reveal-delay')).toBe('');
    });

    it('live while a run is in flight: no outline claimed — the run vocabulary owns the canvas', () => {
        const { container } = renderCard({ frontierId: 's7', runInFlight: true });
        expect(cardEl(container).getAttribute('data-build')).toBeNull();
    });

    it('another card being the frontier leaves this one plain', () => {
        const { container } = renderCard({ frontierId: 's9', buildFxById: new Map([['s9', { kind: 'fresh', delayMs: 0, at: 1 }]]) });
        const card = cardEl(container);
        expect(card.getAttribute('data-build')).toBeNull();
        expect(card.style.getPropertyValue('--bf-ring')).toBe('');
    });

    it('the summary line is the wipe hook (bf-rv-sub) at near LOD only', () => {
        const { container } = renderCard({ buildFxById: new Map([['s7', { kind: 'fresh', delayMs: 0, at: 1 }]]) });
        expect(screen.getByTestId('node-sub').className).toContain('bf-rv-sub');
        cleanup();
        transform = [0, 0, 0.6]; // mid: name + summary, but the card-level fade carries the reveal
        const mid = renderCard({ buildFxById: new Map([['s7', { kind: 'fresh', delayMs: 0, at: 1 }]]) });
        expect(screen.getByTestId('node-sub').className).not.toContain('bf-rv-sub');
        expect(cardEl(mid.container).getAttribute('data-build')).toBe('fresh');
        void container;
    });

    it('a card with no flags and no frontier writes none of it', () => {
        const { container } = renderCard();
        const card = cardEl(container);
        expect(card.hasAttribute('data-build')).toBe(false);
        expect(card.style.getPropertyValue('--bf-reveal-delay')).toBe('');
        expect(card.style.getPropertyValue('--bf-ring')).toBe('');
    });
});
