import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMBED_NOTICE_OFF, type EmbedComplianceNotice } from '../../api/queries/chatSignals';
import EmbedMonitoringNotice from './EmbedMonitoringNotice';

const ON: EmbedComplianceNotice = {
    state: 'on', from: '2026-10-14', version: '2026-10-14T09:00:00.000Z', signals: ['outcomes'],
    privacyNoticeUrl: 'https://www.example.org/privacy',
};

function Harness({ notice }: { notice: EmbedComplianceNotice }) {
    const [dontCount, setDontCount] = useState(false);
    return <EmbedMonitoringNotice notice={notice} dontCount={dontCount} onDontCountChange={setDontCount} />;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('EmbedMonitoringNotice', () => {
    it('renders the visitor line while chat signals are not off', () => {
        render(<Harness notice={ON} />);
        expect(screen.getByTestId('embed-monitoring-notice').textContent)
            .toContain('This chat counts how the Privacy Shield handled personal data in messages. No message content is kept for this.');
    });

    it('names the kinds when counted, and the date while scheduled', () => {
        const { unmount } = render(<Harness notice={{ ...ON, signals: ['outcomes', 'kinds'] }} />);
        expect(screen.getByTestId('embed-monitoring-notice').textContent).toContain('and which kinds it found');
        unmount();
        render(<Harness notice={{ ...ON, state: 'scheduled' }} />);
        expect(screen.getByTestId('embed-monitoring-notice').textContent).toContain('From 14 October 2026, this chat counts');
    });

    it('renders nothing while off', () => {
        render(<Harness notice={EMBED_NOTICE_OFF} />);
        expect(screen.queryByTestId('embed-monitoring-notice')).toBeNull();
    });

    it('links the privacy notice in a new tab without an opener', () => {
        render(<Harness notice={ON} />);
        const link = screen.getByRole('link', { name: 'Privacy notice' });
        expect(link.getAttribute('href')).toBe('https://www.example.org/privacy');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('"Don\'t count my messages" is React state only: nothing is written to the visitor\'s device', async () => {
        const local = vi.spyOn(Storage.prototype, 'setItem');
        const cookie = vi.spyOn(document, 'cookie', 'set');
        const user = userEvent.setup();
        render(<Harness notice={ON} />);
        const box = screen.getByRole('checkbox', { name: "Don't count my messages" });
        expect((box as HTMLInputElement).checked).toBe(false);
        await user.click(box);
        expect((box as HTMLInputElement).checked).toBe(true);
        expect(local).not.toHaveBeenCalled();
        expect(cookie).not.toHaveBeenCalled();
    });
});
