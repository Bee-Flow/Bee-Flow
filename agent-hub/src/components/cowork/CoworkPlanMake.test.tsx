// "Make a plan": the button, the plan as it is drafted, stopping, and a failure. Everything comes in as props, so
// nothing is mocked.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import CoworkPlanMake from './CoworkPlanMake';
import { afterProgress } from '@/hooks/useCoworkPlanMaker';
import type { PlanMaking } from '@/hooks/useCoworkPlanMaker';
import { englishT as t } from './coworkPlan.fixture';

const IDLE: PlanMaking = { running: false, phase: null, steps: [], summary: '', error: null };

function renderMake(making: Partial<PlanMaking> = {}) {
    const onMake = vi.fn();
    const onCancel = vi.fn();
    render(<CoworkPlanMake t={t} making={{ ...IDLE, ...making }} onMake={onMake} onCancel={onCancel} />);
    return { onMake, onCancel };
}

describe('CoworkPlanMake', () => {
    it('says what making a plan does and that nothing runs before approval, and offers it', async () => {
        const { onMake } = renderMake();
        expect(screen.getByText(/Nothing runs until you have looked at the plan and approved it/)).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: 'Make a plan' }));
        expect(onMake).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('cowork-plan-making')).toBeNull();
    });

    it('while the plan is drafted: what it is doing, the steps so far with their kind, and a way to stop', async () => {
        const { onCancel } = renderMake({
            running: true, phase: 'drafted',
            steps: [{ id: 'mail', title: 'Get the new supplier mail', kind: 'fixed' }, { id: 'sum', title: 'Say what is overdue', kind: 'ai' }],
        });
        expect(screen.getByRole('status').textContent).toBe('Drafting the plan…');
        expect(screen.getByTestId('cowork-plan-making-step-mail').textContent).toContain('Get the new supplier mail');
        expect(screen.getByTestId('cowork-plan-making-step-mail').textContent).toContain('Fixed');
        expect(screen.getByTestId('cowork-plan-making-step-sum').textContent).toContain('AI');
        expect(screen.queryByRole('button', { name: 'Make a plan' })).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('names each phase in words', () => {
        renderMake({ running: true, phase: 'thinking' });
        expect(screen.getByRole('status').textContent).toBe('Working out the steps…');
    });

    it('a failure shows its sentence, or a plain one when it came without, and the plan can be made again', () => {
        renderMake({ error: 'No plan could be made for this brief. No calendar is connected.' });
        expect(screen.getByRole('alert').textContent).toBe('No plan could be made for this brief. No calendar is connected.');
        expect(screen.getByRole('button', { name: 'Make a plan' })).toBeTruthy();
    });

    it('a failure without a sentence still says so', () => {
        renderMake({ error: '' });
        expect(screen.getByRole('alert').textContent).toBe('The plan could not be made. Try again.');
    });
});

describe('afterProgress', () => {
    it('keeps the steps of the draft through the phases that carry none', () => {
        const steps = [{ id: 'a', title: 'Get the mail', kind: 'fixed' as const }];
        let making: PlanMaking = { ...IDLE, running: true, phase: 'thinking' };
        making = afterProgress(making, { phase: 'drafted', round: 1, steps });
        expect([making.phase, making.steps]).toEqual(['drafted', steps]);
        making = afterProgress(making, { phase: 'thinking', round: 2 });
        expect([making.phase, making.steps]).toEqual(['thinking', steps]);
        making = afterProgress(making, { phase: 'saving' });
        expect([making.phase, making.steps, making.running]).toEqual(['saving', steps, true]);
    });
});
