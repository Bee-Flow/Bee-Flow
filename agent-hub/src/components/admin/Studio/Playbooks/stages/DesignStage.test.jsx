import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DesignStage from './DesignStage';

const t = (k, f, v) => (v ? Object.entries(v).reduce((s, [a, b]) => s.replace(`{${a}}`, String(b)), f) : f);
const DESIGN = {
    name: 'Facturen', tagline: 'Alles in één oogopslag',
    look: { preset: 'cloud', accent: '#1e7f4f', mood: 'kalm, precies' },
    screens: [
        { name: 'Overzicht', purpose: 'Het totaal zien', sections: [{ title: 'Kerncijfers', layout: 'row', elements: [{ kind: 'stat', label: 'Aantal' }, { kind: 'chart', label: 'Per maand' }, { kind: 'filters', label: 'Filters' }, { kind: 'table', label: 'Facturen' }] }] },
        { name: 'Factuur', sections: [{ title: 'Details', layout: 'stack', elements: [{ kind: 'detail', label: 'Factuur' }, { kind: 'button', label: 'Ter goedkeuring' }] }] },
    ],
    principles: ['Eén accentkleur', 'Ruimte'],
};

afterEach(() => cleanup());

describe('DesignStage — the designer\'s answer as wireframes', () => {
    it('starts a ready phase once and shows the designer is thinking', () => {
        const dispatch = vi.fn();
        const { rerender } = render(<DesignStage phase={{ key: 'design', status: 'ready', attempt: 0, artifacts: {} }} dispatch={dispatch} t={t} />);
        expect(dispatch).toHaveBeenCalledWith({ type: 'start', key: 'design' });
        rerender(<DesignStage phase={{ key: 'design', status: 'ready', attempt: 0, artifacts: {} }} dispatch={dispatch} t={t} />);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(screen.getByText(/thinks about this app as a designer first/)).toBeTruthy();
    });

    it('draws one card per screen, an element glyph per kind, the look chip and the principles — no builder words', () => {
        render(<DesignStage phase={{ key: 'design', status: 'awaiting', attempt: 0, artifacts: { design: DESIGN, designName: 'Facturen', screenCount: 2, elementCount: 6 } }} dispatch={vi.fn()} t={t} reducedMotion />);
        const screens = screen.getAllByTestId('playbook-design-screen');
        expect(screens).toHaveLength(2);
        expect(screens[0].textContent).toContain('Overzicht');
        expect(screens[0].textContent).toContain('Het totaal zien');
        expect(screens[0].querySelectorAll('[data-kind]').length).toBe(4);
        expect(screens[0].querySelector('[data-kind="chart"]')).toBeTruthy();
        expect(screens[1].querySelector('[data-kind="button"]').textContent).toBe('Ter goedkeuring');
        expect(screen.getByTestId('playbook-design-look').textContent).toContain('Look cloud · kalm, precies');
        expect(screen.getByTestId('playbook-design-look').textContent).toContain('2 screens · 6 elements');
        expect(screen.getByTestId('playbook-design-principles').textContent).toContain('Eén accentkleur');
        expect(document.body.textContent).not.toMatch(/data_grid|filter_bar|app_set_theme/);
    });

    it('asks for a change: the whole design goes back to the designer, the stage says it is redrawing, and a refusal is said out loud', async () => {
        const dispatch = vi.fn(async () => ({ id: 'pb_1' }));
        const phase = { key: 'design', status: 'awaiting', attempt: 0, artifacts: { design: DESIGN, designName: 'Facturen', screenCount: 2, elementCount: 6, revisions: ['Zet de totalen bovenaan'] } };
        render(<DesignStage phase={phase} dispatch={dispatch} t={t} reducedMotion />);
        const input = screen.getByTestId('playbook-design-revise-input');
        // Nothing typed, nothing sent.
        expect(screen.getByTestId('playbook-design-revise-send').disabled).toBe(true);
        fireEvent.change(input, { target: { value: '  Geef elke leverancier een eigen scherm  ' } });
        await act(async () => { fireEvent.click(screen.getByTestId('playbook-design-revise-send')); });
        expect(dispatch).toHaveBeenCalledWith({ type: 'revise', key: 'design', feedback: 'Geef elke leverancier een eigen scherm' });
        await waitFor(() => expect(screen.getByTestId('playbook-design-revise-input').value).toBe(''));
        // What was asked before stays on screen.
        expect(screen.getByTestId('playbook-design-revisions').textContent).toContain('Zet de totalen bovenaan');

        // The server refused: the design that stands is still there, with a word about it.
        dispatch.mockResolvedValueOnce(null);
        fireEvent.change(screen.getByTestId('playbook-design-revise-input'), { target: { value: 'Maak het donker' } });
        await act(async () => { fireEvent.click(screen.getByTestId('playbook-design-revise-send')); });
        await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not redraw it/));
        expect(screen.getAllByTestId('playbook-design-screen')).toHaveLength(2);
    });

    it('a design still being drawn cannot be revised yet', () => {
        render(<DesignStage phase={{ key: 'design', status: 'running', attempt: 0, artifacts: {} }} dispatch={vi.fn()} t={t} />);
        expect(screen.queryByTestId('playbook-design-revise')).toBeNull();
    });
});
