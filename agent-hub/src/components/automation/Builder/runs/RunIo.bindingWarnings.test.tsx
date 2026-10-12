import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import type { RunStepRecord } from '../../../../api/queries/automation/runs';
import RunIo from './RunIo';

const MISS = {
    field: 'to', kind: 'template', path: 'steps.read.output.contact.email', reason: 'not_run', step: 'read', count: 1,
    description: 'input "to" read steps.read.output.contact.email, but step "read" has not run in this run',
};
const labelById = new Map([['read', 'Read the purchasing inbox'], ['mail', 'Send the reply']]);
const row = (over: Record<string, unknown> = {}) => ({
    stepId: 'mail', stepType: 'action', status: 'success', input: { to: '' }, output: { sent: true }, ...over,
}) as RunStepRecord;

beforeEach(() => cleanup());

describe('Runs tab: a step\'s in and out', () => {
    it('says which mappings found nothing, by name', () => {
        render(<RunIo step={row({ bindingWarnings: [MISS] })} label="Send the reply" labelById={labelById} />);
        const block = screen.getByTestId('output-binding-warnings');
        expect(block.textContent).toContain('To');
        expect(block.textContent).toContain('Read the purchasing inbox ▸ Contact ▸ Email');
        expect(block.textContent).toContain('that step did not run');
        expect(screen.getByRole('button', { name: /To/ }).getAttribute('title')).toBe(MISS.description);
    });

    it('shows nothing extra when every mapping found something', () => {
        render(<RunIo step={row()} label="Send the reply" labelById={labelById} />);
        expect(screen.queryByTestId('output-binding-warnings')).toBeNull();
    });
});
