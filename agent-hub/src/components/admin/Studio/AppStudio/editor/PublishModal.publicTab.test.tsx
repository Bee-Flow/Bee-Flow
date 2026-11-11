import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonAnswer } from '@/test/http';
import type { AppDefinition } from '../inspector/appDefinition';
import { studioAppsApi } from '../studioAppsApi';
import PublishModal from './PublishModal';

/**
 * The publish modal's two tabs, and the one thing the public page tab changes
 * about Apply: an edit made in the modal is saved before the publish freezes
 * the draft, and a failed save publishes nothing.
 */

const fetchMock = vi.fn();
const DEF: AppDefinition = { homeScreenId: 'scr_home01', screens: [{ id: 'scr_home01', name: 'Start', sections: [] }] };
const APP = { id: 'app_1', name: 'Intake', isPublished: true, sharedGroups: [] };

beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async (url: unknown) => {
        const path = String(url);
        if (path.endsWith('/public-pages')) return jsonAnswer({ pages: [], publicAccess: null, blockers: [] });
        if (path.endsWith('/schema')) return jsonAnswer({ model: { tables: [] }, modelVersion: 1 });
        if (path.endsWith('/members')) return jsonAnswer({ members: [] });
        return jsonAnswer({ groups: [], users: [] });
    });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('PublishModal tabs', () => {
    it('opens on the audience and switches to the public page', async () => {
        renderWithClient(<PublishModal open app={APP} definition={DEF} onCommit={vi.fn()} />);
        expect(screen.getByRole('tab', { name: 'Audience', selected: true })).toBeInTheDocument();
        expect(screen.queryByTestId('public-page-tab')).toBeNull();
        await userEvent.click(screen.getByRole('tab', { name: 'Public page' }));
        // The tab is its own chunk, loaded when it is opened.
        expect(await screen.findByTestId('public-page-tab', {}, { timeout: 5000 })).toBeInTheDocument();
        expect(await screen.findByText('No public URL yet.')).toBeInTheDocument();
    });

    it('saves pending edits before publishing, and publishes nothing when that failed', async () => {
        const publish = vi.spyOn(studioAppsApi, 'publish').mockResolvedValue({ isPublished: true, sharedGroups: [] });
        const onFlush = vi.fn().mockResolvedValue({ ok: false, error: 'Saving failed' });
        renderWithClient(<PublishModal open app={APP} definition={DEF} onFlush={onFlush} />);
        await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
        expect(onFlush).toHaveBeenCalledTimes(1);
        expect(publish).not.toHaveBeenCalled();

        onFlush.mockResolvedValue({ ok: true });
        await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
        expect(publish).toHaveBeenCalledTimes(1);
    });
});
