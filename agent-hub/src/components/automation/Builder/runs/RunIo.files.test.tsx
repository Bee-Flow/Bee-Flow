import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RunStepRecord } from '../../../../api/queries/automation/runs';
import RunIo from './RunIo';

vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

const row = (output: unknown) => ({
    runId: 'run-1', stepId: 'doc', stepType: 'generate_document', status: 'success', input: {}, output,
}) as RunStepRecord;

beforeEach(() => cleanup());

describe('Runs tab: a step that kept a file', () => {
    it('shows the file as a chip next to the output', () => {
        render(<RunIo step={row({
            fileId: 'f1', filename: 'Quote.pdf', mimeType: 'application/pdf', size: 1024,
            sourceHandle: { kind: 'generated_file', fileId: 'f1' },
        })} label="Make the quote" />);
        expect(screen.getByTestId('run-file-chip').textContent).toContain('Quote.pdf');
    });

    it('shows no chip for a step without a file', () => {
        render(<RunIo step={row({ sent: true })} label="Send" />);
        expect(screen.queryByTestId('run-file-chip')).toBeNull();
    });
});
