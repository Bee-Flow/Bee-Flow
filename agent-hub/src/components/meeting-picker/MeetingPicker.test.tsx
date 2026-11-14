import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeetingPicker from './MeetingPicker';
import { renderWithClient } from '@/test/render';

/**
 * The picker feeds notebook sources and template context. A note still
 * transcribing has no text, and a failed one keeps the failure reason in its
 * summary, so picking either added 'Transcription failed: ...' as a source.
 * Those rows are disabled, as in the library's select mode, and the hover
 * preview comes from the list's summarySnippet instead of a full-note fetch.
 */
const ROWS = [
    { id: 'p1', title: 'Still transcribing', status: 'processing', createdAt: '2026-11-01T10:00:00Z', durationSeconds: 60, speakerCount: 0 },
    { id: 'f1', title: 'Broken upload', status: 'failed', summarySnippet: 'Transcription failed: boom', createdAt: '2026-11-01T10:00:00Z', durationSeconds: 60, speakerCount: 0 },
    { id: 'c1', title: 'Weekly sync', status: 'completed', summarySnippet: 'We agreed on the roadmap.', createdAt: '2026-11-01T10:00:00Z', durationSeconds: 60, speakerCount: 2 },
];

function stubList() {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ transcriptions: ROWS }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('MeetingPicker only offers notes that are ready', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('does not select a processing or failed note in single mode', async () => {
        stubList();
        const user = userEvent.setup();
        const onSelect = vi.fn();
        renderWithClient(<MeetingPicker mode="single" onSelect={onSelect} />);
        const processing = (await screen.findByText('Still transcribing')).closest('button')!;
        const failed = screen.getByText('Broken upload').closest('button')!;
        expect(processing).toBeDisabled();
        expect(failed).toBeDisabled();
        expect(failed).toHaveAttribute('title', 'This meeting is not ready yet');
        await user.click(processing);
        await user.click(failed);
        expect(onSelect).not.toHaveBeenCalled();
        await user.click(screen.getByText('Weekly sync'));
        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
    });

    it('does not add a processing note to the multi selection', async () => {
        stubList();
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderWithClient(<MeetingPicker mode="multi" value={[]} onChange={onChange} />);
        await user.click(await screen.findByText('Still transcribing'));
        expect(onChange).not.toHaveBeenCalled();
        await user.click(screen.getByText('Weekly sync'));
        expect(onChange).toHaveBeenCalledWith(['c1']);
    });

    it('previews from the list snippet without fetching the full note', async () => {
        const fetchMock = stubList();
        const user = userEvent.setup();
        renderWithClient(<MeetingPicker mode="single" onSelect={() => {}} />);
        await user.hover(await screen.findByText('Weekly sync'));
        expect(screen.getByText('We agreed on the roadmap.')).toBeInTheDocument();
        await user.hover(screen.getByText('Broken upload'));
        expect(screen.queryByText(/Transcription failed/)).not.toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
