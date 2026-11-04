import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import AudioUnavailable, { AudioNotBackedUp } from './AudioUnavailable';

/**
 * The user-facing half of the "Saved audio not found" incident.
 *
 * One message covered every cause and always ended with "please upload again" —
 * which is wrong during a passing storage outage, and impossible to act on for a
 * meeting recorded in the browser, where those bytes existed nowhere else.
 */
describe('AudioUnavailable', () => {
    it('a browser recording is NEVER told to upload the file again', () => {
        render(<AudioUnavailable audio={{ available: false, recoverable: false, capture: 'recording' }} />);

        expect(screen.getByText(/no longer available/i)).toBeTruthy();
        expect(screen.getByText(/recorded in your browser/i)).toBeTruthy();
        // The exact regression: asking for a file the user cannot produce.
        expect(document.body.textContent).not.toMatch(/upload/i);
        expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    });

    it('an uploaded file may fairly be asked for again', () => {
        render(<AudioUnavailable audio={{ available: false, recoverable: false, capture: 'upload' }} />);
        expect(screen.getByText(/upload the original file again/i)).toBeTruthy();
    });

    it('a passing storage outage reads as temporary and offers a retry', async () => {
        const user = userEvent.setup();
        const onRetry = vi.fn();
        render(<AudioUnavailable audio={{ available: false, recoverable: true, capture: 'upload' }} onRetry={onRetry} />);

        expect(screen.getByText(/temporarily unavailable/i)).toBeTruthy();
        expect(screen.getByText(/stored safely/i)).toBeTruthy();
        // It must not read as permanent loss.
        expect(document.body.textContent).not.toMatch(/no longer available/i);

        await user.click(screen.getByRole('button', { name: /try again/i }));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });
});

describe('AudioUnavailable for an imported meeting', () => {
    it('says where it came from and does not ask for a file nobody holds', () => {
        render(<AudioUnavailable audio={{ available: false, recoverable: false, capture: 'teams' }} />);
        expect(screen.getByText(/imported from Microsoft Teams/)).toBeTruthy();
        expect(screen.getByText(/holds no copy of its audio/)).toBeTruthy();
        expect(document.body.textContent).not.toMatch(/upload the original/i);
    });

    it('a Talk auto-recording counts as an import too', () => {
        render(<AudioUnavailable audio={{ available: false, recoverable: false, capture: 'talk-auto' }} />);
        expect(screen.getByText(/imported from Nextcloud Talk/)).toBeTruthy();
    });
});

describe('AudioNotBackedUp', () => {
    it('warns about the missing backup and offers the download escape hatch', () => {
        render(<AudioNotBackedUp downloadUrl="/api/transcriptions/t-1/audio?download=1" />);
        expect(screen.getByText(/durable backup/i)).toBeTruthy();
        const link = screen.getByRole('link', { name: /download/i });
        expect(link.getAttribute('href')).toBe('/api/transcriptions/t-1/audio?download=1');
    });
});
