import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import DeviceSwitch from './DeviceSwitch';
import { AppEditorProvider, useAppEditor } from '../../state/AppEditorContext';

const app = {
    definition: { schemaVersion: 2, homeScreenId: 'scr_a', screens: [{ id: 'scr_a', name: 'A', sections: [] }], actions: {} },
    definitionVersion: 1,
};

function wrapper({ children }: { children?: ReactNode }) {
    return <AppEditorProvider app={app}>{children}</AppEditorProvider>;
}

function Current() {
    const { previewDevice } = useAppEditor();
    return <output data-testid="device">{previewDevice}</output>;
}

describe('previewDevice in the editor store', () => {
    it('defaults to fit, the preview as it always was', () => {
        const { result } = renderHook(() => useAppEditor(), { wrapper });
        expect(result.current.previewDevice).toBe('fit');
    });

    it('takes a known device and ignores anything else', () => {
        const { result } = renderHook(() => useAppEditor(), { wrapper });
        act(() => result.current.dispatch({ type: 'set_preview_device', device: 'phone' }));
        expect(result.current.previewDevice).toBe('phone');
        const before = result.current;
        act(() => result.current.dispatch({ type: 'set_preview_device', device: 'watch' as never }));
        expect(result.current).toBe(before);
    });

    it('leaves the definition alone', () => {
        const { result } = renderHook(() => useAppEditor(), { wrapper });
        const definition = result.current.definition;
        act(() => result.current.dispatch({ type: 'set_preview_device', device: 'tablet' }));
        expect(result.current.definition).toBe(definition);
    });
});

describe('DeviceSwitch', () => {
    it('switches the preview width', async () => {
        const user = userEvent.setup();
        render(<AppEditorProvider app={app}><DeviceSwitch /><Current /></AppEditorProvider>);
        expect(screen.getByTestId('device').textContent).toBe('fit');
        await user.click(screen.getByRole('radio', { name: /Phone, 390 px/ }));
        expect(screen.getByTestId('device').textContent).toBe('phone');
        await user.click(screen.getByRole('radio', { name: /Tablet, 834 px/ }));
        expect(screen.getByTestId('device').textContent).toBe('tablet');
        await user.click(screen.getByRole('radio', { name: /Fit to canvas/ }));
        expect(screen.getByTestId('device').textContent).toBe('fit');
    });
});
