import { render as rtlRender, screen, cleanup } from '@testing-library/react';
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { FOOTER_LINES, footerNotice } from './composerClaims';
import InputArea from './InputArea';
import { invalidateShieldStatus } from '../../hooks/useShieldStatus';
import { queryWrapper } from '../../test/queryWrapper';

// The hooks under this tree read through React Query, so every render needs
// a client above it — a fresh one per render, never the app singleton.
const render = (ui, options) => rtlRender(ui, { wrapper: queryWrapper(), ...options });

/**
 * C11: the footer line under the composer.
 *
 * The artboard sets two sentences there: "Bee Flow runs on your own server. Conversations never
 * leave your organisation." On EVERY installation at least one of them is untrue: on beeflow.nl the
 * first, on self-host the second as soon as the org uses an external provider. The code said something
 * else until now (hard-coded "AI can make mistakes…"), so this is not a translation job but a claim job.
 *
 * What is fixed here:
 *
 *   1. The server sentence appears ONLY on self-host, and only for someone who is logged in. That is
 *      the "no-configuration" test that the programme demands for every privacy or status claim.
 *   2. The unprovable sentence NEVER appears: not behind a flag, not in another wording. Nothing this
 *      screen can query says whether the answering model runs locally.
 *   3. The own `warningText` of a call site wins unabridged. Eight places share this box, and EmbedChat
 *      runs on a customer's website and places its own text there. A widget should not make statements
 *      about whose server this is.
 */

vi.mock('../skills/ActiveSkillChips', () => ({ default: () => null }));
vi.mock('../skills/SkillsPopover', () => ({ default: () => null }));
vi.mock('./Voice/VoiceInlinePanel', () => ({ default: () => null }));
vi.mock('./Voice/useVoiceChatReady', () => ({ default: () => false }));

/** Wat /auth/setup-status via LicenseContext zou hebben geantwoord. */
let deployment = 'cloud';
vi.mock('../../hooks/useDeploymentMode', () => ({
    useDeploymentMode: () => ({
        mode: deployment,
        isCloud: deployment === 'cloud',
        isSelfHosted: deployment === 'self-hosted',
    }),
}));

const OWN_SERVER = /runs on your own server/i;
const MISTAKES = /AI can make mistakes/i;
/** De zin die niet te onderbouwen is, in de vormen waarin hij zou terugkeren. */
const NEVER = [/leave your organi[sz]ation/i, /stays? (?:in|inside) your organi[sz]ation/i, /never leaves?/i];

beforeEach(() => {
    deployment = 'cloud';
    invalidateShieldStatus();
    vi.spyOn(global, 'fetch').mockImplementation(async () => ({
        ok: true, status: 200, json: async () => ({}), text: async () => '',
    }));
});
afterEach(cleanup);

function Harness(props = {}) {
    const [input, setInput] = useState('');
    return (
        <InputArea
            onSendMessage={vi.fn()}
            onStopGenerating={vi.fn()}
            isLoading={false}
            directMode
            input={input}
            setInput={setInput}
            user={{ id: 1, name: 'Tester', betaFeatures: [] }}
            {...props}
        />
    );
}

describe('footerNotice — wat de voetregel mag beweren', () => {
    it('claimt op cloud niets over waar dit draait', () => {
        const lines = footerNotice({ deploymentMode: 'cloud', signedIn: true });
        expect(lines.map(l => l.key)).toEqual(['chat.composer.disclaimer']);
    });

    it('claimt de eigen server alleen op self-host', () => {
        const lines = footerNotice({ deploymentMode: 'self-hosted', signedIn: true });
        expect(lines.map(l => l.key)).toEqual(['chat.composer.footer_own_server', 'chat.composer.disclaimer']);
    });

    it('spreekt een bezoeker zonder account niet aan over "je eigen server"', () => {
        const lines = footerNotice({ deploymentMode: 'self-hosted', signedIn: false });
        expect(lines.map(l => l.key)).toEqual(['chat.composer.disclaimer']);
    });

    it('zegt precies één ding over de server, en niets erbij', () => {
        // A prohibition list only catches the formulations someone has thought of; the same promise in other
        // words slips through. That is why the positive form is used here: the server sentence IS this
        // sentence, literally. Anyone who attaches something to it, in whatever wording, will not get past
        // this test.
        expect(FOOTER_LINES.ownServer.en).toBe('Bee Flow runs on your own server.');
        expect(FOOTER_LINES.mistakes.en)
            .toBe('AI can make mistakes. Please verify important information.');
    });

    it('kent de onbewijsbare zin niet, in geen enkele stand', () => {
        for (const mode of ['cloud', 'self-hosted', undefined, 'nonsense']) {
            for (const signedIn of [true, false]) {
                const text = footerNotice({ deploymentMode: mode, signedIn }).map(l => l.en).join(' ');
                for (const rx of NEVER) expect(text).not.toMatch(rx);
            }
        }
    });

    it('geeft de zinnen als sleutelparen, zodat een vertaling ze kan bereiken', () => {
        for (const line of footerNotice({ deploymentMode: 'self-hosted', signedIn: true })) {
            expect(typeof line.key).toBe('string');
            expect(line.key).toMatch(/^chat\.composer\./);
            expect(typeof line.en).toBe('string');
        }
    });
});

describe('InputArea — de voetregel op het scherm', () => {
    it('zegt op cloud alleen dat het model zich kan vergissen', async () => {
        deployment = 'cloud';
        render(<Harness />);
        const footer = await screen.findByTestId('composer-footer');
        expect(footer.textContent).toMatch(MISTAKES);
        expect(footer.textContent).not.toMatch(OWN_SERVER);
    });

    it('noemt op self-host wél de eigen server', async () => {
        deployment = 'self-hosted';
        render(<Harness />);
        const footer = await screen.findByTestId('composer-footer');
        expect(footer.textContent).toMatch(OWN_SERVER);
        expect(footer.textContent).toMatch(MISTAKES);
    });

    it('belooft nergens dat het gesprek de organisatie niet verlaat', async () => {
        deployment = 'self-hosted';
        render(<Harness />);
        const footer = await screen.findByTestId('composer-footer');
        for (const rx of NEVER) expect(footer.textContent).not.toMatch(rx);
    });

    it('spreekt een anonieme bezoeker ook door de composer heen niet aan over "je eigen server"', async () => {
        // The pure function already knows this rule; this test pins the WIRING. Without it, `signedIn: !!user`
        // can shift to `signedIn: true`, and a visitor on a customer's website reads "Bee Flow runs on your
        // own server" (a statement about somebody else's server) without anything turning red.
        deployment = 'self-hosted';
        render(<Harness user={null} />);
        const footer = await screen.findByTestId('composer-footer');
        expect(footer.textContent).not.toMatch(/your own server/i);
        expect(footer.textContent).toMatch(/AI can make mistakes/i);
    });

    it('staat in dezelfde leeskolom als de berichten erboven (C9)', async () => {
        // One column, written in two files: 760px here and COLUMN_MAX_W in MessageItem/index.tsx. If they drift
        // apart (900 vs 768, later 760 vs 768), the conversation sits just not above its own input field.
        // That is the kind of difference that nobody names and everyone sees.
        render(<Harness />);
        const column = await screen.findByTestId('composer-column');
        expect(column.className).toContain('max-w-[760px]');
        expect(column.className).not.toContain('max-w-3xl');
    });

    it('laat het eigen warningText van een call-site onverkort winnen', async () => {
        // EmbedChat passes ?warning=… along. That text should be the whole notice: a widget on someone else's
        // website claims nothing about servers.
        deployment = 'self-hosted';
        render(<Harness warningText="Antwoorden van de gemeente zijn niet bindend." />);
        const footer = await screen.findByTestId('composer-footer');
        expect(footer.textContent).toContain('Antwoorden van de gemeente zijn niet bindend.');
        expect(footer.textContent).not.toMatch(OWN_SERVER);
        expect(footer.textContent).not.toMatch(MISTAKES);
    });
});

describe('InputArea — the chat-signals line beside the footer', () => {
    const NOTICE = {
        surface: 'direct', state: 'on', from: '2026-10-14', version: '2026-10-14T09:00:00.000Z',
        signals: ['outcomes'], noticeUrl: null, marker: 'direct@2026-10-14T09:00:00.000Z', optedOut: false,
    };

    it('renders the line as a sibling above the footer, never inside it', async () => {
        deployment = 'cloud';
        render(<Harness chatSignalsNotice={NOTICE} onChatSignalsCounted={vi.fn()} />);
        const footer = await screen.findByTestId('composer-footer');
        const line = screen.getByTestId('chat-signals-line');
        expect(footer.contains(line)).toBe(false);
        expect(line.parentElement).toBe(footer.parentElement);
        expect(line.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // The footer says exactly what it said before.
        expect(footer.textContent).toMatch(MISTAKES);
        expect(footer.textContent).not.toMatch(/Privacy Shield handled/);
    });

    it('shows no line where the host passes no notice', async () => {
        render(<Harness />);
        await screen.findByTestId('composer-footer');
        expect(screen.queryByTestId('chat-signals-line')).toBeNull();
    });
});
