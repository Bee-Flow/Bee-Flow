import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import InputArea from './InputArea';
import { invalidateShieldStatus } from '../../hooks/useShieldStatus';
import { queryWrapper } from '../../test/queryWrapper';

// The hooks under this tree read through React Query, so every render needs
// a client above it — a fresh one per render, never the app singleton.
const render = (ui, options) => rtlRender(ui, { wrapper: queryWrapper(), ...options });

/**
 * The knowledge-base pill (C3): what this chat is grounded on, and the one
 * control that changes it.
 *
 * Two claims are being made every time it renders, and both are checkable by
 * nobody but us:
 *
 *   1. THE COUNT IS REAL. It is the selection narrowed to what /api/kb just
 *      returned — never the raw stored ids, which keep a base that was
 *      deleted, unshared, or taken out of chat long after the server stopped
 *      searching it.
 *   2. THE SILENCE IS REAL. With no list there is no pill, because "no
 *      knowledge bases" and "we could not ask" look the same to a reader and
 *      mean opposite things about where their answer came from. The failing
 *      fetch has its own test below for exactly that reason.
 *
 * And one thing that is not a claim but an outcome: a tick in the picker is
 * the SERVER's answer to a PATCH, not the click that caused it. A rejected
 * change leaves the selection where it was and says so.
 */

vi.mock('../skills/ActiveSkillChips', () => ({ default: () => null }));
vi.mock('../skills/SkillsPopover', () => ({ default: () => null }));
vi.mock('./Voice/VoiceInlinePanel', () => ({ default: () => <div /> }));
vi.mock('./Voice/useVoiceChatReady', () => ({ default: () => false }));

/** What a PATCH of the attached list should answer, per test. */
let patchReply = { ok: true, status: 200, body: { success: true, knowledgeBaseIds: [] } };
let patchCalls = [];

beforeEach(() => {
    patchCalls = [];
    patchReply = { ok: true, status: 200, body: { success: true, knowledgeBaseIds: [] } };
    invalidateShieldStatus();
    vi.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
        const href = String(url);
        if (/\/ai\/direct\/conversations\//.test(href) && options.method === 'PATCH') {
            patchCalls.push({ href, body: JSON.parse(options.body) });
            if (patchReply.throws) throw new Error('offline');
            return {
                ok: patchReply.ok,
                status: patchReply.status,
                json: async () => patchReply.body,
                text: async () => '',
            };
        }
        if (href.includes('/privacy/shield-status')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ enabled: false, source: 'off', action: null, failMode: 'fail_closed', guardReachable: false, euMode: false, coworkEnabled: false }),
                text: async () => '',
            };
        }
        const body = href.includes('/ai/user-settings')
            ? { isGoogleUser: false, enabledApps: null, orgEnabledIntegrations: null }
            : {};
        return { ok: true, status: 200, json: async () => body, text: async () => '' };
    });
});

const KB = (id, name, extra = {}) => ({ id, name, document_count: 3, usage_contexts: ['direct_chat'], ...extra });

/** A signed-in user who is allowed to see the picker at all. */
const USER = { id: 1, name: 'Tester', betaFeatures: ['knowledge_bases_beta'] };

function Harness({ onIdsChange, ...props } = {}) {
    const [input, setInput] = useState('');
    const [ids, setIds] = useState(props.selectedKBIds || []);
    return (
        <InputArea
            onSendMessage={vi.fn()}
            onStopGenerating={vi.fn()}
            isLoading={false}
            directMode
            input={input}
            setInput={setInput}
            user={USER}
            directConversationId="conv-1"
            {...props}
            selectedKBIds={ids}
            onChangeKBIds={(next) => { setIds(next); if (onIdsChange) onIdsChange(next); }}
        />
    );
}

const openPicker = async () => {
    const pill = await screen.findByTestId('composer-pill-kb');
    fireEvent.click(pill);
    return screen.findByTestId('composer-kb-picker');
};

describe('the KB pill — when it may not speak', () => {
    it('shows nothing at all while the list has not been fetched', async () => {
        render(<Harness availableKBs={null} />);
        await screen.findByTestId('composer-tools-button');
        expect(screen.queryByTestId('composer-pill-kb')).not.toBeInTheDocument();
    });

    it('shows nothing when the fetch FAILED, even holding attached ids', async () => {
        // The path this whole design turns on. A call site that could not read
        // /api/kb passes null, and the pill that would otherwise say "none"
        // — while this chat is in fact grounded on two bases — stays away.
        render(<Harness availableKBs={null} selectedKBIds={['kb1', 'kb2']} />);
        await screen.findByTestId('composer-tools-button');
        expect(screen.queryByTestId('composer-pill-kb')).not.toBeInTheDocument();
        expect(screen.queryByText(/knowledge/i)).not.toBeInTheDocument();
    });

    it('speaks once the list came back empty — that is an answer', async () => {
        render(<Harness availableKBs={[]} />);
        expect(await screen.findByTestId('composer-pill-kb')).toHaveTextContent('Knowledge');
        expect(screen.queryByTestId('composer-pill-kb-count')).not.toBeInTheDocument();
    });

    it('stays away from an anonymous embed and from Simple Mode', async () => {
        const { rerender } = render(
            <InputArea
                onSendMessage={vi.fn()} onStopGenerating={vi.fn()} isLoading={false} directMode
                input="" setInput={vi.fn()} user={null}
                availableKBs={[KB('kb1', 'Handbook')]} selectedKBIds={[]} onChangeKBIds={vi.fn()}
            />,
        );
        await screen.findByTestId('composer-tools-button');
        expect(screen.queryByTestId('composer-pill-kb')).not.toBeInTheDocument();

        rerender(
            <InputArea
                onSendMessage={vi.fn()} onStopGenerating={vi.fn()} isLoading={false} directMode
                input="" setInput={vi.fn()} user={{ ...USER, simpleMode: true }}
                availableKBs={[KB('kb1', 'Handbook')]} selectedKBIds={[]} onChangeKBIds={vi.fn()}
            />,
        );
        expect(screen.queryByTestId('composer-pill-kb')).not.toBeInTheDocument();
    });

    it('says nothing where there is nothing attached and no picker to offer', async () => {
        render(
            <InputArea
                onSendMessage={vi.fn()} onStopGenerating={vi.fn()} isLoading={false} directMode
                input="" setInput={vi.fn()} user={{ id: 1, name: 'Tester', betaFeatures: [] }}
                availableKBs={[KB('kb1', 'Handbook')]} selectedKBIds={[]} onChangeKBIds={vi.fn()}
            />,
        );
        await screen.findByTestId('composer-tools-button');
        expect(screen.queryByTestId('composer-pill-kb')).not.toBeInTheDocument();
    });
});

describe('the KB pill — telling without offering', () => {
    /**
     * The picker is behind a product gate; the GROUNDING is not. A chat that
     * carries bases searches them for whoever opens it, so an account without
     * the gate must still be told — otherwise the retrieval is real and
     * invisible, which is the failure the pill exists to prevent, only quieter.
     */
    const ungated = { id: 2, name: 'Reader', betaFeatures: [] };

    it('states what an account without the picker is grounded on', async () => {
        render(
            <InputArea
                onSendMessage={vi.fn()} onStopGenerating={vi.fn()} isLoading={false} directMode
                input="" setInput={vi.fn()} user={ungated} directConversationId="conv-1"
                availableKBs={[KB('kb1', 'Handbook')]} selectedKBIds={['kb1']} onChangeKBIds={vi.fn()}
            />,
        );
        const pill = await screen.findByTestId('composer-pill-kb');
        expect(pill).toHaveTextContent('Handbook');
        // A statement, not a control: no tab stop, and no picker promised.
        expect(pill.tagName).toBe('SPAN');
        expect(pill).not.toHaveAttribute('aria-haspopup');
        fireEvent.click(pill);
        expect(screen.queryByTestId('composer-kb-picker')).not.toBeInTheDocument();
    });

    it('stays a control for an account that may change the list', async () => {
        render(<Harness availableKBs={[KB('kb1', 'Handbook')]} selectedKBIds={['kb1']} />);
        const pill = await screen.findByTestId('composer-pill-kb');
        expect(pill.tagName).toBe('BUTTON');
        expect(pill).toHaveAttribute('aria-haspopup', 'dialog');
    });

    it('says nothing to an account with neither the picker nor a grounding', async () => {
        render(
            <InputArea
                onSendMessage={vi.fn()} onStopGenerating={vi.fn()} isLoading={false} directMode
                input="" setInput={vi.fn()} user={ungated}
                availableKBs={[KB('kb1', 'Handbook')]} selectedKBIds={[]} onChangeKBIds={vi.fn()}
            />,
        );
        await screen.findByTestId('composer-tools-button');
        expect(screen.queryByTestId('composer-pill-kb')).not.toBeInTheDocument();
    });
});

describe('the KB pill — what it counts', () => {
    it('names the one base it is grounded on', async () => {
        render(<Harness availableKBs={[KB('kb1', 'Handbook'), KB('kb2', 'Policies')]} selectedKBIds={['kb1']} />);
        const pill = await screen.findByTestId('composer-pill-kb');
        expect(pill).toHaveTextContent('Handbook');
        expect(screen.queryByTestId('composer-pill-kb-count')).not.toBeInTheDocument();
    });

    it('counts them once there is no room to name them', async () => {
        render(<Harness availableKBs={[KB('kb1', 'Handbook'), KB('kb2', 'Policies')]} selectedKBIds={['kb1', 'kb2']} />);
        const pill = await screen.findByTestId('composer-pill-kb');
        expect(pill).toHaveTextContent('Knowledge');
        expect(screen.getByTestId('composer-pill-kb-count')).toHaveTextContent('2');
        expect(pill.getAttribute('title')).toBe('Grounded on Handbook, Policies');
    });

    it('does not count an id the server did not return', async () => {
        // 'ghost' still sits in the conversation's column; the server dropped
        // it from this read, so the pill drops it too.
        render(<Harness availableKBs={[KB('kb1', 'Handbook')]} selectedKBIds={['kb1', 'ghost']} />);
        const pill = await screen.findByTestId('composer-pill-kb');
        expect(pill).toHaveTextContent('Handbook');
        expect(screen.queryByTestId('composer-pill-kb-count')).not.toBeInTheDocument();
    });

    it('does not count a base its owner kept out of chat', async () => {
        render(
            <Harness
                availableKBs={[KB('kb1', 'Handbook'), KB('kb2', 'Agent only', { usage_contexts: ['agent'] })]}
                selectedKBIds={['kb1', 'kb2']}
            />,
        );
        const pill = await screen.findByTestId('composer-pill-kb');
        expect(pill).toHaveTextContent('Handbook');
        expect(screen.queryByTestId('composer-pill-kb-count')).not.toBeInTheDocument();
    });
});

describe('the KB pill — one owner for the picker', () => {
    it('opens the picker under the pill, and offers only chat-usable bases', async () => {
        render(
            <Harness availableKBs={[KB('kb1', 'Handbook'), KB('kb2', 'Agent only', { usage_contexts: ['agent'] })]} />,
        );
        const pill = await screen.findByTestId('composer-pill-kb');
        expect(pill).toHaveAttribute('aria-expanded', 'false');

        const panel = await openPicker();
        expect(pill).toHaveAttribute('aria-expanded', 'true');
        // Under the pill, not in the "+" menu's flyout: one control owns
        // `showKBPicker`, so the panel is a sibling of the thing clicked.
        expect(pill.parentElement.contains(panel)).toBe(true);
        expect(screen.getByText('Handbook')).toBeInTheDocument();
        expect(screen.queryByText('Agent only')).not.toBeInTheDocument();
    });

    it('has no row left in the "+" menu that could fight it for the open state', async () => {
        render(<Harness availableKBs={[KB('kb1', 'Handbook')]} />);
        fireEvent.click(await screen.findByTestId('composer-tools-button'));
        expect(screen.getByTestId('composer-tool-attach')).toBeInTheDocument();
        expect(screen.queryByTestId('composer-tool-knowledge-bases')).not.toBeInTheDocument();
    });
});

describe('the KB pill — changing what a chat is grounded on', () => {
    it('saves the change and then shows what the SERVER stored', async () => {
        // Two ticked in the UI, one stored: the server re-authorises, and the
        // composer follows the answer rather than its own request.
        patchReply = { ok: true, status: 200, body: { success: true, knowledgeBaseIds: ['kb1'] } };
        const onIdsChange = vi.fn();
        render(
            <Harness
                availableKBs={[KB('kb1', 'Handbook'), KB('kb2', 'Policies')]}
                selectedKBIds={['kb1']}
                onIdsChange={onIdsChange}
            />,
        );
        await openPicker();
        fireEvent.click(screen.getByRole('checkbox', { name: /Policies/ }));

        await waitFor(() => expect(patchCalls).toHaveLength(1));
        expect(patchCalls[0].href).toContain('/ai/direct/conversations/conv-1');
        expect(patchCalls[0].body).toEqual({ knowledgeBaseIds: ['kb1', 'kb2'] });
        await waitFor(() => expect(onIdsChange).toHaveBeenCalledWith(['kb1']));
        // …and the picker shows that answer: Policies is not ticked.
        await waitFor(() => expect(screen.getByRole('checkbox', { name: /Policies/ })).not.toBeChecked());
        expect(screen.getByRole('checkbox', { name: /Handbook/ })).toBeChecked();
    });

    it('detaches everything through the same round trip', async () => {
        patchReply = { ok: true, status: 200, body: { success: true, knowledgeBaseIds: [] } };
        const onIdsChange = vi.fn();
        render(
            <Harness availableKBs={[KB('kb1', 'Handbook')]} selectedKBIds={['kb1']} onIdsChange={onIdsChange} />,
        );
        await openPicker();
        fireEvent.click(screen.getByText('Clear'));

        await waitFor(() => expect(patchCalls[0].body).toEqual({ knowledgeBaseIds: [] }));
        await waitFor(() => expect(onIdsChange).toHaveBeenCalledWith([]));
    });

    it('sends the confirmed ids only, so one dead id cannot wedge the picker', async () => {
        // Resending 'ghost' would make the server refuse every later change
        // (400, nothing stored) — the picker would look broken, not stale.
        patchReply = { ok: true, status: 200, body: { success: true, knowledgeBaseIds: ['kb1', 'kb2'] } };
        render(
            <Harness
                availableKBs={[KB('kb1', 'Handbook'), KB('kb2', 'Policies')]}
                selectedKBIds={['kb1', 'ghost']}
            />,
        );
        await openPicker();
        fireEvent.click(screen.getByRole('checkbox', { name: /Policies/ }));

        await waitFor(() => expect(patchCalls).toHaveLength(1));
        expect(patchCalls[0].body).toEqual({ knowledgeBaseIds: ['kb1', 'kb2'] });
    });

    it('keeps the selection and says why when the server refuses an id', async () => {
        patchReply = {
            ok: false, status: 400,
            body: { error: 'One or more knowledge bases are not available', invalid: ['kb2'] },
        };
        const onIdsChange = vi.fn();
        render(
            <Harness
                availableKBs={[KB('kb1', 'Handbook'), KB('kb2', 'Policies')]}
                selectedKBIds={['kb1']}
                onIdsChange={onIdsChange}
            />,
        );
        await openPicker();
        fireEvent.click(screen.getByRole('checkbox', { name: /Policies/ }));

        const error = await screen.findByTestId('composer-kb-error');
        expect(error).toHaveTextContent('not available to you');
        expect(onIdsChange).not.toHaveBeenCalled();
        expect(screen.getByRole('checkbox', { name: /Policies/ })).not.toBeChecked();
        expect(screen.getByRole('checkbox', { name: /Handbook/ })).toBeChecked();
    });

    it('says the change did not land when the network drops it', async () => {
        patchReply = { throws: true };
        const onIdsChange = vi.fn();
        render(
            <Harness availableKBs={[KB('kb1', 'Handbook')]} selectedKBIds={[]} onIdsChange={onIdsChange} />,
        );
        await openPicker();
        fireEvent.click(screen.getByRole('checkbox', { name: /Handbook/ }));

        expect(await screen.findByTestId('composer-kb-error')).toHaveTextContent('could not be saved');
        expect(onIdsChange).not.toHaveBeenCalled();
        expect(screen.getByRole('checkbox', { name: /Handbook/ })).not.toBeChecked();
    });

    it('names the owner rule rather than a generic failure on a 403', async () => {
        patchReply = { ok: false, status: 403, body: { error: 'Only the owner can change the attached knowledge bases' } };
        render(<Harness availableKBs={[KB('kb1', 'Handbook')]} selectedKBIds={[]} />);
        await openPicker();
        fireEvent.click(screen.getByRole('checkbox', { name: /Handbook/ }));
        expect(await screen.findByTestId('composer-kb-error')).toHaveTextContent('Only the owner');
    });

    it('holds the choice locally while the chat has no id to save it against', async () => {
        // The conversation is created by the first turn, which carries the
        // list with it — there is nothing to PATCH yet.
        const onIdsChange = vi.fn();
        render(
            <Harness
                directConversationId={null}
                availableKBs={[KB('kb1', 'Handbook')]}
                selectedKBIds={[]}
                onIdsChange={onIdsChange}
            />,
        );
        await openPicker();
        fireEvent.click(screen.getByRole('checkbox', { name: /Handbook/ }));

        await waitFor(() => expect(onIdsChange).toHaveBeenCalledWith(['kb1']));
        expect(patchCalls).toHaveLength(0);
        expect(screen.getByRole('checkbox', { name: /Handbook/ })).toBeChecked();
    });
});
