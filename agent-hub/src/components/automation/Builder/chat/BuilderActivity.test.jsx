import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import React from 'react';
import BuilderActivity from './BuilderActivity';

/**
 * The first test that has ever covered this chat column. Modelled on
 * AppStudio/chat/BuilderChatPane.test.jsx, which drives the same tool_call
 * shape and asserts the rendered copy.
 */
const call = (name, result, args = {}) => ({ name, arguments: args, result });
const added = (type, label, icon) => ({ added: { id: 's1', type, label, ...(icon ? { icon } : {}) } });

describe('BuilderActivity', () => {
    it('renders nothing when there are no calls', () => {
        const { container } = render(<BuilderActivity toolCalls={[]} />);
        expect(container.firstChild).toBeNull();
    });

    it('renders one row per call and names what was built', () => {
        render(<BuilderActivity toolCalls={[
            call('builder_add_http_request', added('http_request', 'Fetch tickets')),
            call('builder_add_ai_step', added('ai_step', 'Summarise each ticket')),
        ]} />);
        expect(screen.getAllByTestId('activity-row')).toHaveLength(2);
        expect(screen.getByText('Fetch tickets')).toBeTruthy();
        expect(screen.getByText('Summarise each ticket')).toBeTruthy();
    });

    it('distinguishes three identical tool names by what each produced', () => {
        // The defect this component exists to fix.
        render(<BuilderActivity toolCalls={[
            call('builder_add_array_op', added('filter', 'Keep high priority')),
            call('builder_add_array_op', added('summarize', 'Count them')),
            call('builder_add_array_op', added('aggregate', 'Collect summaries')),
        ]} />);
        expect(screen.getByText('Keep high priority')).toBeTruthy();
        expect(screen.getByText('Count them')).toBeTruthy();
        expect(screen.getByText('Collect summaries')).toBeTruthy();
        expect(screen.getAllByText('builder_add_array_op')).toHaveLength(3);
    });

    it('shows a refusal reason without a click, and keeps the hint', () => {
        render(<BuilderActivity toolCalls={[
            call('builder_add_action', {
                error: '"gmail_search" is a Gmail action, and Gmail is not connected for this user.',
                _fixHint: 'Tell the user to connect Gmail first.',
            }),
        ]} />);
        // Twice over: once in the banner, once inside the JSON below it. The
        // banner is the point — it is readable without opening anything.
        expect(screen.getAllByText(/Gmail is not connected/).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/connect Gmail first/).length).toBeGreaterThan(0);
    });

    it('never leaks the whole-draft echo into the DOM', () => {
        const { container } = render(<BuilderActivity toolCalls={[
            call('builder_add_ai_step', {
                ...added('ai_step', 'Summarise'),
                _draftSteps: 'trg > a > b > c > d > e',
                _stepIds: 'trg, a, b, c',
            }),
        ]} />);
        expect(container.textContent).not.toContain('_draftSteps');
        expect(container.textContent).not.toContain('trg > a > b');
    });

    it('marks the last row live only while running', () => {
        const calls = [call('builder_add_http_request', added('http_request', 'Fetch'))];
        const { container: idle } = render(<BuilderActivity toolCalls={calls} running={false} />);
        expect(idle.querySelectorAll('.animate-spin')).toHaveLength(0);
        const { container: live } = render(<BuilderActivity toolCalls={calls} running={true} />);
        // One in the header, one on the live row.
        expect(live.querySelectorAll('.animate-spin').length).toBeGreaterThan(0);
    });

    describe('the test run in flight (liveRun)', () => {
        // The dry-run call only lands once the run has finished; until then
        // the run the server announced (dryrun_started) is the live row.
        const before = [
            call('builder_add_http_request', added('http_request', 'Fetch')),
            call('builder_summarise', { summary: 'Fetches and files.' }),
        ];
        const focus = { label: 'Read file content', done: 1, total: 4, state: 'running' };

        it('adds a live row for the run and takes the spinner off the call before it', () => {
            const { container } = render(<BuilderActivity toolCalls={before} running={true} liveRun={focus} />);
            const rows = container.querySelectorAll('[data-testid="activity-row"]');
            expect(rows).toHaveLength(3);
            const live = rows[2];
            expect(live.getAttribute('data-live')).toBe('');
            expect(live.textContent).toContain('Testing the automation…');
            expect(live.textContent).toContain('Read file content · 1/4');
            expect(live.querySelector('.animate-spin')).not.toBeNull();
            // "Reviewed the automation" is done: a tick, not a spinner.
            expect(rows[1].querySelector('.animate-spin')).toBeNull();
            expect(rows[1].querySelector('.text-emerald-500')).not.toBeNull();
            // The header counts it as a row.
            expect(container.textContent).toContain('3');
        });

        it('prints no payload for the live row — there is no call yet', () => {
            const { container } = render(<BuilderActivity toolCalls={before} running={true} liveRun={focus} />);
            const rows = container.querySelectorAll('[data-testid="activity-row"]');
            expect(rows[2].querySelector('pre')).toBeNull();
            expect(rows[1].querySelector('pre')).not.toBeNull();
        });

        it('shows the row before the first step row arrives, without inventing a count', () => {
            const { container } = render(<BuilderActivity toolCalls={before} running={true} liveRun={{ label: '', done: 0, total: 0 }} />);
            const live = container.querySelectorAll('[data-testid="activity-row"]')[2];
            expect(live.textContent).toContain('Testing the automation…');
            expect(live.textContent).not.toMatch(/\d+\/\d+/);
        });

        it('ignores a run once the turn is over — that is the canvas\'s story', () => {
            const { container } = render(<BuilderActivity toolCalls={before} running={false} liveRun={focus} />);
            expect(container.querySelectorAll('[data-testid="activity-row"]')).toHaveLength(2);
            expect(container.textContent).not.toContain('Testing the automation…');
        });

        it('translates the live row through t', () => {
            const t = (k, d) => (k === 'automations.builder.act.dry_run_live' ? 'Automation wordt getest…' : d);
            const { container } = render(<BuilderActivity toolCalls={before} running={true} liveRun={focus} t={t} />);
            expect(container.textContent).toContain('Automation wordt getest…');
        });
    });

    it('uses only animation classes this app actually defines', () => {
        // animate-in / slide-in-from-* exist in four files and render nothing.
        const { container } = render(<BuilderActivity toolCalls={[
            call('builder_finalize', { ok: true }),
        ]} running />);
        const html = container.innerHTML;
        for (const dead of ['animate-in', 'slide-in-from', 'animate-slide-up']) {
            expect(html).not.toContain(dead);
        }
    });

    it('lists a builder_add_steps batch under its row, one compact line per step, with the batch tile', () => {
        const { container } = render(<BuilderActivity toolCalls={[
            call('builder_add_steps', { added: [
                { id: 'a', type: 'http_request' },
                { id: 'b', type: 'ai_step' },
                { id: 'c', type: 'integration_action', tool: 'gmail_send' },
            ] }),
        ]} />);
        expect(screen.getAllByTestId('activity-row')).toHaveLength(1);
        expect(screen.getByText('Added 3 steps')).toBeTruthy();
        const lines = screen.getAllByTestId('activity-batch-step');
        expect(lines).toHaveLength(3);
        expect(lines[2].textContent).toBe('Gmail');
        // Each line enters like a row does, and the row's tile says "several".
        expect(lines.every(l => l.className.includes('bf-step-in'))).toBe(true);
        expect(container.querySelector('.lucide-layers')).toBeTruthy();
        // The list is part of the row's summary, readable without opening the details.
        expect(screen.getByTestId('activity-batch').closest('summary')).toBeTruthy();
    });

    it('a single add renders no batch list', () => {
        render(<BuilderActivity toolCalls={[call('builder_add_ai_step', added('ai_step', 'Summarise'))]} />);
        expect(screen.queryByTestId('activity-batch')).toBeNull();
    });

    it('survives a malformed call rather than blanking the panel', () => {
        expect(() => render(<BuilderActivity toolCalls={[{}, { name: 'x' }, null]} />)).not.toThrow();
    });
});
