import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ScanFlow, { ScanDetails } from './ScanFlow';
import { IDLE_RUN } from './useRepeatingScan';
import type { RunState, SourceStep } from './useRepeatingScan';

const labelFor = (id: string) => ({ gmail: 'Gmail', nextcloud: 'Files' } as Record<string, string>)[id] || id;
const step = (over: Partial<SourceStep>): SourceStep => ({
    key: 'mail:gmail', source: 'mail', app: 'gmail', status: 'start', events: null, reason: null, piiCategories: [], ...over,
});
const running = (over: Partial<RunState> = {}): RunState => ({ ...IDLE_RUN, scanning: true, ...over });

function renderFlow(run: RunState, over: { detailsOpen?: boolean } = {}) {
    const onToggleDetails = vi.fn();
    const onStop = vi.fn();
    render(<ScanFlow run={run} labelFor={labelFor} detailsOpen={!!over.detailsOpen} onToggleDetails={onToggleDetails} onStop={onStop} />);
    return { onToggleDetails, onStop };
}

const nodeStatuses = () => within(screen.getByTestId('scan-flow')).getAllByTestId('mini-node').map(n => n.getAttribute('data-status'));

describe('ScanFlow', () => {
    it('draws the four steps and says what it reads now', () => {
        renderFlow(running({ phase: 'collecting', steps: [step({})] }));
        const flow = within(screen.getByTestId('scan-flow'));
        for (const name of ['Read your work', 'Find templates', 'Spot repeats', 'Name patterns']) expect(flow.getByText(name)).toBeTruthy();
        expect(nodeStatuses()).toEqual(['running', 'idle', 'idle', 'idle']);
        expect(screen.getByRole('status')).toHaveTextContent('Reading Gmail…');
    });

    it('moves the running ring along with the phase and puts the counts on the lines', () => {
        renderFlow(running({
            phase: 'naming',
            steps: [step({ status: 'done', events: 412 })],
            stats: { events: 412, templates: 9, candidates: 3 },
            streamed: [{ id: 'p1', title: 'One' }],
        }));
        expect(nodeStatuses()).toEqual(['done', 'done', 'done', 'running']);
        // A connector draws its pill twice (across and down; CSS shows one).
        const flow = within(screen.getByTestId('scan-flow'));
        for (const pill of ['412 events', '9 templates', '3 repeats', '1 pattern']) expect(flow.getAllByText(pill).length).toBeGreaterThan(0);
        expect(flow.getByText('1 source read')).toBeTruthy();
        expect(screen.getByRole('status')).toHaveTextContent('Naming the patterns…');
    });

    it('Stop and Show details are the only controls', async () => {
        const user = userEvent.setup();
        const { onStop, onToggleDetails } = renderFlow(running({ steps: [step({})] }));
        await user.click(screen.getByRole('button', { name: 'Show details' }));
        expect(onToggleDetails).toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Stop' }));
        expect(onStop).toHaveBeenCalled();
    });

    it('has no details toggle before anything was read', () => {
        renderFlow(running());
        expect(screen.queryByRole('button', { name: 'Show details' })).toBeNull();
        expect(screen.getByRole('status')).toHaveTextContent('Starting the scan…');
    });

    it('the ideas fallback gets the sentence, not the four steps', () => {
        renderFlow(running({ mode: 'ideas', phase: 'synthesising' }));
        expect(screen.queryByTestId('scan-flow')).toBeNull();
        expect(screen.getByRole('status')).toHaveTextContent('Looking for patterns in what Bee read…');
    });
});

describe('ScanDetails', () => {
    it('lists each source by app name, with counts, the Shield verdict and no tool names', () => {
        render(<ScanDetails labelFor={labelFor} steps={[
            step({ status: 'done', events: 40, piiCategories: ['Person'] }),
            step({ key: 'files:nextcloud', source: 'files', app: 'nextcloud', status: 'skipped', reason: 'timeout' }),
            step({ key: 'gmail_search', source: null, app: 'gmail', status: 'start' }),
        ]} />);
        const log = screen.getByTestId('scan-log');
        expect(log).toHaveTextContent('Read Gmail · 40 events');
        expect(log).toHaveTextContent('Skipped Files · took too long');
        expect(log).toHaveTextContent('Reading Gmail');
        expect(within(log).getByText('Person')).toBeTruthy();
        expect(log.textContent).not.toMatch(/gmail_search|gmail search/);
    });

    it('says the Privacy Shield skipped a source when no other reason is given', () => {
        render(<ScanDetails labelFor={labelFor} steps={[step({ status: 'skipped' })]} />);
        expect(screen.getByTestId('scan-log')).toHaveTextContent('Skipped Gmail · blocked by Privacy Shield');
    });

    it('puts every reason code the server sends into words, and never shows an unknown code raw', () => {
        const codes = ['auth', 'budget', 'shield', 'not_connected', 'error', 'aborted', 'some_new_code'];
        render(<ScanDetails labelFor={labelFor} steps={codes.map(reason => step({ key: reason, app: reason, status: 'skipped', reason }))} />);
        const log = screen.getByTestId('scan-log');
        expect(log).toHaveTextContent('Skipped auth · needs to be connected again');
        expect(log).toHaveTextContent('Skipped budget · the scan ran out of time');
        expect(log).toHaveTextContent('Skipped shield · blocked by Privacy Shield');
        expect(log).toHaveTextContent('Skipped not_connected · not connected');
        expect(log).toHaveTextContent('Skipped aborted · could not be read');
        expect(log).toHaveTextContent('Skipped some_new_code · could not be read');
        expect(log.textContent).not.toMatch(/· (?:auth|budget|aborted|some_new_code)\b/);
    });

    it('renders nothing without steps', () => {
        render(<ScanDetails labelFor={labelFor} steps={[]} />);
        expect(screen.queryByTestId('scan-log')).toBeNull();
    });
});
