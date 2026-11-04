import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportModal from './ReportModal';
import type { LibraryMeeting } from './MeetingRow';

/**
 * ReportModal stays mounted in MeetingLibrary while closed (only `open`
 * toggles), so a report still running when the user closes it must not land
 * in the NEXT session: under another selection's titles, over a newer
 * request, or by switching a newer request's spinner off.
 *
 * The network is stubbed at `fetch` (no module mock): each POST /report gets
 * a promise the test resolves by hand.
 */

interface Pending { ids: string[]; resolve: (report: string) => void }

let pending: Pending[] = [];

beforeEach(() => {
    pending = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve) => {
        const body = JSON.parse(String(init?.body || '{}')) as { ids: string[] };
        pending.push({
            ids: body.ids,
            resolve: (report: string) => resolve(new Response(
                JSON.stringify({ report, usedTranscripts: true, truncatedNotes: 0 }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            )),
        });
    })));
});

afterEach(() => { vi.unstubAllGlobals(); });

const meeting = (id: string, title: string) => ({ id, title }) as LibraryMeeting;
const SELECTION_A = [meeting('a1', 'Meeting A1'), meeting('a2', 'Meeting A2')];
const SELECTION_B = [meeting('b1', 'Meeting B1')];

/**
 * Long enough for a resolved fetch to run through jsonOrThrow into state AND
 * past MarkdownRenderer's 150 ms content throttle, so a stale answer that did
 * land would be on screen.
 */
const settle = () => new Promise((r) => setTimeout(r, 250));

function presetButton() {
    return screen.getByRole('button', { name: /key decisions and action items/i });
}

describe('ReportModal: an answer from an earlier session is dropped', () => {
    it('does not show a report started before closing under the next selection', async () => {
        const user = userEvent.setup();
        const { rerender } = render(<ReportModal open onClose={() => {}} meetings={SELECTION_A} />);
        await user.click(presetButton());
        expect(pending.map((p) => p.ids)).toEqual([['a1', 'a2']]);
        expect(screen.getByText('Generating…')).toBeTruthy();

        rerender(<ReportModal open={false} onClose={() => {}} meetings={SELECTION_A} />);
        rerender(<ReportModal open onClose={() => {}} meetings={SELECTION_B} />);
        expect(screen.getByText('Meeting B1')).toBeTruthy();

        pending[0].resolve('ANSWER ABOUT SELECTION A');
        // Let the stale answer settle, then check nothing of it landed.
        await settle();
        expect(screen.queryByText('ANSWER ABOUT SELECTION A')).toBeNull();
        expect(presetButton()).toBeTruthy(); // still the fresh, empty session
    });

    it('keeps a newer request busy and its answer when the older one returns last', async () => {
        const user = userEvent.setup();
        const { rerender } = render(<ReportModal open onClose={() => {}} meetings={SELECTION_A} />);
        await user.click(presetButton());

        rerender(<ReportModal open={false} onClose={() => {}} meetings={SELECTION_A} />);
        rerender(<ReportModal open onClose={() => {}} meetings={SELECTION_B} />);
        await user.click(presetButton());
        expect(pending.map((p) => p.ids)).toEqual([['a1', 'a2'], ['b1']]);

        pending[1].resolve('ANSWER ABOUT SELECTION B');
        await screen.findByText('ANSWER ABOUT SELECTION B');

        pending[0].resolve('ANSWER ABOUT SELECTION A');
        await settle();
        expect(screen.queryByText('ANSWER ABOUT SELECTION A')).toBeNull();
        expect(screen.getByText('ANSWER ABOUT SELECTION B')).toBeTruthy();
    });

    it('keeps the newer request spinning when the older one returns first', async () => {
        const user = userEvent.setup();
        const { rerender } = render(<ReportModal open onClose={() => {}} meetings={SELECTION_A} />);
        await user.click(presetButton());

        rerender(<ReportModal open={false} onClose={() => {}} meetings={SELECTION_A} />);
        rerender(<ReportModal open onClose={() => {}} meetings={SELECTION_B} />);
        await user.click(presetButton());

        pending[0].resolve('ANSWER ABOUT SELECTION A');
        await settle();
        expect(screen.queryByText('ANSWER ABOUT SELECTION A')).toBeNull();
        expect(screen.getByText('Generating…')).toBeTruthy();

        pending[1].resolve('ANSWER ABOUT SELECTION B');
        await screen.findByText('ANSWER ABOUT SELECTION B');
    });
});
