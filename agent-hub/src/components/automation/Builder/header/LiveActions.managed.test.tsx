import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LiveActions, { SavingPill } from './LiveActions';
import { liveStateOf } from './liveState';

const managed = { solutionId: 's1', solutionName: 'Intake', stage: 'prd', releaseSeq: 7, devRef: null };

describe('LiveActions on a managed automation', () => {
    it('live and "ahead": no Make-live button, Pause stays and works', async () => {
        const onPublish = vi.fn();
        const onDeactivate = vi.fn();
        const live = liveStateOf({ isActive: true, version: 5, liveVersion: 3, neverLive: false, pendingChanges: 2, managed });
        render(<LiveActions live={live} onPublish={onPublish} onDeactivate={onDeactivate} />);
        expect(screen.queryByText(/live$/)).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
        expect(onDeactivate).toHaveBeenCalledTimes(1);
        expect(onPublish).not.toHaveBeenCalled();
    });

    it('paused: Activate (switch on) stays', async () => {
        const onActivate = vi.fn();
        const live = liveStateOf({ isActive: false, version: 5, liveVersion: 3, neverLive: false, managed });
        render(<LiveActions live={live} onActivate={onActivate} />);
        await userEvent.click(screen.getByRole('button', { name: /Activate/ }));
        expect(onActivate).toHaveBeenCalledTimes(1);
    });

    it('never deployed: Activate is disabled and says why', () => {
        const live = liveStateOf({ isActive: false, version: 1, liveVersion: null, neverLive: true, managed });
        render(<LiveActions live={live} onActivate={vi.fn()} />);
        const button = screen.getByTestId('managed-not-deployed');
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute('title', 'This part has not been deployed yet.');
    });

    it('the same state unmanaged still offers Make live', () => {
        const live = liveStateOf({ isActive: true, version: 5, liveVersion: 3, neverLive: false, pendingChanges: 2 });
        render(<LiveActions live={live} onPublish={vi.fn()} />);
        expect(screen.getByRole('button', { name: /Make v5 live/ })).toBeInTheDocument();
    });

    it('the saving pill stays silent on a read-only automation', () => {
        const { container } = render(<SavingPill state="saved" settled readOnly />);
        expect(container).toBeEmptyDOMElement();
    });
});
