import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

import TemplateFillCard from './TemplateFillCard';
import { templateFillStates } from './templateFillResults';

/**
 * The card under an answer that fills in a template: progress while the
 * assistant asks, the download and "Open in Documents" once it finished. It
 * reads the turn's tool results; the latest answer per document wins.
 */

const START = { name: 'template_fill_start', result: { documentId: 'd1', name: 'Offer Van Dijk', url: '/app/studio/documents/d1', filled: 0, total: 6, missingRequired: [{ key: 'client', label: 'Client name' }, { key: 'amount', label: 'Amount' }] } };
const SET = { name: 'template_fill_set_values', result: JSON.stringify({ documentId: 'd1', name: 'Offer Van Dijk', url: '/app/studio/documents/d1', filled: 4, total: 6, missingRequired: [{ key: 'amount', label: 'Amount' }] }) };
const FINISH = { name: 'template_fill_finish', result: { documentId: 'd1', name: 'Offer Van Dijk', url: '/app/studio/documents/d1', filled: 6, total: 6, missingRequired: [], finished: true, format: 'pdf' } };

describe('templateFillStates', () => {
    it('keeps one state per document, the latest answer winning, and skips errors and other tools', () => {
        const states = templateFillStates([START, { name: 'web_search', result: { documentId: 'x' } }, SET,
            { name: 'template_fill_set_values', result: { error: 'Document is read-only.' } }]);
        expect(states).toEqual([expect.objectContaining({ documentId: 'd1', filled: 4, total: 6, missing: ['Amount'], finished: false })]);
        expect(templateFillStates(undefined)).toEqual([]);
    });
});

describe('<TemplateFillCard>', () => {
    it('shows the progress and what is still needed while filling in', () => {
        render(<TemplateFillCard toolResults={[START, SET]} />);
        expect(screen.getByTestId('template-fill-card').textContent).toContain('Offer Van Dijk');
        expect(screen.getByTestId('template-fill-progress').textContent).toBe('4 of 6 fields filled in');
        expect(screen.getByText('Still needed: Amount')).toBeInTheDocument();
        expect(screen.queryByTestId('template-fill-download')).not.toBeInTheDocument();
    });

    it('offers the download and the document once finished', async () => {
        const user = userEvent.setup();
        const download = vi.fn().mockResolvedValue(undefined);
        render(<TemplateFillCard toolResults={[START, SET, FINISH]} download={download} />);
        expect(screen.getByTestId('document-link-card').textContent).toContain('Open in Documents');
        await user.click(screen.getByTestId('template-fill-download'));
        expect(download).toHaveBeenCalledWith('d1', 'Offer Van Dijk', 'pdf');
    });

    it('offers PowerPoint for a presentation, and says so when the download fails', async () => {
        const user = userEvent.setup();
        const download = vi.fn().mockRejectedValue(new Error('nope'));
        render(<TemplateFillCard toolResults={[{ ...FINISH, result: { ...FINISH.result, format: 'pptx' } }]} download={download} />);
        await user.click(screen.getByText('Download PowerPoint'));
        expect(download).toHaveBeenCalledWith('d1', 'Offer Van Dijk', 'pptx');
        expect(await screen.findByRole('alert')).toHaveTextContent('The download failed. Try again.');
    });

    it('renders nothing for a turn without template results', () => {
        const { container } = render(<TemplateFillCard toolResults={[{ name: 'web_search', result: {} }]} />);
        expect(container).toBeEmptyDOMElement();
    });
});
