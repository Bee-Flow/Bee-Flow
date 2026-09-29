import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import ConversationHeader from './ConversationHeader';
import { invalidateShieldStatus } from '../../hooks/useShieldStatus';
import { queryWrapper } from '../../test/queryWrapper';

// The hooks under this tree read through React Query, so every render needs
// a client above it — a fresh one per render, never the app singleton.
const render = (ui, options) => rtlRender(ui, { wrapper: queryWrapper(), ...options });

/**
 * The conversation header (C1) — what it is allowed to put above a chat.
 *
 * Every assertion here is about a CLAIM, not a layout. The header is the first
 * thing read and the last thing checked, so the tests are written the way the
 * programme's verification rule asks for: each claim also has a case where the
 * configuration says no and the claim has to disappear or change.
 *
 * The load-bearing one: "Privacy Shield on" is a RUNTIME claim. A shield that
 * is switched on while the detector cannot be reached protects nothing, and a
 * header that keeps saying "on" through that is worse than a header that says
 * nothing — it is the missing protection plus a reassurance.
 */

/** What GET /api/privacy/shield-status answers, per test. */
let shieldBody = null;

beforeEach(() => {
    vi.restoreAllMocks();
    invalidateShieldStatus();
    shieldBody = {
        enabled: true, source: 'org', action: 'redact', failMode: 'fail_closed',
        guardReachable: true, euMode: false, coworkEnabled: false,
    };
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
        const href = String(url);
        if (href.includes('/privacy/shield-status')) {
            return { ok: true, status: 200, json: async () => shieldBody, text: async () => '' };
        }
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });
});

const USER = { id: 1, name: 'Tester' };
const KB = (id, name) => ({ id, name, usage_contexts: ['direct_chat'] });

/**
 * Mount as a call site that KNOWS its send route is shielded. `shieldApplies`
 * is deliberately not defaulted on in the component (a forgotten prop must not
 * produce a green shield claim), so the shield tests below have to say so.
 */
const mount = (props = {}) => render(<ConversationHeader user={USER} shieldApplies {...props} />);

describe('ConversationHeader — the title', () => {
    it('puts the conversation on screen by name', () => {
        mount({ title: 'Offerte Van Dijk nakijken' });
        expect(screen.getByTestId('conversation-title')).toHaveTextContent('Offerte Van Dijk nakijken');
    });

    it('renders no heading for a chat that has not been named yet', () => {
        // A fresh conversation has no title until the server gives it one.
        // "Untitled" would be a label invented by this component.
        mount({ title: '' });
        expect(screen.queryByTestId('conversation-title')).toBeNull();
    });
});

describe('ConversationHeader — the shield pill is a runtime claim', () => {
    it('claims the shield only when the detector can actually scan', async () => {
        mount({ title: 'Chat' });
        const pill = await screen.findByTestId('header-shield-pill');
        expect(pill).toHaveTextContent('Privacy Shield on');
        expect(screen.getByTestId('header-shield-dot')).toHaveAttribute('data-shield-state', 'active');
    });

    it('says something else, in another colour, when nothing is scanning', async () => {
        shieldBody = { ...shieldBody, guardReachable: false };
        mount({ title: 'Chat' });
        const pill = await screen.findByTestId('header-shield-pill');
        // The configuration is provable and the protection is not: it may say
        // so, but never in the words or the colour of the claim it is not.
        expect(pill).not.toHaveTextContent('Privacy Shield on');
        expect(pill.textContent).toMatch(/cannot check/i);
        const dot = screen.getByTestId('header-shield-dot');
        expect(dot).toHaveAttribute('data-shield-state', 'unverified');
        // ...and the colour and the tooltip, not just the words and a
        // data-attribute that exists only to be asserted. A green dot beside
        // "cannot check", or a tooltip that still promises the checking, is
        // the missing protection plus a reassurance — read faster than either
        // sentence.
        expect(dot.style.background).not.toContain('--success');
        expect(dot.style.background).toContain('--warning');
        expect(pill.getAttribute('title')).not.toMatch(/is checked before it is sent/i);
        expect(pill.getAttribute('title')).toMatch(/cannot be reached/i);
    });

    it('paints the proven claim green, and says so in the tooltip too', async () => {
        // The other half of the pair: the pill that IS entitled to the green
        // dot must actually carry it, or the pair above proves nothing.
        mount({ title: 'Chat' });
        const pill = await screen.findByTestId('header-shield-pill');
        const dot = screen.getByTestId('header-shield-dot');
        expect(dot.style.background).toContain('--success');
        expect(dot.style.background).not.toContain('--warning');
        expect(pill.getAttribute('title')).toMatch(/is checked before it is sent/i);
    });

    it('shows no pill at all when the shield is switched off', async () => {
        shieldBody = { ...shieldBody, enabled: false, action: null };
        mount({ title: 'Chat' });
        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        await waitFor(() => expect(screen.queryByTestId('header-shield-pill')).toBeNull());
    });

    it('shows no pill when the status could not be read', async () => {
        vi.spyOn(global, 'fetch').mockImplementation(async () => { throw new Error('offline'); });
        mount({ title: 'Chat' });
        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        await waitFor(() => expect(screen.queryByTestId('header-shield-pill')).toBeNull());
    });

    it('says nothing about a shield on a surface the shield does not cover', async () => {
        mount({ title: 'Chat', shieldApplies: false });
        await waitFor(() => expect(screen.queryByTestId('header-shield-pill')).toBeNull());
    });

    it('claims nothing on a surface that never said it was shielded', async () => {
        // FAIL CLOSED. A call site that does not pass `shieldApplies` has not
        // told this header that its send route redacts anything — and plenty
        // of routes do not. The header must read that silence as "unknown",
        // never as permission to show the green dot. This is the one test that
        // pins the DEFAULT rather than a value someone passed in.
        render(<ConversationHeader title="Chat" user={USER} />);
        await waitFor(() => expect(screen.queryByTestId('header-shield-pill')).toBeNull());
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('tells an anonymous visitor nothing about this organisation', async () => {
        // The public embed passes no user. How an organisation has configured
        // its shield is internal configuration, not a badge for a stranger.
        render(<ConversationHeader title="Chat" user={null} />);
        await waitFor(() => expect(screen.queryByTestId('header-shield-pill')).toBeNull());
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe('ConversationHeader — the knowledge-base pill', () => {
    it('names what this chat is grounded on', () => {
        mount({
            title: 'Chat',
            availableKBs: [KB('a', 'Handboek verkoop'), KB('b', 'HR')],
            selectedKBIds: ['a'],
        });
        expect(screen.getByTestId('header-kb-pill')).toHaveTextContent('Handboek verkoop');
    });

    it('never counts a base the server no longer hands back', () => {
        // Deleted, unshared, or taken out of chat: the id survives in the
        // stored selection long after anything searches it.
        mount({
            title: 'Chat',
            availableKBs: [KB('a', 'Handboek verkoop')],
            selectedKBIds: ['a', 'gone-1', 'gone-2'],
        });
        expect(screen.getByTestId('header-kb-pill')).toHaveTextContent('Handboek verkoop');
        expect(screen.getByTestId('header-kb-pill').textContent).not.toMatch(/3/);
    });

    it('counts, rather than names, once there is more than one — and counts only the live ones', () => {
        mount({
            title: 'Chat',
            availableKBs: [KB('a', 'Handboek verkoop'), KB('b', 'HR')],
            selectedKBIds: ['a', 'b', 'gone-1'],
        });
        expect(screen.getByTestId('header-kb-pill')).toHaveTextContent('2 knowledge bases');
    });

    it('stays silent while the list of knowledge bases is unknown', () => {
        // "Grounded on nothing" and "we could not ask" look the same to a
        // reader and mean opposite things about where the answer came from.
        mount({ title: 'Chat', availableKBs: null, selectedKBIds: ['a'] });
        expect(screen.queryByTestId('header-kb-pill')).toBeNull();
    });

    it('stays silent when the chat is grounded on nothing', () => {
        mount({ title: 'Chat', availableKBs: [KB('a', 'Handboek verkoop')], selectedKBIds: [] });
        expect(screen.queryByTestId('header-kb-pill')).toBeNull();
    });
});

describe('ConversationHeader — the way out, and what stays', () => {
    it('offers the notebook, and reports it back to the call site', async () => {
        const onToNotebook = vi.fn();
        mount({ title: 'Chat', onToNotebook });
        const button = screen.getByTestId('header-to-notebook');
        expect(button).toHaveTextContent('To notebook');
        button.click();
        expect(onToNotebook).toHaveBeenCalledTimes(1);
    });

    it('offers no notebook where the call site cannot open one', () => {
        mount({ title: 'Chat' });
        expect(screen.queryByTestId('header-to-notebook')).toBeNull();
    });

    it('names the button after what pressing it now does', () => {
        mount({ title: 'Chat', onToNotebook: vi.fn(), notebookOpen: true });
        expect(screen.getByTestId('header-to-notebook')).toHaveTextContent('Close notebook');
    });

    it('keeps the Chat ⇄ Cowork switch the artboard leaves out (C14)', () => {
        // A conscious departure: the switch decides what the composer does, so
        // it survives the redesign — handed in by the call site, laid out here.
        mount({ title: 'Chat', center: <button data-testid="cowork-switch">Cowork</button> });
        expect(screen.getByTestId('cowork-switch')).toBeInTheDocument();
    });

    it('lays out the call site\'s own buttons and menu without owning them', () => {
        mount({
            title: 'Chat',
            actions: <button data-testid="webpage-button">Webpage</button>,
            menu: <button data-testid="overflow-menu">⋯</button>,
        });
        expect(screen.getByTestId('webpage-button')).toBeInTheDocument();
        expect(screen.getByTestId('overflow-menu')).toBeInTheDocument();
    });
});

describe('ConversationHeader — a phone is not a narrower desktop', () => {
    // 220px of pill in a 360px header is a truncated privacy sentence, and
    // half of "Privacy Shield cannot check right now" reads as the opposite of
    // itself. The per-message badge still reports what happened to each
    // message, on every width — the header simply stops claiming.
    it('drops both claims on a phone, and does not even ask for the status', async () => {
        mount({
            title: 'Offerte Van Dijk nakijken',
            isMobile: true,
            availableKBs: [KB('a', 'Handboek verkoop')],
            selectedKBIds: ['a'],
        });
        expect(screen.getByTestId('conversation-title')).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByTestId('header-kb-pill')).toBeNull());
        expect(screen.queryByTestId('header-shield-pill')).toBeNull();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('still shows the call site its own slots on a phone', () => {
        // Narrow is not a reason to hide the hamburger or the switch: those
        // are controls, not claims, and the call site decides what fits.
        mount({
            title: 'Chat',
            isMobile: true,
            leading: <button data-testid="hamburger">≡</button>,
            center: <button data-testid="cowork-switch">Cowork</button>,
        });
        expect(screen.getByTestId('hamburger')).toBeInTheDocument();
        expect(screen.getByTestId('cowork-switch')).toBeInTheDocument();
    });
});
