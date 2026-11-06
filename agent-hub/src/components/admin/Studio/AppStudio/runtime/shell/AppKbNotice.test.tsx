import { screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AppShell from '../AppShell';
import { appKbIds } from './appKbIds';
import { renderWithClient } from '@/test/render';
import { asMock } from '@/test/mocks';
import type { ComponentProps } from 'react';

const fetchMock = vi.fn();
const rel = (u: unknown) => String(u).replace(/^https?:\/\/[^/]+/, '');

const BASE = {
    schemaVersion: 2,
    meta: { name: 'Probe', description: '', icon: 'LayoutGrid' },
    homeScreenId: 'scr_home01',
    screens: [{ id: 'scr_home01', name: 'Home', icon: null, showInNav: true, sections: [] }],
};
const WITH_KB = {
    ...BASE,
    actions: [{ id: 'act1', steps: [{ kind: 'kb_query', knowledgeBaseIds: ['kb1'], resultVar: 'r' }, { kind: 'ai_generate', knowledgeBaseIds: ['kb2', 'kb1'] }] }],
};

const shell = (definition: ComponentProps<typeof AppShell>['definition']) =>
    renderWithClient(<AppShell definition={definition} screenId="scr_home01" onNavigate={() => {}}><div>content</div></AppShell>);

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    asMock(fetchMock).mockResolvedValue({ ok: true, status: 200, json: async () => ({ active: true, kbs: [{ id: 'kb1', name: 'Handbook', acknowledged: true, retentionDays: 90, showNames: false }] }) });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the notice in the app shell', () => {
    it('shows for an app whose steps read a logging knowledge base, asking about all of its bases once', async () => {
        shell(WITH_KB);
        expect((await screen.findByTestId('kb-query-log-notice')).textContent).toContain('Handbook');
        expect(rel(asMock(fetchMock).mock.calls[0][0])).toBe('/api/kb/query-log/notice?kbIds=kb1%2Ckb2');
    });

    it('asks nothing for an app that reads no knowledge base', () => {
        shell(BASE);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(screen.queryByTestId('kb-query-log-notice')).toBeNull();
    });
});

describe('appKbIds', () => {
    it('collects ids from nested steps and leaves ai_chat components to their own notice', () => {
        expect(appKbIds({ a: [{ knowledgeBaseIds: ['x', 'y'] }, { type: 'ai_chat', props: { knowledgeBaseIds: ['z'] } }], b: { knowledgeBaseIds: ['x', ''] } })).toEqual(['x', 'y']);
        expect(appKbIds(null)).toEqual([]);
    });
});
