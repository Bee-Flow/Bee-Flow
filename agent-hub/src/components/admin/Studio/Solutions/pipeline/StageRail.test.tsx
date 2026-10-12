import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args: unknown[]) => (globalThis as unknown as { __authFetch: (...a: unknown[]) => unknown }).__authFetch(...args),
}));

import StageRail, { type StageRailProps } from './StageRail';
import type { Pipeline, PipelineStage } from './stagesApi';

/**
 * The strip under the header of a Solution: where each stage stands, the one
 * next step, and what it says when stages are unavailable. The decisions are
 * pipelineModel's (tested there); this pins what the strip shows of them.
 */

const stage = (name: 'uat' | 'prd', seq: number | null, over: Partial<PipelineStage> = {}): PipelineStage => ({
    stage: name, projectId: `p_${name}`, currentRelease: seq === null ? null : { id: `rel_${seq}`, seq },
    lastDeployment: seq === null ? null : { id: `d${seq}`, status: 'succeeded', kind: 'deploy', releaseSeq: seq },
    pending: null, bindingsPending: false, enabled: true, role: 'owner', ...over,
});

const DEV = { aheadOf: null, checks: { blocked: false, count: 0 } };
const release = (seq: number) => ({ id: `rel_${seq}`, seq, gate: { blocked: false } });

const NONE: Pipeline = { dev: DEV, stages: [], releases: [] };
const AHEAD: Pipeline = {
    dev: { aheadOf: { seq: 2, changed: 1, added: 0, removed: 0 }, checks: { blocked: false, count: 0 } },
    stages: [stage('uat', 2), stage('prd', 1)],
    releases: [release(2), release(1)],
};
const PROMOTE: Pipeline = { dev: DEV, stages: [stage('uat', 2), stage('prd', 1)], releases: [release(2), release(1)] };

let calls: Array<{ url: string; method: string }> = [];

beforeEach(() => {
    calls = [];
    (globalThis as unknown as { __authFetch: unknown }).__authFetch = vi.fn(async (url: string, init?: { method?: string }) => {
        calls.push({ url, method: init?.method || 'GET' });
        return { ok: true, status: 200, json: async () => ({}) };
    });
});
afterEach(() => { delete (globalThis as unknown as { __authFetch?: unknown }).__authFetch; });

function renderRail(over: Partial<StageRailProps> = {}) {
    const props: StageRailProps = {
        solutionId: 'sol1', solutionName: 'Quotes', pipeline: PROMOTE, readState: 'ok', owner: true, active: 'dev',
        onSelect: vi.fn(), onReload: vi.fn(), showAction: true, poll: false, ...over,
    };
    return { props, ...render(<StageRail {...props} />) };
}

describe('the three stages', () => {
    it('shows Dev, UAT and Production with the release each runs', () => {
        renderRail();
        expect(screen.getByTestId('stage-rail-dev').textContent).toContain('Dev');
        expect(screen.getByTestId('stage-rail-release-uat').textContent).toBe('R2');
        expect(screen.getByTestId('stage-rail-release-prd').textContent).toBe('R1');
        expect(screen.getByTestId('stage-rail-uat').textContent).toContain('UAT');
        expect(screen.getByTestId('stage-rail-prd').textContent).toContain('Production');
    });

    it('says what Dev has changed since the last release', () => {
        renderRail({ pipeline: AHEAD });
        expect(screen.getByTestId('stage-rail-note-dev').textContent).toBe('Changes since R2');
    });

    it('clicking a stage opens it; the active one is pressed', async () => {
        const user = userEvent.setup();
        const { props } = renderRail({ active: 'uat' });
        expect(screen.getByTestId('stage-rail-uat').getAttribute('aria-pressed')).toBe('true');
        await user.click(screen.getByTestId('stage-rail-prd'));
        expect(props.onSelect).toHaveBeenCalledWith('prd');
    });

    it('a stage that is not set up is shown but opens nothing', () => {
        renderRail({ pipeline: NONE });
        expect(screen.getByTestId('stage-rail-uat').tagName).toBe('DIV');
        expect(screen.getByTestId('stage-rail-note-uat').textContent).toBe('Not set up');
    });

    it('a stage-only operator sees only their stages', () => {
        renderRail({ pipeline: { dev: null, stages: [stage('uat', 2)], releases: null }, owner: false, active: 'uat' });
        expect(screen.queryByTestId('stage-rail-dev')).toBeNull();
        expect(screen.getByTestId('stage-rail-uat')).toBeTruthy();
    });
});

describe('the next step', () => {
    it('offers Set up stages when there are none, and does it', async () => {
        const user = userEvent.setup();
        const { props } = renderRail({ pipeline: NONE });
        expect(screen.getByTestId('stage-rail-action').textContent).toBe('Set up stages');
        await user.click(screen.getByTestId('stage-rail-action'));
        await waitFor(() => expect(props.onReload).toHaveBeenCalled());
        expect(calls.some(c => c.method === 'POST' && c.url.includes('/api/projects/sol1/stages'))).toBe(true);
    });

    it('offers Release & deploy to UAT when Dev has changes', () => {
        renderRail({ pipeline: AHEAD });
        expect(screen.getByTestId('stage-rail-action').textContent).toBe('Release & deploy to UAT');
    });

    it('offers to promote what UAT runs to Production', () => {
        renderRail();
        expect(screen.getByTestId('stage-rail-action').textContent).toBe('Promote R2 to Production');
    });

    it('a reader who is not the owner sees the strip and no button', () => {
        renderRail({ owner: false });
        expect(screen.getByTestId('stage-rail')).toBeTruthy();
        expect(screen.queryByTestId('stage-rail-action')).toBeNull();
    });

    it('no button where the Pipeline tab or a stage view has its own', () => {
        renderRail({ showAction: false });
        expect(screen.queryByTestId('stage-rail-action')).toBeNull();
        expect(screen.getByTestId('stage-rail-uat')).toBeTruthy();
    });

    it('a failed step is told in words under the strip', async () => {
        (globalThis as unknown as { __authFetch: unknown }).__authFetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
        const user = userEvent.setup();
        renderRail({ pipeline: NONE });
        await user.click(screen.getByTestId('stage-rail-action'));
        expect(await screen.findByTestId('stage-rail-problem')).toBeTruthy();
    });
});

describe('when stages are not available', () => {
    it('without a licence it says so in one line', () => {
        renderRail({ pipeline: null, readState: 'no_licence' });
        expect(screen.getByTestId('stage-rail-locked').textContent).toContain('not part of your plan');
        expect(screen.queryByTestId('stage-rail')).toBeNull();
    });

    it('a pipeline that could not be read says that, not "no stages"', () => {
        renderRail({ pipeline: null, readState: 'unreadable' });
        expect(screen.getByTestId('stage-rail-unreadable')).toBeTruthy();
        expect(screen.queryByTestId('stage-rail-action')).toBeNull();
    });

    it.each(['forbidden', 'not_a_solution'] as const)('%s shows nothing', (readState) => {
        const { container } = renderRail({ pipeline: null, readState });
        expect(container.firstChild).toBeNull();
    });

    it('nothing while the first read is on its way', () => {
        const { container } = renderRail({ pipeline: null, readState: 'ok' });
        expect(container.firstChild).toBeNull();
    });
});
