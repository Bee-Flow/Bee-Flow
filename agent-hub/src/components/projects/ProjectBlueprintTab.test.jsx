import { render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args) => globalThis.__authFetch(...args),
}));

import ProjectBlueprintTab from './ProjectBlueprintTab';

/**
 * Packaging a Solution.
 *
 * Two refusals come from the server and both are RENDERED rather than hidden:
 * a locked plan and a non-owner. An explicit "this needs a different plan" is
 * more use than a control that silently is not there.
 *
 * And the warnings are the point of the screen. A Blueprint that quietly left
 * something behind — a routine it could not carry, a database it must not —
 * reads as a complete copy right up until someone installs it.
 */

const MANIFEST = {
    format: 'beeflow.blueprint',
    solution: {
        requires: [{ kind: 'approver', count: 2 }],
        report: {
            counts: { automations: 3, apps: 2, webpages: 1 },
            warnings: ['"Status" has a database. It holds live data and is never exported.'],
        },
    },
};

function mockFetch(status, body) {
    globalThis.__authFetch = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));
}

const renderTab = (props = {}) =>
    render(<ProjectBlueprintTab projectId="p1" projectName="Onboarding" role="owner" {...props} />);

beforeEach(() => mockFetch(200, MANIFEST));
afterEach(() => { delete globalThis.__authFetch; });

describe('who may package', () => {
    it('tells a non-owner why the button is dead', () => {
        const { getByText, getByRole } = renderTab({ role: 'editor' });
        expect(getByText('Only the project owner can package it.')).toBeTruthy();
        expect(getByRole('button').disabled).toBe(true);
    });

    it('lets the owner run it', () => {
        const { getByRole } = renderTab();
        expect(getByRole('button').disabled).toBe(false);
    });
});

describe('refusals are rendered, not hidden', () => {
    it('names the plan a locked feature needs', async () => {
        mockFetch(403, { error: 'feature_locked', required: 'enterprise', current: 'team' });
        const { getByRole, findByText } = renderTab();
        getByRole('button').click();
        expect(await findByText(/part of the enterprise plan/)).toBeTruthy();
    });

    it('explains an ownership refusal in terms of what export reads', async () => {
        mockFetch(403, {});
        const { getByRole, findByText } = renderTab();
        getByRole('button').click();
        expect(await findByText(/reads every member's work/)).toBeTruthy();
    });
});

describe('the result', () => {
    it('counts what it packaged and offers the download', async () => {
        const { getByRole, findByText } = renderTab();
        getByRole('button').click();
        expect(await findByText('3 routines · 2 apps · 1 webpages')).toBeTruthy();
        expect(await findByText('Download')).toBeTruthy();
    });

    it('lists what the installer must supply', async () => {
        const { getByRole, findByText } = renderTab();
        getByRole('button').click();
        expect(await findByText('Whoever installs it has to supply')).toBeTruthy();
        expect(await findByText('2 × approver')).toBeTruthy();
    });

    it('lists what the Blueprint does NOT carry', async () => {
        const { getByRole, findByText } = renderTab();
        getByRole('button').click();
        // A silent omission reads as a complete copy.
        expect(await findByText('What this Blueprint does not carry')).toBeTruthy();
        expect(await findByText(/holds live data and is never exported/)).toBeTruthy();
    });

    it('shows nothing about contents before an export has run', () => {
        const { queryByText } = renderTab();
        expect(queryByText(/routines ·/)).toBeNull();
        expect(queryByText('Download')).toBeNull();
    });

    it('reports a transport failure rather than looking successful', async () => {
        globalThis.__authFetch = vi.fn(async () => { throw new Error('offline'); });
        const { getByRole, findByText } = renderTab();
        getByRole('button').click();
        expect(await findByText('The export failed.')).toBeTruthy();
    });
});
