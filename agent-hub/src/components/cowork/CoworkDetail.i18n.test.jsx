/**
 * The detail half of Cowork speaks through t(), not through English baked
 * into the JSX (CW-01's rule, applied to the pane CW-06/08/11/13 rebuilt).
 *
 * The other suites in this folder let t() fall through to its English
 * fallback, which is the right stub for asserting behaviour but cannot tell a
 * translated string from a hardcoded one — both render the same English.
 * Here the translator ECHOES THE KEY and throws the fallback away, so
 * anything that went through t() reads as «some.key» and anything that did
 * not still reads as English. Asserting the English is ABSENT is what makes
 * this bite: paste a literal back into the JSX and it reappears on screen.
 *
 * Keys are asserted by SHAPE, not one by one: the property is "this string is
 * reachable from the Languages panel, in a namespace this track owns".
 */
import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const echoT = (key) => `«${key}»`;
vi.mock('../../hooks/useTranslation', () => ({
    default: () => ({ t: echoT, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} }),
    useTranslation: () => ({ t: echoT, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} }),
    TranslationProvider: ({ children }) => children,
}));

const api = vi.hoisted(() => ({
    listCoworkRuns: vi.fn(),
    listCoworkAgents: vi.fn(),
    getCoworkStats: vi.fn(),
}));
vi.mock('./coworkApi', () => api);

import CoworkDetail from './CoworkDetail';

const item = {
    id: 'w1',
    title: 'Weekly digest',
    prompt: 'Summarise the week',
    isActive: true,
    lastStatus: 'success',
    lastRunAt: new Date().toISOString(),
    runCount: 3,
    repeatInterval: 'weekly',
    enabledApps: ['gmail', 'calendar'],
    // No nextRunAt and no agent on purpose: describeMoment and an agent name
    // are somebody else's words (coworkSchedule, the agent record) and this
    // suite is about the copy THIS pane owns.
};

async function renderPane(runs = []) {
    api.listCoworkRuns.mockResolvedValue({ runs, total: runs.length });
    api.getCoworkStats.mockResolvedValue({
        total: 3, success: 2, failed: 1, avgDurationMs: 72_000, runCount: 3,
        createdAt: new Date(2026, 6, 8).toISOString(),
    });
    const utils = render(
        <CoworkDetail
            item={item}
            agents={[]}
            onRunNow={vi.fn()}
            onToggle={vi.fn()}
            onDelete={vi.fn()}
            onSave={vi.fn()}
            onEdit={vi.fn()}
            onCancelEdit={vi.fn()}
            busy={false}
            reloadKey={0}
            editing={false}
            saveError={null}
        />,
    );
    await act(async () => {});
    return utils;
}

const run = (over = {}) => ({
    id: 'r1',
    status: 'success',
    triggerKind: 'manual',
    startedAt: new Date().toISOString(),
    durationMs: 5200,
    result: null,
    error: null,
    producedOutput: false,
    ...over,
});

beforeEach(() => {
    api.listCoworkRuns.mockReset();
    api.getCoworkStats.mockReset();
});

/** Every key that reached the screen, in order. */
function keysOn(el) {
    return [...el.textContent.matchAll(/«([^»]+)»/g)].map(m => m[1]);
}

describe('the detail pane under a key-echoing translator', () => {
    it('routes its own copy through t(), under cowork.* or a shared table', async () => {
        await renderPane([run()]);
        const keys = keysOn(screen.getByTestId('cowork-detail'));

        expect(keys.length).toBeGreaterThan(10);
        for (const key of keys) {
            // cowork.* is this track's namespace; run_status.* is the shared
            // status table every screen reads (F1) — a consumer, not a writer.
            expect(key).toMatch(/^(cowork|run_status)\./);
        }
    });

    it('leaves none of its English on screen', async () => {
        await renderPane([run()]);
        // The keys themselves are dropped first: several of them spell an
        // English word inside the key (`cowork.detail.app_count`), and this
        // assertion is about text a READER sees, not about key spelling.
        const text = screen.getByTestId('cowork-detail').textContent.replace(/«[^»]+»/g, '');
        for (const english of [
            'Untitled cowork', 'Run now', 'Pause', 'Resume', 'Edit',
            'The assignment', 'Runs once', 'app', 'apps',
            'Runs', 'Succeeded', 'Average', 'per run', 'since',
            'What happened', 'Nothing to report', 'No output recorded',
            'Today', 'Yesterday', 'Loading history',
        ]) {
            expect(text).not.toContain(english);
        }
    });

    it('translates the delete button’s accessible name too', async () => {
        await renderPane();
        expect(screen.getByTestId('cowork-delete').getAttribute('aria-label'))
            .toMatch(/^«cowork\./);
    });

    it('translates the words the run history says about an empty run', async () => {
        await renderPane([run({ producedOutput: false })]);
        const row = screen.getByTestId('cowork-run');
        expect(keysOn(row).some(k => k.startsWith('cowork.history.'))).toBe(true);
    });

    it('translates the figures’ labels and the line under them', async () => {
        await renderPane();
        const keys = keysOn(screen.getByTestId('cowork-stats'));
        expect(keys.filter(k => k.startsWith('cowork.stats.')).length).toBeGreaterThanOrEqual(4);
    });
});
