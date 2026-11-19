import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient as render } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import SkillStore from './SkillStore';
import StoreSwitch from './StoreSwitch';

const MINE = { id: 'm1', name: 'My skill', userId: 'u1', canEdit: true, category: 'Sales', description: 'Answers quotes' };
const THEIRS = { id: 't1', name: 'Shared skill', userId: 'u2', canEdit: false, agentOnly: true, dynamicActivation: true };
const USER = { id: 'u1', permissions: ['manage_skills', 'manage_agents'] };

const STATS = { t1: { uses: 5, lastUsedByMeAt: null }, m1: { uses: 1, lastUsedByMeAt: '2026-11-01T00:00:00Z' } };
let calls: RecordedCall[] = [];

describe('SkillStore', () => {
    beforeEach(() => {
        calls = stubRecordingFetch(({ method, url }) => {
            if (method === 'POST' && url.includes('/copy')) return jsonResponse({ id: 'c1' }, 201);
            if (url.includes('/store-stats')) return jsonResponse({ stats: STATS });
            if (url.endsWith('/api/skills')) return jsonResponse([MINE, THEIRS]);
            return jsonResponse([]);
        });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('shows what each skill is: static or dynamic, only through agents, its category', async () => {
        render(<SkillStore user={USER} onClose={vi.fn()} onNavigate={vi.fn()} />);
        await userEvent.click(await screen.findByTestId('skill-store-tab-all'));
        await screen.findByText('Shared skill');
        expect(screen.getByText('My skill')).toBeTruthy();
        expect(screen.getByTestId('skill-store-agent-only-t1')).toBeTruthy();
        expect(screen.getByText('dynamic')).toBeTruthy();
        expect(screen.getByText('always on')).toBeTruthy();
        expect(screen.getByTestId('skill-store-tab-cat:Sales')).toBeTruthy();
    });

    it('offers a copy only of a skill of someone else, and opens the copy', async () => {
        const onNavigate = vi.fn();
        render(<SkillStore user={USER} onClose={vi.fn()} onNavigate={onNavigate} />);
        await userEvent.click(await screen.findByTestId('skill-store-tab-all'));
        await screen.findByText('Shared skill');
        expect(screen.queryByTestId('skill-store-copy-m1')).toBeNull();
        await userEvent.click(screen.getByTestId('skill-store-copy-t1'));
        await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toMatchObject({ body: { name: 'Shared skill (copy)' } }));
        expect(calls.find((c) => c.method === 'POST')?.url).toContain('/api/skills/t1/copy');
        await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('studio/skills/c1'));
    });

    it('without the right to manage skills or agents there is no open, copy or add', async () => {
        render(<SkillStore user={{ id: 'u1', permissions: [] }} onClose={vi.fn()} onNavigate={vi.fn()} />);
        await userEvent.click(await screen.findByTestId('skill-store-tab-all'));
        await screen.findByText('Shared skill');
        expect(screen.queryByTestId('skill-store-copy-t1')).toBeNull();
        expect(screen.queryByTestId('skill-store-open-t1')).toBeNull();
        expect(screen.queryByTestId('skill-store-attach-t1')).toBeNull();
    });

    it('recently used lists only what you used', async () => {
        render(<SkillStore user={USER} onClose={vi.fn()} onNavigate={vi.fn()} />);
        await screen.findByText('Shared skill');
        await userEvent.click(screen.getByTestId('skill-store-tab-lastused'));
        await waitFor(() => expect(screen.getByText('My skill')).toBeTruthy());
        expect(screen.queryByText('Shared skill')).toBeNull();
    });
});

describe('StoreSwitch', () => {
    it('switches between the Agent store and the Skill store', async () => {
        render(<StoreSwitch agents={<p>agent shelf</p>} skills={<p>skill shelf</p>} />);
        expect(screen.getByText('agent shelf')).toBeTruthy();
        await userEvent.click(screen.getByTestId('store-shelf-skills'));
        expect(screen.getByText('skill shelf')).toBeTruthy();
    });
});
