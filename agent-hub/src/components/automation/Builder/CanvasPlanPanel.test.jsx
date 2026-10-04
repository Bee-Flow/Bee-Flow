import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import CanvasPlanPanel from './CanvasPlanPanel';

const t = (k, f) => f;
const TODOS = [{ text: 'Link the table', done: true }, { text: 'Add the tiles', done: false }];

afterEach(() => cleanup());

describe('CanvasPlanPanel — open while it builds, out of the way after', () => {
    it('is open during a build and folds to a pill when the AI stops, finished or not', () => {
        const { rerender } = render(<CanvasPlanPanel todos={TODOS} running t={t} />);
        expect(screen.getByTestId('builder-plan-panel').textContent).toContain('Link the table');

        // The turn ends with one item still open — it still gets out of the way
        // (owner, 2026-09-16: it was covering the app preview).
        rerender(<CanvasPlanPanel todos={TODOS} running={false} t={t} />);
        expect(screen.queryByTestId('builder-plan-panel')).toBeNull();
        const pill = screen.getByTestId('builder-plan-pill');
        expect(pill.textContent).toContain('1/2');

        // And it is one press away.
        fireEvent.click(pill);
        expect(screen.getByTestId('builder-plan-panel')).toBeTruthy();

        // A NEW turn opens it again by itself.
        fireEvent.click(screen.getByTestId('builder-plan-hide'));
        expect(screen.queryByTestId('builder-plan-panel')).toBeNull();
        rerender(<CanvasPlanPanel todos={TODOS} running t={t} />);
        expect(screen.getByTestId('builder-plan-panel')).toBeTruthy();
    });

    it('a build that starts stopped shows the pill, and an empty plan shows nothing', () => {
        const { rerender } = render(<CanvasPlanPanel todos={TODOS} running={false} t={t} />);
        expect(screen.getByTestId('builder-plan-pill')).toBeTruthy();
        rerender(<CanvasPlanPanel todos={[]} running t={t} />);
        expect(screen.queryByTestId('builder-plan-pill')).toBeNull();
        expect(screen.queryByTestId('builder-plan-panel')).toBeNull();
    });

    it('the app editor gets its own test ids — and hangs at the BOTTOM, off the component being written', () => {
        const { rerender } = render(<CanvasPlanPanel todos={TODOS} running t={t} idPrefix="app" placement="bottom-left" />);
        const panel = screen.getByTestId('app-plan-panel');
        expect(panel.className).toContain('bottom-3');
        expect(panel.className).not.toContain('top-3');
        // The pill follows it.
        rerender(<CanvasPlanPanel todos={TODOS} running={false} t={t} idPrefix="app" placement="bottom-left" />);
        expect(screen.getByTestId('app-plan-pill').className).toContain('bottom-3');
        // The automation canvas keeps the top, under its step chips.
        cleanup();
        render(<CanvasPlanPanel todos={TODOS} running t={t} />);
        expect(screen.getByTestId('builder-plan-panel').className).toContain('top-3');
    });
});
