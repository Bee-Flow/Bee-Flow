import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({
    capture: { open: false, session: 0, openCapture: vi.fn() },
    recorder: { version: 0, lastResultId: null as string | null, uploading: false, recorder: { state: 'idle' }, consumeLastResult: vi.fn() },
    attach: vi.fn(), filed: vi.fn(),
}));
vi.mock('../../../../pages/meeting-notes/capture/CaptureContext', () => ({ useCapture: () => fake.capture }));
vi.mock('../../../../pages/meeting-notes/hooks/RecorderContext', () => ({ useRecorder: () => fake.recorder }));
vi.mock('../../../../api/queries/projects', () => ({ useAttachResource: (projectId: string) => ({ mutateAsync: (body: unknown) => fake.attach(projectId, body) }) }));
vi.mock('../../../shared/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import ProjectCaptureProvider from './ProjectCaptureProvider';
import useProjectMeetingCapture, { resetCaptureArm } from './useProjectMeetingCapture';
function Tab() {
    const capture = useProjectMeetingCapture('p1', fake.filed);
    return <button onClick={capture.start}>Record</button>;
}
beforeEach(() => {
    resetCaptureArm();
    fake.capture.open = false; fake.capture.session = 0;
    fake.recorder.version = 0; fake.recorder.lastResultId = null; fake.recorder.uploading = false;
    fake.attach.mockReset().mockResolvedValue({}); fake.filed.mockReset();
    fake.capture.openCapture.mockReset().mockImplementation(() => { fake.capture.open = true; return ++fake.capture.session; });
    fake.recorder.consumeLastResult.mockReset().mockImplementation(() => { const id = fake.recorder.lastResultId; fake.recorder.lastResultId = null; return { id }; });
});
describe('project capture lifecycle', () => {
    it('files into the original project after the tab has unmounted', async () => {
        const ui = (tab: boolean) => <ProjectCaptureProvider onNavigate={vi.fn()}>{tab ? <Tab /> : <div>Another project</div>}</ProjectCaptureProvider>;
        const view = render(ui(true));
        fireEvent.click(screen.getByText('Record'));
        await waitFor(() => expect(fake.capture.openCapture).toHaveBeenCalledTimes(1));
        view.rerender(ui(false));
        fake.recorder.version = 1; fake.recorder.lastResultId = 'meeting-1';
        view.rerender(ui(false));
        await waitFor(() => expect(fake.attach).toHaveBeenCalledWith('p1', { kind: 'meeting', id: 'meeting-1', attach: true }));
        expect(fake.recorder.consumeLastResult).toHaveBeenCalledTimes(1);
        expect(fake.filed).not.toHaveBeenCalled();
    });
    it('retains the saved meeting for a retry after filing fails', async () => {
        fake.attach.mockRejectedValueOnce(new Error('Network unavailable'));
        const navigate = vi.fn();
        const ui = (tab: boolean) => <ProjectCaptureProvider onNavigate={navigate}>{tab ? <Tab /> : null}</ProjectCaptureProvider>;
        const view = render(ui(true)); fireEvent.click(screen.getByText('Record'));
        await waitFor(() => expect(fake.capture.openCapture).toHaveBeenCalledTimes(1));
        fake.recorder.version = 1; fake.recorder.lastResultId = 'meeting-1'; view.rerender(ui(false));
        fireEvent.click(await screen.findByRole('button', { name: 'Open saved meeting' }));
        expect(navigate).toHaveBeenCalledWith('studio/meeting-notes/meeting-1');
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await waitFor(() => expect(fake.attach).toHaveBeenCalledTimes(2));
        expect(fake.attach.mock.calls[1]).toEqual(['p1', { kind: 'meeting', id: 'meeting-1', attach: true }]);
        expect(fake.recorder.consumeLastResult).toHaveBeenCalledTimes(1);
    });
});
