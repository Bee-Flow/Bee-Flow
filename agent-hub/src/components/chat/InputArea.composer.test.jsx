import { render as rtlRender, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import InputArea from './InputArea';
import { invalidateShieldStatus } from '../../hooks/useShieldStatus';
import { queryWrapper } from '../../test/queryWrapper';

// The hooks under this tree read through React Query, so every render needs
// a client above it — a fresh one per render, never the app singleton.
const render = (ui, options) => rtlRender(ui, { wrapper: queryWrapper(), ...options });

/**
 * What the composer SHOWS and SAYS.
 *
 * Two ideas are pinned here, and they pull against each other on purpose.
 *
 * 1. The box stays quiet. Eight loose icons became one "+", and the options
 *    behind it did not disappear with the row. Anything that goes back out
 *    onto the toolbar has to earn it, so the tests below name the four that
 *    did — the tier, Skills, the knowledge bases, the source count — as a
 *    closed list, and check that the rest is still one click deep.
 *
 * 2. Nothing it says may be unearned. Three of those statements can lie: a
 *    tier read off a list the server never sent, a green lock while the
 *    detector is down, a count of sources a surface does not have. Each has a
 *    test for the case where it must show NOTHING, because an absent pill is
 *    only a small loss and a lying one is the whole product.
 *
 * The earlier version of this file asserted that `attach-file-button`,
 * `web-search-toggle` and `apps-picker-button` were absent from the DOM. That
 * was a description of one afternoon's markup rather than a decision: it could
 * not tell a pill that belongs on the toolbar from an icon that does not, and
 * it was wrong about the apps picker in Cowork mode. It is replaced by the
 * closed list above.
 */

vi.mock('../skills/ActiveSkillChips', () => ({ default: () => null }));
vi.mock('../skills/SkillsPopover', () => ({
    default: ({ open }) => (open ? <div data-testid="skills-popover" /> : null),
}));
vi.mock('./Voice/VoiceInlinePanel', () => ({
    default: () => <div data-testid="voice-inline-panel" />,
}));

let voiceReady = false;
vi.mock('./Voice/useVoiceChatReady', () => ({ default: () => voiceReady }));

/** Whatever GET /api/privacy/shield-status should answer for this test. */
let shieldBody = { enabled: false, source: 'off', action: null, failMode: 'fail_closed', guardReachable: false, euMode: false, coworkEnabled: false };
let shieldOk = true;

beforeEach(() => {
    voiceReady = false;
    shieldOk = true;
    shieldBody = { enabled: false, source: 'off', action: null, failMode: 'fail_closed', guardReachable: false, euMode: false, coworkEnabled: false };
    // The hook memoises its answer module-wide for 25s and shares it between
    // instances — exactly what we want on a screen, and exactly what would
    // leak one test's shield into the next.
    invalidateShieldStatus();
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
        const href = String(url);
        if (href.includes('/privacy/shield-status')) {
            return { ok: shieldOk, status: shieldOk ? 200 : 401, json: async () => shieldBody, text: async () => '' };
        }
        const body = href.includes('/ai/user-settings')
            ? { isGoogleUser: true, enabledApps: null, orgEnabledIntegrations: null }
            : {};
        return { ok: true, status: 200, json: async () => body, text: async () => '' };
    });
});

/** Four depth tiers, the shape /ai/config/tiers-for-user actually returns. */
const TIERS = {
    auto: { auto: true },
    fast: { modelId: 'claude-sonnet-5' },
    thinking: { modelId: 'claude-sonnet-5' },
    pro: { modelId: 'claude-opus-5' },
};

function Harness(props = {}) {
    const [input, setInput] = useState(props.initialInput || '');
    return (
        <InputArea
            onSendMessage={vi.fn()}
            onStopGenerating={vi.fn()}
            isLoading={false}
            directMode
            input={input}
            setInput={setInput}
            user={{ id: 1, name: 'Tester', betaFeatures: [] }}
            shieldApplies
            {...props}
        />
    );
}

describe('InputArea — what is on the toolbar', () => {
    it('keeps every tool one click deep, behind a single button', async () => {
        render(<Harness />);
        const plus = await screen.findByTestId('composer-tools-button');

        // Shut, the menu shows nothing but itself.
        expect(screen.queryByTestId('composer-tool-attach')).not.toBeInTheDocument();
        expect(screen.queryByTestId('composer-tool-apps')).not.toBeInTheDocument();

        fireEvent.click(plus);
        expect(screen.getByTestId('composer-tool-attach')).toBeInTheDocument();
        // Apps waits for the integration read; each render here starts with an
        // empty query cache, where the app would usually have it already.
        expect(await screen.findByTestId('composer-tool-apps')).toBeInTheDocument();
    });

    it('lets exactly four things back onto the toolbar', async () => {
        // The closed list: what the next message runs on, what it brings with
        // it, what it is grounded on, and what it can look things up in.
        // Everything else stays behind the "+", or the row is back and the
        // redesign was for nothing.
        render(
            <Harness
                modelTiers={TIERS}
                selectedTier="thinking"
                sourceCount={4}
                onToggleSkill={vi.fn()}
                availableKBs={[{ id: 'kb1', name: 'Handbook' }]}
                selectedKBIds={['kb1']}
                onChangeKBIds={vi.fn()}
                user={{ id: 1, name: 'Tester', betaFeatures: ['skills'] }}
            />,
        );
        await screen.findByTestId('composer-tools-button');

        const toolbar = screen.getByTestId('composer-tools-button').closest('.justify-between');
        // `:not([…$="-count"])` because a pill's own badge carries
        // `composer-pill-<x>-count`. Without it, giving a pill a number counts
        // as a fifth thing on the toolbar and this test fails for a change it
        // has no opinion about.
        const pills = toolbar.querySelectorAll('[data-testid^="composer-pill-"]:not([data-testid$="-count"])');
        // No tier pill: this is direct mode, where the gauge beside Send is
        // the control AND carries the same four names. See the C2 block.
        expect(Array.from(pills).map(p => p.dataset.testid).sort()).toEqual([
            'composer-pill-kb',
            'composer-pill-skills',
            'composer-pill-sources',
        ]);
    });

    it('groups the pills with the "+", not loose across the row', async () => {
        // The toolbar is justify-between with two children. A third gets
        // pushed to the middle of the composer — which is where the apps
        // picker once ended up floating.
        // Needs a pill to locate, and direct mode no longer draws the tier
        // one (the gauge owns that), so this asks for Skills.
        render(
            <Harness
                modelTiers={TIERS}
                selectedTier="fast"
                onToggleSkill={vi.fn()}
                user={{ id: 1, name: 'Tester', betaFeatures: ['skills'] }}
            />,
        );
        const plus = await screen.findByTestId('composer-tools-button');
        const row = plus.closest('.justify-between');
        const groupOf = (el) => Array.from(row.children).find(child => child.contains(el));

        expect(groupOf(screen.getByTestId('composer-pill-skills'))).toBe(groupOf(plus));
        // The comment above is the assertion: two children, so `justify-between`
        // pushes them apart instead of stranding a third in the middle. Without
        // this line a third child passes, because colocating two of them stays
        // true no matter how many there are.
        expect(row.children).toHaveLength(2);
    });
});

describe('InputArea — the tier it will run on (C2)', () => {
    // The pill lives in AGENT chat, where there is no gauge. Direct mode has
    // the gauge beside Send — it is the control and it carries the same four
    // names — so the pill stands down there rather than restating it a few
    // pixels away. `agentOn` is that chat: no directMode, no tier map, and the
    // tier read off the agent's own `model`.
    const agentOn = (tierKey, extra = {}) => (
        <Harness
            directMode={undefined}
            modelTiers={undefined}
            selectedAgent={{ id: 'a1', name: 'Sales', model: `tier:${tierKey}` }}
            {...extra}
        />
    );

    it('stands down for the gauge in direct mode — one fact, one surface', async () => {
        render(<Harness modelTiers={TIERS} selectedTier="pro" />);
        await screen.findByTestId('composer-tools-button');
        expect(screen.queryByTestId('composer-pill-tier')).not.toBeInTheDocument();
        // And it is not that the tier was unknown: the same selection renders
        // the pill in agent chat, where nothing else says it.
        cleanup();
        render(agentOn('pro'));
        expect(await screen.findByTestId('composer-pill-tier')).toHaveTextContent('Deep Thinking');
    });

    it('names the tier, and never the model behind it', async () => {
        render(agentOn('pro'));
        const pill = await screen.findByTestId('composer-pill-tier');

        expect(pill).toHaveTextContent('Deep Thinking');
        expect(pill.textContent).not.toMatch(/claude|opus|sonnet/i);
    });

    it('says nothing for a tier it cannot name without the server map', async () => {
        // A custom tier would render as its raw id — a model-shaped string in
        // the composer, which is exactly what B4 forbids.
        render(agentOn('custom:legal'));
        await screen.findByTestId('composer-tools-button');
        expect(screen.queryByTestId('composer-pill-tier')).not.toBeInTheDocument();
    });

    it('says nothing when the agent runs on a named model rather than a tier', async () => {
        render(
            <Harness
                directMode={undefined}
                modelTiers={undefined}
                selectedAgent={{ id: 'a1', name: 'Sales', model: 'claude-opus-5' }}
            />,
        );
        await screen.findByTestId('composer-tools-button');
        expect(screen.queryByTestId('composer-pill-tier')).not.toBeInTheDocument();
    });

    it('shows Auto plainly until an answer says what Auto picked', async () => {
        const { rerender } = render(agentOn('auto', { messages: [] }));
        expect(await screen.findByTestId('composer-pill-tier')).toHaveTextContent(/^Auto$/);

        rerender(agentOn('auto', {
            messages: [
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: 'hello', autoSelectedTier: 'pro', modelId: 'claude-opus-5' },
            ],
        }));
        const pill = await screen.findByTestId('composer-pill-tier');
        expect(pill).toHaveTextContent('Auto · Deep Thinking');
        expect(pill.textContent).not.toMatch(/opus/i);
    });

    it('drops back to plain Auto when the newest answer did not say', async () => {
        // The LAST answer is the only one that describes the router's current
        // behaviour. Carrying an older one forward would show a tier this chat
        // is not on, which is a wrong claim rather than a missing one — and a
        // turn that reported no tier at all must not be filled in from
        // somewhere else.
        render(agentOn('auto', {
            messages: [
                { role: 'user', content: 'one' },
                { role: 'assistant', content: 'first', autoSelectedTier: 'fast' },
                { role: 'user', content: 'two' },
                { role: 'assistant', content: 'second' },
            ],
        }));
        expect(await screen.findByTestId('composer-pill-tier')).toHaveTextContent(/^Auto$/);
    });

    it('reads an agent tier off the agent, where there is no picker at all', async () => {
        render(
            <Harness
                directMode={undefined}
                modelTiers={undefined}
                selectedAgent={{ id: 'a1', name: 'Sales', model: 'tier:thinking' }}
            />,
        );
        const pill = await screen.findByTestId('composer-pill-tier');
        expect(pill).toHaveTextContent('Think');
        // Nothing to open: an agent's tier is set where the agent is edited.
        expect(pill.tagName).toBe('SPAN');
    });

    it('stays silent when an agent is pinned to a concrete model', async () => {
        // `agent.model` holds either 'tier:<key>' or a raw model id. The raw
        // id is precisely the string the composer may not print.
        render(
            <Harness
                directMode={undefined}
                modelTiers={undefined}
                selectedAgent={{ id: 'a1', name: 'Sales', model: 'claude-opus-5' }}
            />,
        );
        await screen.findByTestId('composer-tools-button');
        expect(screen.queryByTestId('composer-pill-tier')).not.toBeInTheDocument();
    });

    it('tells an anonymous embed visitor nothing about the org setup', async () => {
        // EmbedChat passes no user. A tier name is this organisation's own
        // configuration, and the visitor is a stranger on a customer's site.
        render(
            <Harness
                user={undefined}
                directMode={undefined}
                modelTiers={undefined}
                selectedAgent={{ id: 'a1', name: 'Sales', model: 'tier:pro' }}
            />,
        );
        await screen.findByTestId('composer-tools-button');
        expect(screen.queryByTestId('composer-pill-tier')).not.toBeInTheDocument();
    });
});

describe('InputArea — Skills (C4)', () => {
    const skillUser = { id: 1, name: 'Tester', betaFeatures: ['skills'] };

    it('opens the skills picker, and is the only thing that does', async () => {
        render(<Harness user={skillUser} onToggleSkill={vi.fn()} />);
        const pill = await screen.findByTestId('composer-pill-skills');

        fireEvent.click(pill);
        expect(await screen.findByTestId('skills-popover')).toBeInTheDocument();

        // The "+" menu must NOT keep a second door to the same state: two
        // owners means one opens the picker and the other shuts it again.
        fireEvent.click(screen.getByTestId('composer-tools-button'));
        expect(screen.queryByTestId('composer-tool-skills')).not.toBeInTheDocument();

        fireEvent.click(pill);
        await waitFor(() => expect(screen.queryByTestId('skills-popover')).not.toBeInTheDocument());
    });

    it('counts the skills that will actually apply to the next send', async () => {
        render(
            <Harness
                user={skillUser}
                onToggleSkill={vi.fn()}
                activeSkillIds={['s1', 's2']}
                agentAttachedSkillIds={['s2', 's3']}
            />,
        );
        // The union, not the sum — a skill both attached and switched on is one.
        expect(await screen.findByTestId('composer-pill-skills-count')).toHaveTextContent('3');
    });

    it('shows no pill where the beta is off — an empty promise is worse', async () => {
        render(<Harness onToggleSkill={vi.fn()} user={{ id: 1, betaFeatures: [] }} />);
        await screen.findByTestId('composer-tools-button');
        expect(screen.queryByTestId('composer-pill-skills')).not.toBeInTheDocument();
    });

    it('shows no pill where the call site wired no toggle', async () => {
        render(<Harness user={skillUser} />);
        await screen.findByTestId('composer-tools-button');
        expect(screen.queryByTestId('composer-pill-skills')).not.toBeInTheDocument();
    });
});

describe('InputArea — the privacy line (C5)', () => {
    const shield = (over) => ({
        enabled: true, source: 'org', action: 'redact', failMode: 'fail_closed',
        guardReachable: true, euMode: false, coworkEnabled: false, ...over,
    });

    it('says data is replaced only when something actually masks it', async () => {
        shieldBody = shield({ action: 'redact' });
        render(<Harness />);
        const line = await screen.findByTestId('composer-shield-line');
        expect(line).toHaveTextContent('Personal data is replaced before sending');
        expect(line.dataset.shieldTone).toBe('ok');
    });

    it('does not borrow the word "replaced" for an action that blocks', async () => {
        shieldBody = shield({ action: 'block' });
        render(<Harness />);
        const line = await screen.findByTestId('composer-shield-line');
        expect(line).toHaveTextContent('Messages holding personal data are blocked');
        expect(line.textContent).not.toMatch(/replaced/i);
    });

    it('warns instead of reassuring when the shield is on but nothing can scan', async () => {
        // The configuration is provable; the protection is not. Say the first.
        shieldBody = shield({ guardReachable: false });
        render(<Harness />);
        const line = await screen.findByTestId('composer-shield-line');
        expect(line).toHaveTextContent('Privacy Shield is on, but personal data cannot be checked right now');
        expect(line.dataset.shieldTone).toBe('warn');
    });

    it('claims nothing on a call site whose send route does not shield', async () => {
        // The regression this pins: the line used to be gated on `user` alone,
        // so BuildTab — which posts to routes/ai/automationBuilder/chatStream.js,
        // a route that applies no shield — rendered a green "Personal data is
        // replaced before sending" over a box that replaces nothing. A privacy
        // claim is opt-in per call site; having a logged-in user is not consent
        // to make one on their behalf.
        shieldBody = shield({ action: 'redact' });   // the shield IS on for this user
        render(<Harness shieldApplies={false} />);
        await screen.findByTestId('composer-tools-button');
        await waitFor(() => expect(screen.queryByTestId('composer-shield-line')).not.toBeInTheDocument());
    });

    it('claims nothing while the status is unknown', async () => {
        shieldOk = false; // 401 / offline / unreadable — all land on data: null
        render(<Harness />);
        await screen.findByTestId('composer-tools-button');
        await waitFor(() => expect(screen.queryByTestId('composer-shield-line')).not.toBeInTheDocument());
    });

    it('says nothing at all when no shield is switched on', async () => {
        shieldBody = shield({ enabled: false, source: 'off', action: null, guardReachable: false });
        render(<Harness />);
        await screen.findByTestId('composer-tools-button');
        await waitFor(() => expect(screen.queryByTestId('composer-shield-line')).not.toBeInTheDocument());
    });

    it('never asks the question on a public embed', async () => {
        // No session there: the route would answer 401 every 30 seconds.
        global.fetch.mockClear();
        render(<Harness user={undefined} />);
        await screen.findByTestId('composer-tools-button');
        const asked = global.fetch.mock.calls.some(([u]) => String(u).includes('/privacy/shield-status'));
        expect(asked).toBe(false);
    });
});

describe('InputArea — the compact variant (NB-8)', () => {
    it('uses the panel’s own words instead of "Message AI..."', async () => {
        render(<Harness compact placeholder="Ask about your sources..." />);
        expect(await screen.findByTestId('chat-message-input'))
            .toHaveAttribute('placeholder', 'Ask about your sources...');
    });

    it('still yields to the thread banner, which describes the same send', async () => {
        render(<Harness compact placeholder="Ask about your sources..." activeThreadParent={{ id: 'm1' }} threadTitle="Quote" />);
        expect(await screen.findByTestId('chat-message-input'))
            .toHaveAttribute('placeholder', 'Reply to thread...');
    });

    it('counts the sources the chat can reach, and pluralises them', async () => {
        const { rerender } = render(<Harness compact sourceCount={4} />);
        expect(await screen.findByTestId('composer-pill-sources')).toHaveTextContent('4 sources');

        rerender(<Harness compact sourceCount={1} />);
        expect(await screen.findByTestId('composer-pill-sources')).toHaveTextContent('1 source');
    });

    it('shows no source pill on a surface that has no sources', async () => {
        // Webpages render the same compact composer and pass no count. `0` is
        // an answer; `null`/absent is "this surface has no such thing".
        render(<Harness compact />);
        await screen.findByTestId('composer-tools-button');
        expect(screen.queryByTestId('composer-pill-sources')).not.toBeInTheDocument();
    });

    it('keeps the AI notice while dropping the keyboard hint', async () => {
        // Both halves, because only the pair says anything: on its own the
        // "not in the document" line also passes when the hint is deleted from
        // the composer altogether, which is a loss rather than the drawer
        // trade-off this test is about.
        const { unmount } = render(<Harness />);
        await screen.findByTestId('composer-tools-button');
        expect(screen.getByText(/Shift\+Enter/)).toBeInTheDocument();
        unmount();

        render(<Harness compact />);
        await screen.findByTestId('composer-tools-button');
        expect(screen.getByText(/AI can make mistakes/)).toBeInTheDocument();
        expect(screen.queryByText(/Shift\+Enter/)).not.toBeInTheDocument();
    });
});

describe('InputArea — send, stop, and the mic', () => {
    it('offers the mic when the box is empty and voice is available', async () => {
        voiceReady = true;
        render(<Harness />);

        const mic = await screen.findByTestId('voice-send-button');
        expect(screen.queryByTestId('send-message-button')).not.toBeInTheDocument();

        fireEvent.click(mic);
        expect(await screen.findByTestId('voice-inline-panel')).toBeInTheDocument();
    });

    it('turns back into Send as soon as there is something to send', async () => {
        voiceReady = true;
        render(<Harness />);
        await screen.findByTestId('voice-send-button');

        fireEvent.change(screen.getByTestId('chat-message-input'), { target: { value: 'hello' } });

        await waitFor(() => expect(screen.getByTestId('send-message-button')).toBeInTheDocument());
        expect(screen.queryByTestId('voice-send-button')).not.toBeInTheDocument();
    });

    it('keeps a plain disabled Send when voice is not available', async () => {
        render(<Harness />);
        const send = await screen.findByTestId('send-message-button');
        expect(send).toBeDisabled();
        expect(screen.queryByTestId('voice-send-button')).not.toBeInTheDocument();
    });

    it('an empty composer wears the same quiet button either way', async () => {
        // The mic is live and clickable, so it cannot borrow the disabled fade —
        // both share a colour class instead, or the composer would jump from
        // pale grey to solid ink just because voice happens to be available.
        const { unmount } = render(<Harness />);
        expect((await screen.findByTestId('send-message-button')).className)
            .toContain('composer-send-quiet');
        unmount();

        voiceReady = true;
        render(<Harness />);
        expect((await screen.findByTestId('voice-send-button')).className)
            .toContain('composer-send-quiet');
    });

    it('Send goes solid as soon as it has something to send', async () => {
        render(<Harness />);
        fireEvent.change(screen.getByTestId('chat-message-input'), { target: { value: 'hi' } });

        await waitFor(() => {
            const send = screen.getByTestId('send-message-button');
            expect(send).not.toBeDisabled();
            expect(send.className).not.toContain('composer-send-quiet');
        });
    });
});
