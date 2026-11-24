// Creating a cowork takes one confirmation: the composer works the brief out (POST /api/cowork/compose), the card
// (./CoworkComposeCard.tsx) says it in one plain sentence with the apps it uses, and only Start creates it. Change puts
// what it showed back into the composer's chips, and the next send keeps it. The network is the seam (a recording
// fetch), no module is mocked.
import { useState } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkComposer from './CoworkComposer';
import CoworkComposeCard from './CoworkComposeCard';
import useCoworkComposer from './useCoworkComposer';
import type { CoworkItem } from '@/api/cowork.types';

const SPEC = { title: 'Answer supplier mails', prompt: 'Read the new supplier mails and draft an answer to each.', repeatInterval: 'weekly', daysOfWeek: ['tue'], timeOfDay: '06:30' };

let calls: RecordedCall[];
function serve() {
    calls = stubRecordingFetch(({ method, url }) => {
        if (method === 'POST' && url.endsWith('/api/cowork/compose')) return jsonResponse(SPEC);
        if (method === 'POST' && url.endsWith('/api/cowork')) return jsonResponse({ id: 'new', title: SPEC.title }, 201);
        return jsonResponse({});
    });
}
const creates = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/cowork'));

function Page({ onCreated }: { onCreated: (item: CoworkItem) => void }) {
    const [brief, setBrief] = useState('');
    const cowork = useCoworkComposer({ confirm: true, onCreated });
    return (
        <>
            <CoworkComposer value={brief} onChange={setBrief} onSubmit={() => { void cowork.submit(brief); }} cowork={cowork} />
            <CoworkComposeCard cowork={cowork} />
        </>
    );
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkComposeCard', () => {
    it('shows what was worked out as one card, and only Start creates it', async () => {
        serve();
        const onCreated = vi.fn();
        const user = userEvent.setup();
        renderWithClient(<Page onCreated={onCreated} />);
        await user.type(screen.getByTestId('cowork-brief-input'), 'Every Tuesday at 6:30 answer my supplier mails');
        await user.click(screen.getByTestId('cowork-send'));

        const card = await screen.findByTestId('cowork-compose-card');
        expect(screen.getByTestId('cowork-compose-sentence')).toHaveTextContent('Every Tuesday 06:30, the AI works on: “Read the new supplier mails and draft an answer to each”. It reports to you after each run.');
        expect(screen.getByTestId('cowork-compose-apps')).toBeInTheDocument();
        expect(card).toHaveTextContent('Answer supplier mails');
        expect(creates()).toHaveLength(0);

        await user.click(screen.getByTestId('cowork-compose-start'));
        await waitFor(() => expect(creates()).toHaveLength(1));
        expect(creates()[0]?.body).toMatchObject({ title: 'Answer supplier mails', repeatInterval: 'weekly', daysOfWeek: ['tue'], timeOfDay: '06:30' });
        await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
        expect(screen.queryByTestId('cowork-compose-card')).toBeNull();
    });

    it('Change closes the card, puts the schedule in the chips, and the next send keeps it', async () => {
        serve();
        const user = userEvent.setup();
        renderWithClient(<Page onCreated={vi.fn()} />);
        await user.type(screen.getByTestId('cowork-brief-input'), 'Every Tuesday at 6:30 answer my supplier mails');
        await user.click(screen.getByTestId('cowork-send'));
        await user.click(await screen.findByTestId('cowork-compose-change'));

        expect(screen.queryByTestId('cowork-compose-card')).toBeNull();
        expect(creates()).toHaveLength(0);
        // The chips now hold what the card showed: a dated first run, every week.
        expect(screen.getByTestId('cowork-send')).toHaveTextContent('Schedule');

        await user.click(screen.getByTestId('cowork-send'));
        await screen.findByTestId('cowork-compose-card');
        await user.click(screen.getByTestId('cowork-compose-start'));
        await waitFor(() => expect(creates()).toHaveLength(1));
        expect(creates()[0]?.body).toMatchObject({ repeatInterval: 'weekly', daysOfWeek: ['tue'], timeOfDay: '06:30' });
    });
});
