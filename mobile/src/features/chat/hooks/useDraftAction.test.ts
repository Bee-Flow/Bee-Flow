/** A draft card's state survives its row unmounting, and an action runs once at a time. */

import { act, renderHook, waitFor } from '@testing-library/react-native';

import { _resetDraftActions, useDraftAction } from './useDraftAction';

beforeEach(() => _resetDraftActions());

it('starts from what the server says the draft already is', async () => {
    expect((await renderHook(() => useDraftAction('m1:email:0', 'sent'))).result.current.status).toBe('done');
    expect((await renderHook(() => useDraftAction('m1:email:1'))).result.current.status).toBe('pending');
});

it('runs an action once and keeps the result for a remounted card', async () => {
    let finish: () => void = () => undefined;
    const action = jest.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const first = await renderHook(() => useDraftAction('m1:calendar:0'));
    await act(async () => {
        first.result.current.run(action);
        first.result.current.run(action);
    });
    expect(action).toHaveBeenCalledTimes(1);
    expect(first.result.current.status).toBe('working');
    await act(async () => finish());
    await first.unmount();
    const again = await renderHook(() => useDraftAction('m1:calendar:0'));
    expect(again.result.current.status).toBe('done');
});

it("reports the server's reason when it refuses, and a saved draft's link", async () => {
    const hook = await renderHook(() => useDraftAction('m1:email:0'));
    await act(async () => hook.result.current.run(() => Promise.reject(new Error('Gmail is not connected'))));
    await waitFor(() => expect(hook.result.current.status).toBe('failed'));
    expect(hook.result.current.error).toBe('Gmail is not connected');

    const saved = await renderHook(() => useDraftAction('m1:email:1'));
    await act(async () => saved.result.current.run(() => Promise.resolve('https://mail.example/d/1'), { saving: true }));
    await waitFor(() => expect(saved.result.current.status).toBe('saved'));
    expect(saved.result.current.link).toBe('https://mail.example/d/1');
});
