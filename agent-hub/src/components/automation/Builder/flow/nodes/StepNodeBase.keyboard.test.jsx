import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import StepNodeBase from './StepNodeBase';
import { NodeRuntimeContext } from '../NodeRuntimeContext';

/**
 * A step you can reach with Tab and cannot open with the keyboard.
 *
 * The card has carried `tabIndex={0}` since the redesign, so it takes focus —
 * and a step is OPENED by React Flow's `onNodeClick` (DiagramPane), which is a
 * mouse event on the wrapper this card sits inside. There was no key handler
 * anywhere between the two. So a keyboard-only user could Tab across every
 * step on the canvas and enter none of them: the five action buttons on the
 * card are individually reachable, but the step itself — the thing the whole
 * canvas exists to open — was not.
 *
 * It was also announced as nothing. A focusable element with no role and no
 * accessible name reads as "group" or as its own text content, so eleven
 * e-mail steps were eleven identical announcements.
 *
 * `.click()` rather than a second open-path on purpose: the click bubbles to
 * React Flow's own handler, so the keyboard does exactly what the mouse does
 * and cannot drift from it.
 */
function renderCard(props = {}) {
    return render(
        <ReactFlowProvider>
            <NodeRuntimeContext.Provider value={{
                pinnedById: new Set(), disabledById: new Set(), triggerIds: new Set(), attachedIds: new Set(),
                typeGroupById: new Map([['s7', 'ai']]),
                stepTypeById: new Map([['s7', 'ai_step']]),
                stepNumberById: new Map([['s7', 7]]),
            }}>
                <StepNodeBase nodeId="s7" icon={null} typeLabel="AI step" name="Forecast" sub="3 years" {...props} />
            </NodeRuntimeContext.Provider>
        </ReactFlowProvider>,
    );
}

const card = () => screen.getByRole('button', { name: /Forecast/ });

describe('a step card can be opened from the keyboard', () => {
    beforeEach(() => cleanup());

    it('is a button with the step\'s own name, not an unnamed focusable div', () => {
        renderCard();
        const el = card();
        expect(el.getAttribute('tabindex')).toBe('0');
        // Name first, then type: the name is what tells one step from the next,
        // and a canvas of eleven "Send e-mail"s is no list at all.
        expect(el.getAttribute('aria-label')).toBe('Forecast, AI step');
    });

    it('falls back to the type, then to a plain word — never to no name at all', () => {
        cleanup();
        renderCard({ name: null });
        expect(screen.getByRole('button', { name: 'AI step' })).toBeTruthy();
        cleanup();
        renderCard({ name: null, typeLabel: null });
        expect(screen.getByRole('button', { name: 'Step' })).toBeTruthy();
    });

    it('Enter and Space click the card, which is what opens the step', () => {
        const onClick = vi.fn();
        const { container } = render(
            <ReactFlowProvider>
                {/* Stands in for React Flow's node wrapper: the click has to
                    BUBBLE to reach whoever opens the step. */}
                <div onClick={onClick}>
                    <NodeRuntimeContext.Provider value={{
                        pinnedById: new Set(), disabledById: new Set(), triggerIds: new Set(), attachedIds: new Set(),
                        typeGroupById: new Map(), stepTypeById: new Map(), stepNumberById: new Map(),
                    }}>
                        <StepNodeBase nodeId="s7" icon={null} typeLabel="AI step" name="Forecast" />
                    </NodeRuntimeContext.Provider>
                </div>
            </ReactFlowProvider>,
        );
        const el = screen.getByRole('button', { name: 'Forecast, AI step' });
        fireEvent.keyDown(el, { key: 'Enter' });
        expect(onClick).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(el, { key: ' ' });
        expect(onClick).toHaveBeenCalledTimes(2);
        // Anything else is left to the canvas — arrows pan, Del deletes, and
        // the five single-letter shortcuts live in DiagramPane.
        fireEvent.keyDown(el, { key: 'ArrowRight' });
        fireEvent.keyDown(el, { key: 'a' });
        expect(onClick).toHaveBeenCalledTimes(2);
        expect(container).toBeTruthy();
    });

    it('a key pressed on a control INSIDE the card does not re-open the step', () => {
        // The action buttons have their own handlers; Enter on "Delete step"
        // must delete, not open the step underneath it.
        const onClick = vi.fn();
        render(
            <ReactFlowProvider>
                <div onClick={onClick}>
                    <NodeRuntimeContext.Provider value={{
                        pinnedById: new Set(), disabledById: new Set(), triggerIds: new Set(), attachedIds: new Set(),
                        typeGroupById: new Map(), stepTypeById: new Map(), stepNumberById: new Map(),
                    }}>
                        <StepNodeBase nodeId="s7" icon={null} typeLabel="AI step" name="Forecast" onAddAfter={() => {}} />
                    </NodeRuntimeContext.Provider>
                </div>
            </ReactFlowProvider>,
        );
        const inner = screen.getByRole('button', { name: 'Add next step' });
        fireEvent.keyDown(inner, { key: 'Enter' });
        expect(onClick).not.toHaveBeenCalled();
    });
});
