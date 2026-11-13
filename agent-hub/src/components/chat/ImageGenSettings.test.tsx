import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import ImageGenSettings from './ImageGenSettings';

const noop = () => {};

describe('the image settings popover', () => {
    beforeEach(() => cleanup());

    it('offers the two Google models when the server sends no list', () => {
        render(<ImageGenSettings isOpen onClose={noop} settings={{}} onSettingsChange={noop} />);
        expect(screen.getByRole('button', { name: 'Flash Image (Fast)' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'Pro Image (Quality)' })).toBeInTheDocument();
    });

    it("offers the server's models and falls back to the first when the stored one is gone", () => {
        render(
            <ImageGenSettings
                isOpen onClose={noop} onSettingsChange={noop}
                settings={{ model: 'azure/removed' }}
                imageModels={[{ id: 'azure/images-prod', label: 'gpt-image-1.5 (images-prod)', provider: 'azure' }]}
            />,
        );
        expect(screen.getByRole('button', { name: 'gpt-image-1.5 (images-prod)' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.queryByRole('button', { name: 'Flash Image (Fast)' })).not.toBeInTheDocument();
    });

    it('shows a line per limited window', () => {
        render(
            <ImageGenSettings
                isOpen onClose={noop} settings={{}} onSettingsChange={noop}
                imageQuota={{ limits: { day: 5, month: 50 }, used: { hour: 1, day: 3, week: 3, month: 12 } }}
            />,
        );
        expect(screen.getByText('3 of 5 images used in the last 24 hours')).toBeInTheDocument();
        expect(screen.getByText('12 of 50 images used in the last 30 days')).toBeInTheDocument();
        expect(screen.queryByText(/in the last hour/)).not.toBeInTheDocument();
    });
});
