import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ManagedPartBanner from './ManagedPartBanner';
import type { ManagedPart } from './managedPart';

const PART: ManagedPart = {
    solutionId: 's1', solutionName: 'Intake', stage: 'prd', releaseSeq: 7, devRef: { kind: 'automation', id: 'dev-a1' },
};

describe('ManagedPartBanner', () => {
    it('says who manages the part, on which stage and release, and why it is read-only', () => {
        render(<ManagedPartBanner managed={PART} />);
        const banner = screen.getByTestId('managed-part-banner');
        expect(banner).toHaveTextContent('Managed by Intake · Production · Release 7.');
        expect(banner).toHaveTextContent('Read-only so it stays exactly what UAT tested. Change it in Dev and deploy.');
        expect(banner).toHaveAttribute('data-stage', 'prd');
    });

    it('renders Open in Dev and Stage settings as real links', () => {
        render(<ManagedPartBanner managed={PART} />);
        expect(screen.getByRole('link', { name: 'Open in Dev' })).toHaveAttribute('href', '/app/studio/automations/dev-a1');
        expect(screen.getByRole('link', { name: 'Stage settings' })).toHaveAttribute('href', '/app/studio/solutions/s1?stage=prd&tab=settings');
    });

    it('hands the in-app route to onNavigate instead of reloading', async () => {
        const onNavigate = vi.fn();
        render(<ManagedPartBanner managed={PART} onNavigate={onNavigate} />);
        await userEvent.click(screen.getByRole('link', { name: 'Stage settings' }));
        expect(onNavigate).toHaveBeenCalledWith('studio/solutions/s1?stage=prd&tab=settings');
    });

    it('names UAT without a release when none is deployed yet', () => {
        render(<ManagedPartBanner managed={{ ...PART, stage: 'uat', releaseSeq: null }} />);
        expect(screen.getByTestId('managed-part-banner')).toHaveTextContent('Managed by Intake · UAT.');
    });

    it('works from a refused write that knows only the stage: no name, links still there', () => {
        render(<ManagedPartBanner managed={{ solutionId: 's1', solutionName: null, stage: 'uat', releaseSeq: null, devRef: null }} />);
        const banner = screen.getByTestId('managed-part-banner');
        expect(banner).toHaveTextContent('UAT.');
        expect(banner).not.toHaveTextContent('Managed by');
        expect(screen.getByRole('link', { name: 'Open in Dev' })).toHaveAttribute('href', '/app/studio/solutions/s1');
    });

    it('says "not deployed" instead of "read-only" when no release reached the part', () => {
        render(<ManagedPartBanner managed={null} notDeployed />);
        expect(screen.getByTestId('managed-part-banner')).toHaveTextContent('This part has not been deployed yet.');
        expect(screen.queryByRole('link')).toBeNull();
    });

    it('renders nothing for an unmanaged part', () => {
        const { container } = render(<ManagedPartBanner managed={null} />);
        expect(container).toBeEmptyDOMElement();
    });
});
