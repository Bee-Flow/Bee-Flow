/**
 * An app button whose run outlasts the server's wait (202 "pending"): it spins
 * while the poll says the run is going, and stops — showing the run's end and
 * no longer polling — the moment the poll says it finished or failed. A poll
 * that fails says why and can be asked again.
 */

import { act, cleanup, fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { ActionRunner } from './ActionRunner';
import type { RunnableAction } from '../model/appDefinition';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const post = api.post as jest.Mock;
const get = api.get as jest.Mock;

const ACTION: RunnableAction = { actionId: 'a1', action: { kind: 'run_automation' }, runnable: true, label: 'Go' };

async function draw() {
    await renderWithProviders(<ActionRunner appId="app1" action={ACTION} label="Go" collect={() => ({})} />);
}

/** Lets the poll's interval fire, and its answer land. */
async function wait(ms: number) {
    await act(async () => {
        jest.advanceTimersByTime(ms);
    });
    await act(async () => undefined);
}

const busy = () => screen.getByRole('button', { name: 'Go' }).props.accessibilityState?.busy;

beforeEach(() => {
    jest.useFakeTimers();
    post.mockReset();
    get.mockReset();
    post.mockResolvedValue({ runId: 'r1', status: 'pending' });
});

afterEach(async () => {
    await cleanup();
    jest.useRealTimers();
});

it('stops spinning and polling once the poll says the run finished', async () => {
    get.mockResolvedValueOnce({ runId: 'r1', status: 'running' }).mockResolvedValue({ runId: 'r1', status: 'success', output: 'All done' });
    await draw();
    await fireEvent.press(screen.getByRole('button', { name: 'Go' }));
    await wait(0);
    expect(screen.getByText('Still running…')).toBeTruthy();
    expect(busy()).toBe(true);

    await wait(3000);
    expect(await screen.findByText('All done')).toBeTruthy();
    expect(screen.queryByText('Still running…')).toBeNull();
    expect(busy()).toBe(false);

    const calls = get.mock.calls.length;
    await wait(9000);
    expect(get.mock.calls.length).toBe(calls);
    expect(get).toHaveBeenCalledWith('/api/studio-apps/app1/actions/runs/r1', expect.anything());
});

it('shows a failed run as failed, with its error, and frees the button', async () => {
    get.mockResolvedValue({ runId: 'r1', status: 'error', error: 'The mailbox refused the message.' });
    await draw();
    await fireEvent.press(screen.getByRole('button', { name: 'Go' }));
    await wait(0);
    expect(await screen.findByText('The mailbox refused the message.')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(busy()).toBe(false);
});

it('says why the poll failed, stops, and checks again on request', async () => {
    get.mockRejectedValueOnce(new Error('Network request failed')).mockResolvedValue({ runId: 'r1', status: 'success', output: 'Back' });
    await draw();
    await fireEvent.press(screen.getByRole('button', { name: 'Go' }));
    await wait(0);
    expect(await screen.findByText('Could not check on the run: Network request failed')).toBeTruthy();
    expect(busy()).toBe(false);
    await wait(9000);
    expect(get).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('app-action-poll-retry'));
    await wait(0);
    expect(await screen.findByText('Back')).toBeTruthy();
    expect(screen.queryByText(/Could not check on the run/)).toBeNull();
});
