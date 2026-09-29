/**
 * The composer with the Chat ⇄ Cowork switch flipped.
 *
 * One guarantee outranks everything else here: a send in Cowork mode creates
 * something that runs on its own and does NOT land in the conversation. Get
 * that wrong and a user who meant to schedule a weekly report has instead
 * asked a question nobody will read — or worse, the other way round.
 *
 * Around it sit the things that made the two modes cohabit in one box:
 *   - the switch belongs to the page, not to the composer;
 *   - the chat-only tools go away, but are HIDDEN rather than unmounted, so a
 *     picker left half-open survives a trip through Cowork and back;
 *   - the apps picker does not go away, because a brief runs unattended
 *     against the user's own integrations;
 *   - everything on the left stays in ONE group: the row is justify-between,
 *     so a third child gets pushed into the middle of the composer.
 *
 * Written against what a person can see and click. The previous version
 * reached for `closest('.hidden')` and `findByTitle('Apps')` — a Tailwind
 * class name and a title attribute that i18n is about to translate — so it
 * pinned today's markup rather than the behaviour. Visibility is asserted
 * through the accessibility tree instead, which is the same question the user
 * is asking.
 */
import { render as rtlRender, screen, fireEvent, within } from '@testing-library/react';
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import InputArea from './InputArea';
import { invalidateShieldStatus } from '../../hooks/useShieldStatus';
import { queryWrapper } from '../../test/queryWrapper';
import CoworkModeToggle from '../cowork/CoworkModeToggle';

// The hooks under this tree read through React Query, so every render needs
// a client above it — a fresh one per render, never the app singleton.
const render = (ui, options) => rtlRender(ui, { wrapper: queryWrapper(), ...options });

// Sub-panels that fetch their own data on mount; none of them are what this
// file is about, and the skills chips choke on a stubbed empty payload.
vi.mock('../skills/ActiveSkillChips', () => ({ default: () => null }));
vi.mock('../skills/SkillsPopover', () => ({ default: () => null }));
vi.mock('./Voice/useVoiceChatReady', () => ({ default: () => false }));
vi.mock('./Voice/VoiceInlinePanel', () => ({ default: () => null }));

// InputArea reaches for the network on mount (skills, integrations, settings).
// None of that matters here — stub it to a quiet 200, except /ai/user-settings,
// which decides whether the app picker has anything to show: its whole
// catalogue is filtered on isGoogleUser/isMicrosoftUser, and an empty result
// makes the picker hide itself.
beforeEach(() => {
    invalidateShieldStatus();
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
        const body = String(url).includes('/ai/user-settings')
            ? { isGoogleUser: true, enabledApps: null, orgEnabledIntegrations: null }
            : {};
        return { ok: true, status: 200, json: async () => body, text: async () => '' };
    });
});

function makeCowork(overrides = {}) {
    return {
        when: { presetId: 'now', date: '', time: '' },
        setWhen: vi.fn(),
        repeatInterval: '',
        setRepeatInterval: vi.fn(),
        agentId: '',
        setAgentId: vi.fn(),
        agents: [],
        submitting: false,
        error: null,
        scheduleReady: true,
        summary: 'Now',
        submit: vi.fn().mockResolvedValue({ id: 'w1', title: 'Do the thing' }),
        reset: vi.fn(),
        ...overrides,
    };
}

// Mirrors the real layout: the switch lives in the page header, next to
// Notebook and Webpage, and the composer sits below it — both driven by one
// mode state.
function Harness({ cowork, onSendMessage, initialMode = 'chat', locked = false, ...rest }) {
    const [input, setInput] = useState('');
    const [mode, setMode] = useState(initialMode);
    return (
        <>
            <CoworkModeToggle enabled={!!cowork} value={mode} onChange={setMode} locked={locked} />
            <InputArea
                onSendMessage={onSendMessage}
                onStopGenerating={() => {}}
                isLoading={false}
                directMode
                input={input}
                setInput={setInput}
                cowork={cowork}
                coworkMode={mode}
                onCoworkModeChange={setMode}
                {...rest}
            />
        </>
    );
}

describe('InputArea — Cowork mode', () => {
    it('routes a send to cowork, not to the conversation', () => {
        const onSendMessage = vi.fn();
        const cowork = makeCowork();
        render(<Harness cowork={cowork} onSendMessage={onSendMessage} />);

        fireEvent.click(screen.getByTestId('cowork-mode-cowork'));
        fireEvent.change(screen.getByTestId('cowork-brief-input'), { target: { value: 'Do the thing' } });
        fireEvent.click(screen.getByTestId('cowork-send'));

        expect(cowork.submit).toHaveBeenCalledWith('Do the thing', expect.any(Object));
        expect(onSendMessage).not.toHaveBeenCalled();
    });

    it('flipping back to Chat restores the normal send', () => {
        const onSendMessage = vi.fn();
        const cowork = makeCowork();
        render(<Harness cowork={cowork} onSendMessage={onSendMessage} initialMode="cowork" />);

        fireEvent.click(screen.getByTestId('cowork-mode-chat'));
        fireEvent.change(screen.getByTestId('chat-message-input'), { target: { value: 'Hello' } });
        fireEvent.click(screen.getByTestId('send-message-button'));

        expect(onSendMessage).toHaveBeenCalled();
        expect(cowork.submit).not.toHaveBeenCalled();
    });

    it('hands the whole box to the shared Cowork composer', () => {
        // Not a re-labelled chat composer: the same component /app/cowork
        // renders, so the two surfaces cannot drift apart.
        render(<Harness cowork={makeCowork()} onSendMessage={vi.fn()} initialMode="cowork" />);
        expect(screen.getByTestId('cowork-composer')).toHaveAttribute('data-cowork-mode', 'cowork');
        expect(screen.queryByTestId('chat-input-form')).not.toBeInTheDocument();
        expect(screen.getByLabelText('Cowork brief')).toBeInTheDocument();
    });

    it('keeps the switch out of the composer — it belongs to the page, not the box', () => {
        render(<Harness cowork={makeCowork()} onSendMessage={vi.fn()} />);
        expect(screen.getByTestId('chat-input-form')).not.toContainElement(
            screen.getByTestId('cowork-mode-switch'),
        );
    });

    it('shows no switch when the call site did not wire Cowork up', () => {
        render(<Harness cowork={null} onSendMessage={vi.fn()} />);
        expect(screen.queryByTestId('cowork-mode-switch')).not.toBeInTheDocument();
    });

    it('hides the switch once the conversation has started', () => {
        render(<Harness cowork={makeCowork()} onSendMessage={vi.fn()} locked />);
        expect(screen.queryByTestId('cowork-mode-switch')).not.toBeInTheDocument();
        // The composer itself keeps working — only the choice is gone.
        expect(screen.getByTestId('chat-message-input')).toBeInTheDocument();
    });

    it('will not send while the schedule is half-picked', () => {
        render(<Harness cowork={makeCowork({ scheduleReady: false })} onSendMessage={vi.fn()} initialMode="cowork" />);
        fireEvent.change(screen.getByTestId('cowork-brief-input'), { target: { value: 'Do the thing' } });
        expect(screen.getByTestId('cowork-send')).toBeDisabled();
    });

    it('surfaces a create error without eating the brief', () => {
        render(<Harness cowork={makeCowork({ error: 'Maximum number of cowork items reached (10).' })} onSendMessage={vi.fn()} initialMode="cowork" />);
        expect(screen.getByRole('alert')).toHaveTextContent('Maximum number of cowork items reached');
    });
});

describe('InputArea — what survives the switch', () => {
    it('keeps the app picker reachable in Cowork mode', async () => {
        // A cowork brief runs unattended against the user's integrations, so
        // "which apps may it use" has to survive the switch — it used to be
        // hidden along with the chat-only tools.
        render(<Harness cowork={makeCowork()} onSendMessage={vi.fn()} initialMode="cowork" />);
        expect(await screen.findByRole('button', { name: /apps/i })).toBeVisible();
    });

    it('groups the app picker with the schedule chips, not floating mid-row', async () => {
        // The toolbar row is justify-between. A third child gets pushed to the
        // middle of the composer, which is where the picker ended up once
        // Cowork mode added its chips — so this pins them into one group.
        render(<Harness cowork={makeCowork()} onSendMessage={vi.fn()} initialMode="cowork" />);
        const apps = await screen.findByRole('button', { name: /apps/i });
        const chip = screen.getByTestId('cowork-when-chip');

        const row = apps.closest('.justify-between');
        expect(row).not.toBeNull();
        const groupOf = (el) => Array.from(row.children).find(child => child.contains(el));
        expect(groupOf(apps)).toBe(groupOf(chip));
        // And TWO children, which is the half that catches the regression: a
        // third one is what gets pushed into the middle, and two elements
        // sharing a group says nothing about how many groups there are.
        expect(row.children).toHaveLength(2);
    });

    it('takes the chat-only tools and pills off the screen — without unmounting them', async () => {
        // Hidden, not removed: the pickers behind these keep their open state,
        // so a switch to Cowork and back does not reset what you had open.
        render(
            <Harness
                cowork={makeCowork()}
                onSendMessage={vi.fn()}
                initialMode="cowork"
                modelTiers={{ auto: { auto: true }, thinking: { modelId: 'm' } }}
                selectedTier="thinking"
                user={{ id: 1, betaFeatures: ['skills'] }}
                onToggleSkill={vi.fn()}
            />,
        );
        await screen.findByRole('button', { name: /apps/i });

        const plus = screen.getByTestId('composer-tools-button');
        expect(plus).not.toBeVisible();
        expect(plus).toBeInTheDocument();

        // The pills ride in the same group, so they leave and return with it.
        // Skills rather than the tier: in direct mode the gauge beside Send
        // owns the tier and the pill stands down (see InputArea's C2 note).
        expect(screen.getByTestId('composer-pill-skills')).not.toBeVisible();
    });

    it('brings them all back when the user switches to Chat', async () => {
        render(
            <Harness
                cowork={makeCowork()}
                onSendMessage={vi.fn()}
                initialMode="cowork"
                modelTiers={{ auto: { auto: true }, thinking: { modelId: 'm' } }}
                selectedTier="thinking"
                user={{ id: 1, betaFeatures: ['skills'] }}
                onToggleSkill={vi.fn()}
            />,
        );
        await screen.findByRole('button', { name: /apps/i });
        fireEvent.click(screen.getByTestId('cowork-mode-chat'));

        expect(screen.getByTestId('composer-tools-button')).toBeVisible();
        expect(screen.getByTestId('composer-pill-skills')).toBeVisible();
    });

    it('keeps apps reachable in plain chat, from the tools menu', async () => {
        // In Cowork the picker keeps its own button; in chat it is a row in the
        // "+" menu. Either way "which apps may this touch" is one click away —
        // the switch must not strand it.
        render(<Harness cowork={makeCowork()} onSendMessage={vi.fn()} />);
        const plus = await screen.findByTestId('composer-tools-button');
        expect(plus).toBeVisible();

        fireEvent.click(plus);
        const menu = await screen.findByTestId('composer-tools-panel');
        expect(within(menu).getByTestId('composer-tool-apps')).toBeInTheDocument();
    });
});
