import { render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { NoticeModel } from '../components/chat/chatSignals/chatSignalsModel';
import { queryWrapper } from '../test/queryWrapper';
import DirectChatViewJs from './DirectChatView';

/**
 * Conversations shared into a project are direct chats too: a member who may
 * post sees the chat-signals line under the composer (their turns count as
 * `direct`), and a member who may only read gets no composer, so no line and
 * nothing to count. Rendered whole, with the real composer; the network is a
 * spy on fetch that answers every read with an empty object.
 */

// The view is untyped .jsx with a long prop list; only a few matter here.
const DirectChatView = DirectChatViewJs as unknown as React.ComponentType<Record<string, unknown>>;

const VERSION = '2026-10-14T09:00:00.000Z';
const NOTICE: NoticeModel = {
    surface: 'direct', state: 'on', from: '2026-10-14', version: VERSION, signals: ['outcomes'],
    noticeUrl: null, marker: `direct@${VERSION}`, optedOut: false,
};
const MESSAGES = [
    { id: 'm1', role: 'user', content: 'Hello' },
    { id: 'm2', role: 'assistant', content: 'Hi.' },
];

let fetchSpy: MockInstance<typeof fetch>;
beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (
        { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    ));
});
afterEach(() => { fetchSpy.mockRestore(); });

function renderView(conversation: Record<string, unknown>) {
    const props = {
        isMobile: false, setSidebarOpen: vi.fn(), user: { id: 'u1', name: 'Tester', betaFeatures: [] },
        notebooksEnabled: false, conversationStarted: true,
        coworkMode: 'chat', setCoworkMode: vi.fn(), inCoworkMode: false,
        sidePanelDocumentId: null, openDocumentInSidePanel: vi.fn(), closeDocumentPanel: vi.fn(),
        canUseWebpagesSide: false, webpageButtonRefDirect: { current: null }, sidePanelWebpageId: null, closeWebpagePanel: vi.fn(),
        webpagePickerOpen: false, setWebpagePickerOpen: vi.fn(), openWebpageInSidePanel: vi.fn(),
        messagesContainerRef: { current: null }, messagesEndRef: { current: null }, shouldForceScrollRef: { current: false },
        messages: MESSAGES, chatInput: '', setChatInput: vi.fn(), sendMessage: vi.fn(), stopGenerating: vi.fn(), isLoading: false,
        modelTiers: null, selectedTier: 'fast', setSelectedTier: vi.fn(),
        activeSkillIds: [], handleToggleSkill: vi.fn(), handleVoiceTurnComplete: vi.fn(), coworkComposer: null,
        directSessionSkills: [], directActivatedSessionSkillIds: [], directCompletedSessionSkillIds: [],
        currentDirectConversation: conversation, directChatKbs: null, directChatKBIds: [], setDirectChatKBIds: vi.fn(),
        attachedWebpageSelection: null, clearWebpageSelection: vi.fn(), setAttachedWebpageSelection: vi.fn(),
        retryMessage: vi.fn(), editAndRegenerate: vi.fn(),
        renderSidePanels: () => null,
        chatSignals: { notice: NOTICE, setCounted: vi.fn() },
    };
    return render(<DirectChatView {...props} />, { wrapper: queryWrapper() });
}

describe('DirectChatView: chat signals in a chat shared into a project', () => {
    it('a member who may post sees the line in the composer', async () => {
        renderView({ id: 'c1', shared: true, access: { canPost: true } });
        expect(await screen.findByTestId('chat-signals-line')).toBeTruthy();
        expect(screen.getByTestId('composer-footer')).toBeTruthy();
        expect(screen.queryByTestId('shared-chat-read-only')).toBeNull();
    });

    it('a reader gets the read-only note instead of a composer: no line, nothing to count', async () => {
        renderView({ id: 'c1', readOnly: true, access: { canPost: false } });
        expect(await screen.findByTestId('shared-chat-read-only')).toBeTruthy();
        expect(screen.queryByTestId('chat-signals-line')).toBeNull();
        expect(screen.queryByTestId('composer-footer')).toBeNull();
    });
});
