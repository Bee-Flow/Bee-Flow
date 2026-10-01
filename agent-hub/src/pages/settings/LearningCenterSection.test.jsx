/**
 * Render smoke for the redesigned Learning Center (handoff "Learning
 * Center.dc.html"): the shell mounts with the rail, the hero and the
 * curriculum map; a course opens as its own screen with a lessons table; the
 * Review and Achievements tabs render; "Play" dispatches the player event
 * with the course id and "Beside the app" adds the docked layout.
 *
 * Network is stubbed at authFetch: /ai/user-settings answers with a progress
 * blob (one lesson mastered), the catalog and achievements answer empty so
 * the bundled catalog and the client-side badge math carry the screen.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../components/licensing/LicenseContext', () => ({
    useLicenseContext: () => ({ hasFeature: () => true }),
}));
vi.mock('../../components/onboarding/catalogClient', () => ({ fetchCatalog: vi.fn(async () => null) }));
vi.mock('../../components/onboarding/achievements', () => ({
    fetchAchievements: vi.fn(async () => ({
        badges: [],
        certificates: [
            { certificateId: 'cert-foundations', title: 'Bee Flow AI Certified — Foundations', level: 'Foundations', eligible: false, issued: false, isPublic: false, progress: { done: 0, total: 2 } },
            { certificateId: 'cert-builder', title: 'Bee Flow AI Certified — Agent Builder', level: 'Agent Builder', eligible: false, issued: false, isPublic: false, progress: { done: 0, total: 2 } },
            { certificateId: 'cert-practitioner', title: 'Bee Flow AI Practitioner', level: 'Practitioner', eligible: false, issued: false, isPublic: false, progress: { done: 0, total: 4 } },
        ],
        version: '2026.1',
    })),
    issueCertificate: vi.fn(),
    fetchAssetObjectUrl: vi.fn(),
    downloadAsset: vi.fn(),
}));
vi.mock('../../components/onboarding/actionChecks', async (importOriginal) => {
    const mod = await importOriginal();
    return { ...mod, runActionCheck: vi.fn(async () => ({ passes: {}, allPassed: false, error: null })) };
});

import LearningCenterSection from './LearningCenterSection';
import { LESSON_PLAYER_OPEN_EVENT } from '../../components/onboarding/lessons';
import { authFetch } from '../../utils/helpers';

const USER = { id: 'u1', role: 'admin', permissions: ['manage_agents', 'manage_skills', 'manage_knowledge', 'manage_users'] };

function jsonResponse(body) {
    return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
    window.localStorage.clear();
    authFetch.mockReset();
    authFetch.mockImplementation(async (url) => {
        if (String(url).includes('/ai/user-settings')) {
            return jsonResponse({
                learningPath: 'builder',
                learningProgress: {
                    'getting-started': { completedAt: '2026-09-01T10:00:00Z', masteredAt: '2026-09-01T10:00:00Z' },
                },
            });
        }
        return jsonResponse({});
    });
});

describe('LearningCenterSection — redesigned shell', () => {
    it('mounts the rail, the hero and the curriculum map', async () => {
        render(<LearningCenterSection user={USER} />);
        expect(screen.getByTestId('learning-rail')).toBeTruthy();
        expect(await screen.findByTestId('learning-hero')).toBeTruthy();
        expect(screen.getByTestId('curriculum-map')).toBeTruthy();
        // One column per learning path (plus a trailing column for any course no
        // path claims) and the capstone as a full-width end station.
        expect(screen.getAllByTestId('curriculum-column').length).toBeGreaterThanOrEqual(3);
        expect(screen.getByTestId('capstone-station')).toBeTruthy();
        // The learner's path is the first column (server said 'builder').
        await waitFor(() => {
            const first = screen.getAllByTestId('curriculum-column')[0];
            expect(within(first).getByText('Build agents & automations')).toBeTruthy();
        });
        // The hero continues with the first incomplete lesson in path order.
        expect(screen.getByTestId('learning-continue')).toBeTruthy();
    });

    it('"Play" opens the player with the course id; "Beside the app" docks it', async () => {
        const seen = [];
        const onOpen = (e) => seen.push(e.detail);
        window.addEventListener(LESSON_PLAYER_OPEN_EVENT, onOpen);
        render(<LearningCenterSection user={USER} />);
        fireEvent.click(await screen.findByTestId('learning-continue'));
        expect(seen[0].courseId).toBeTruthy();
        expect(seen[0].layout).toBeNull();
        fireEvent.click(screen.getByText('Beside the app'));
        expect(seen[1].layout).toBe('docked');
        window.removeEventListener(LESSON_PLAYER_OPEN_EVENT, onOpen);
    });

    it('a course opens as its own screen with a lessons table, and back returns to the map', async () => {
        render(<LearningCenterSection user={USER} />);
        // Wait for the server-hydrated path to settle the columns first: the
        // pre-hydration paint expands a different path column, and grabbing a
        // row before the reorder captures an element the collapse then
        // unmounts — a click on a detached node reaches no handler.
        await waitFor(() => {
            const first = screen.getAllByTestId('curriculum-column')[0];
            expect(within(first).getByText('Build agents & automations')).toBeTruthy();
        });
        const station = (await screen.findAllByTestId('course-station'))[0];
        fireEvent.click(station);
        expect(await screen.findByTestId('course-view')).toBeTruthy();
        expect(screen.getAllByTestId('lesson-row').length).toBeGreaterThan(0);
        // A row expands in place, showing only the numbered steps (round 3 —
        // the "what counts" and "help on the way" columns were the same text
        // for every lesson in the product, so they are a line, not a panel).
        expect(screen.queryByTestId('lesson-steps')).toBeNull();
        fireEvent.click(screen.getAllByLabelText('Lesson details')[0]);
        expect(screen.getByTestId('lesson-steps')).toBeTruthy();
        fireEvent.click(screen.getByLabelText('Back to the overview'));
        expect(await screen.findByTestId('curriculum-map')).toBeTruthy();
    });

    it('the curriculum map opens as category tiles: one path expanded, the rest behind their tile (BFSF-473)', async () => {
        render(<LearningCenterSection user={USER} />);
        await screen.findByTestId('learning-hero');
        // Every category renders as one large tile — never more than one list open.
        const tiles = screen.getAllByTestId('curriculum-tile');
        expect(tiles.length).toBeGreaterThanOrEqual(3);
        expect(tiles.filter((tile) => tile.getAttribute('aria-expanded') === 'true').length).toBe(1);
        // The learner's own path (builder, first column) is the one that starts open.
        const firstCol = screen.getAllByTestId('curriculum-column')[0];
        expect(within(firstCol).getAllByTestId('course-station').length).toBeGreaterThan(0);
        // A collapsed category shows its tile but no course rows; clicking opens it
        // and closes the previous one (accordion).
        const secondCol = screen.getAllByTestId('curriculum-column')[1];
        expect(within(secondCol).queryByTestId('course-station')).toBeNull();
        fireEvent.click(within(secondCol).getByTestId('curriculum-tile'));
        expect(within(secondCol).getAllByTestId('course-station').length).toBeGreaterThan(0);
        expect(within(firstCol).queryByTestId('course-station')).toBeNull();
    });

    it('the Review and Achievements tabs render from the rail', async () => {
        render(<LearningCenterSection user={USER} />);
        await screen.findByTestId('learning-hero');
        const rail = screen.getByTestId('learning-rail');
        fireEvent.click(within(rail).getByText('Achievements'));
        expect(await screen.findByTestId('achievements-view')).toBeTruthy();
        // Every badge is a row here — one per course the learner can see.
        expect(screen.getAllByTestId('badge-row').length).toBeGreaterThanOrEqual(9);
        expect(screen.getAllByTestId('certificate-row').length).toBe(3);
        fireEvent.click(within(rail).getByText('Review'));
        expect(await screen.findByTestId('review-view')).toBeTruthy();
    });
});
