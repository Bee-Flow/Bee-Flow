import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetailDrawer } from './DetailDrawer';

vi.mock('../../../hooks/useTranslation', () => import('@/test/useTranslationParamsMock'));

const recent = [
    { model: 'gpt-x', agent_name: 'Helper', prompt_tokens: 1000, completion_tokens: 500, duration_ms: 1500 },
    { model: 'other', agent_name: 'Helper', prompt_tokens: 10, completion_tokens: 5 },
];

afterEach(cleanup);

describe('DetailDrawer', () => {
    it('shows a model with its rates, estimate and its own recent calls', async () => {
        const onClose = vi.fn();
        render(
            <DetailDrawer
                detail={{ type: 'model', data: { model: 'gpt-x', calls: 1200, total_tokens: 1500, prompt_tokens: 1000, completion_tokens: 500 } }}
                modelCosts={{ 'gpt-x': { input: 2, output: 8 } }}
                costPerModel={{ 'gpt-x': 0.5 }}
                recent={recent}
                onClose={onClose}
            />,
        );
        expect(screen.getByText('Model Details')).toBeTruthy();
        expect(screen.getByText('1.2K')).toBeTruthy();
        expect(screen.getByText('Est. Cost')).toBeTruthy();
        expect(screen.getByText('$2/1M tokens')).toBeTruthy();
        expect(screen.getByText('Recent Calls (1)')).toBeTruthy();
        expect(screen.getByText('1.5s')).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: '×' }));
        expect(onClose).toHaveBeenCalled();
    });

    it('shows the billed cost and the agent type for a pay-as-you-go agent', () => {
        render(
            <DetailDrawer
                detail={{ type: 'agent', data: { agent_name: 'Helper', agent_type: 'system', billed_cost: 3, estimated_cost: 1 } }}
                modelCosts={{}}
                costPerModel={{}}
                recent={recent}
                onClose={vi.fn()}
            />,
        );
        expect(screen.getByText('Agent Details')).toBeTruthy();
        expect(screen.getByText('$3.00')).toBeTruthy();
        expect(screen.getByText('Billed (raw $1.00)')).toBeTruthy();
        expect(screen.getByText('system')).toBeTruthy();
        expect(screen.getByText('Recent Calls (2)')).toBeTruthy();
    });
});
