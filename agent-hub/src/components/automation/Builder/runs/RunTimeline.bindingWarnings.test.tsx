import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RunStepRecord } from '../../../../api/queries/automation/runs';
import RunTimeline from './RunTimeline';

const MISS = { field: 'to', kind: 'ref', path: 'steps.read.output.contact.email', reason: 'missing', count: 4 };
const definition = {
    trigger: { id: 't1', type: 'trigger', kind: 'manual' },
    steps: [{ id: 'read', type: 'action', label: 'Read the purchasing inbox' }, { id: 'mail', type: 'action', label: 'Send the reply' }],
};
const steps = [
    { stepId: 'read', stepType: 'action', status: 'success', output: { ok: 1 } },
    { stepId: 'mail', stepType: 'action', status: 'success', output: { sent: true }, bindingWarnings: [MISS, { ...MISS, field: 'cc' }] },
] as RunStepRecord[];

beforeEach(() => cleanup());

describe('What happened: a step whose mappings found nothing says so on its card', () => {
    it('counts the inputs, not the items they missed on', () => {
        render(
            <RunTimeline run={{ id: 'r1', status: 'success' }} steps={steps} definition={definition}
                selectedStepId={null} onSelectStep={vi.fn()} onViewCanvas={vi.fn()} />,
        );
        const mail = screen.getByRole('button', { name: /Send the reply/ });
        expect(mail.textContent).toContain('2 mappings found nothing');
        const readCard = screen.getByRole('button', { name: /Read the purchasing inbox/ });
        expect(readCard.textContent).not.toContain('found nothing');
    });

    it('one miss reads in the singular', () => {
        const one = [{ ...steps[1], bindingWarnings: [MISS] }] as unknown as RunStepRecord[];
        render(
            <RunTimeline run={{ id: 'r1', status: 'success' }} steps={one} definition={definition}
                selectedStepId={null} onSelectStep={vi.fn()} onViewCanvas={vi.fn()} />,
        );
        expect(screen.getByRole('button', { name: /Send the reply/ }).textContent).toContain('1 mapping found nothing');
    });
});
