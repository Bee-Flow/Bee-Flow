import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import scopedStorage, { setCurrentUser } from '../../../utils/scopedStorage';
import type { NoticeModel } from './chatSignalsModel';
import MonitoringBanner, { BANNER_SEEN_KEY } from './MonitoringBanner';

const V1 = '2026-10-14T09:00:00.000Z';
const V2 = '2026-11-02T08:30:00.000Z';

function notice(over: Partial<NoticeModel> = {}): NoticeModel {
    return {
        surface: 'direct', state: 'on', from: '2026-10-14', version: V1, signals: ['outcomes'],
        noticeUrl: null, marker: `direct@${V1}`, optedOut: false, ...over,
    };
}

beforeEach(() => {
    localStorage.clear();
    setCurrentUser('u1');
});
afterEach(() => {
    vi.restoreAllMocks();
    setCurrentUser(null);
});

describe('MonitoringBanner', () => {
    it('shows once per version: "Got it" hides it for good, also after a remount', async () => {
        const user = userEvent.setup();
        const { unmount } = render(<MonitoringBanner notice={notice()} />);
        expect(screen.getByTestId('chat-signals-banner').textContent).toContain('Chat signals are on');
        await user.click(screen.getByRole('button', { name: 'Got it' }));
        expect(screen.queryByTestId('chat-signals-banner')).toBeNull();
        expect(scopedStorage.getItem(BANNER_SEEN_KEY)).toBe(V1);
        unmount();
        render(<MonitoringBanner notice={notice()} />);
        expect(screen.queryByTestId('chat-signals-banner')).toBeNull();
    });

    it('shows again when the version changes', () => {
        scopedStorage.setItem(BANNER_SEEN_KEY, V1);
        const { rerender } = render(<MonitoringBanner notice={notice()} />);
        expect(screen.queryByTestId('chat-signals-banner')).toBeNull();
        rerender(<MonitoringBanner notice={notice({ version: V2, marker: `direct@${V2}` })} />);
        expect(screen.getByTestId('chat-signals-banner')).toBeTruthy();
    });

    it('names the start date while scheduled', () => {
        render(<MonitoringBanner notice={notice({ state: 'scheduled' })} />);
        expect(screen.getByTestId('chat-signals-banner').textContent).toContain('Chat signals start on 14 October 2026');
    });

    it('tolerates a storage that throws: the banner shows and can still be dismissed', async () => {
        vi.spyOn(scopedStorage, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
        vi.spyOn(scopedStorage, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
        const user = userEvent.setup();
        render(<MonitoringBanner notice={notice()} />);
        await user.click(screen.getByRole('button', { name: 'Got it' }));
        expect(screen.queryByTestId('chat-signals-banner')).toBeNull();
    });

    it('renders nothing without a notice', () => {
        const { container } = render(<MonitoringBanner notice={null} />);
        expect(container.innerHTML).toBe('');
    });
});
