/**
 * Stop on every pause. A run waiting on a form page used to offer "Stop this
 * run", which the server refused with a 409; the server now closes such a
 * wait, and the phone says what the pause is, that the page is answered in
 * the web builder, and calls a test run's Stop "Discard this test run".
 * The screen half (the cancel call and an older server's 409) is in
 * screens/RunDetailScreen.test.tsx.
 */

import { screen, userEvent } from '@testing-library/react-native';
import React from 'react';

import { runPause } from '@/shared/runs/runPhase';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { RunActions } from './RunActions';

const t = (_key: string, fallback: string, params?: Record<string, string | number>) =>
    fallback.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));

function props(pause: ReturnType<typeof runPause>) {
    return {
        pause,
        live: false,
        decide: { run: jest.fn(), pending: false },
        stop: { run: jest.fn(), pending: false },
        retry: { run: jest.fn(), pending: false },
    };
}

describe('RunActions on a run waiting on a form page', () => {
    it('discards a test run that waits on a form, and says where the page is answered', async () => {
        const p = props(runPause({ status: 'awaiting_form', profile: { kind: 'test' } }, t));
        await renderScreen(<RunActions {...p} />);
        expect(screen.getByText('Waiting for a form')).toBeTruthy();
        expect(screen.getByText('Answer this page in the web builder.')).toBeTruthy();
        expect(screen.getByTestId('run-test-marker')).toBeTruthy();
        expect(screen.queryByText('Approve')).toBeNull();
        await userEvent.setup().press(screen.getByText('Discard this test run'));
        expect(p.stop.run).toHaveBeenCalledTimes(1);
    });

    it('stops a production run that waits on a form, without a Test marker', async () => {
        const p = props(runPause({ status: 'awaiting_form', profile: { kind: 'production' } }, t));
        await renderScreen(<RunActions {...p} />);
        expect(screen.queryByTestId('run-test-marker')).toBeNull();
        await userEvent.setup().press(screen.getByText('Stop this run'));
        expect(p.stop.run).toHaveBeenCalledTimes(1);
    });

    it('offers Stop on an approval pause too, under Approve and Reject', async () => {
        const p = props(runPause({ status: 'awaiting_approval', profile: { kind: 'test' }, canDecide: true }, t));
        await renderScreen(<RunActions {...p} />);
        expect(screen.getByText('Waiting for your decision (test)')).toBeTruthy();
        expect(screen.getByText('Approve')).toBeTruthy();
        await userEvent.setup().press(screen.getByText('Discard this test run'));
        expect(p.stop.run).toHaveBeenCalledTimes(1);
    });

    it('gives somebody who may not decide only Stop, and says on whom it waits', async () => {
        const p = props(runPause({ status: 'awaiting_approval', canDecide: false, waitingOn: { stageName: 'Finance', seatCount: 2 } }, t));
        await renderScreen(<RunActions {...p} />);
        expect(screen.getByText('Waiting for Finance (2)')).toBeTruthy();
        expect(screen.queryByText('Approve')).toBeNull();
        expect(screen.getByText('Stop this run')).toBeTruthy();
    });

    it('keeps a running run on Stop this run', async () => {
        const p = { ...props(null), live: true };
        await renderScreen(<RunActions {...p} />);
        await userEvent.setup().press(screen.getByText('Stop this run'));
        expect(p.stop.run).toHaveBeenCalledTimes(1);
    });
});
