import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { branchy, loopy } from '@/features/flow-editor/model/testing/fixtures';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { StepOutline, type StepOutlineProps } from './StepOutline';

jest.setTimeout(30_000);

const t = (_key: string, fallback: string, params?: Record<string, string | number>) =>
    fallback.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));

function props(over: Partial<StepOutlineProps> = {}): StepOutlineProps {
    return {
        definition: branchy,
        card: { t, issuesByStep: new Map([['act_a', { errors: [{ message: 'x' }], warnings: [] }]]) },
        locked: false,
        collapsed: new Set(),
        onOpen: jest.fn(),
        onMenu: jest.fn(),
        onAdd: jest.fn(),
        onToggleGroup: jest.fn(),
        ...over,
    };
}

describe('StepOutline', () => {
    it('draws a card per step, the lanes, and opens a card on a tap and its menu on a hold', async () => {
        const p = props();
        await renderWithProviders(<StepOutline {...p} />);
        expect(screen.getByText('match')).toBeTruthy();
        expect(screen.getByText('otherwise')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('step-card-act_a'));
        expect(p.onOpen).toHaveBeenCalledWith('act_a');
        await fireEvent(screen.getByTestId('step-card-cond_1'), 'longPress');
        expect(p.onMenu).toHaveBeenCalledWith('cond_1');
        // The finding's count rides on the card.
        expect(screen.getByLabelText(/1 problems to fix/)).toBeTruthy();
    });

    it('asks for a step where a "+" is tapped, and not while the AI builds', async () => {
        const p = props();
        await renderWithProviders(<StepOutline {...p} />);
        await fireEvent.press(screen.getAllByLabelText('Insert a step here')[0] as never);
        expect(p.onAdd).toHaveBeenCalledWith({ kind: 'splice', sourceId: 'trg', targetId: 'cond_1', identity: {} });
        const ends = screen.getAllByLabelText('Add a step');
        await fireEvent.press(ends[ends.length - 1] as never);
        expect(p.onAdd).toHaveBeenLastCalledWith({ kind: 'after', sourceId: 'notif_1', handle: null });

        const locked = props({ locked: true });
        await renderWithProviders(<StepOutline {...locked} />);
        await fireEvent.press(screen.getAllByLabelText('Insert a step here')[0] as never);
        expect(locked.onAdd).not.toHaveBeenCalled();
    });

    it('folds a loop body on its header', async () => {
        const p = props({ definition: loopy });
        await renderWithProviders(<StepOutline {...p} />);
        expect(screen.getByTestId('step-card-loop_1/b_set')).toBeTruthy();
        await fireEvent.press(screen.getByRole('button', { name: /For each item/ }));
        expect(p.onToggleGroup).toHaveBeenCalledWith('group:loop_1|body');
    });
});
