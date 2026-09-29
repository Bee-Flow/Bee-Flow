import { render as rtlRender, screen, cleanup } from '@testing-library/react';
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import InputArea from './InputArea';
import { FOOTER_LINES, footerNotice } from './composerClaims';
import { invalidateShieldStatus } from '../../hooks/useShieldStatus';
import { queryWrapper } from '../../test/queryWrapper';

// The hooks under this tree read through React Query, so every render needs
// a client above it — a fresh one per render, never the app singleton.
const render = (ui, options) => rtlRender(ui, { wrapper: queryWrapper(), ...options });

/**
 * C11 — de voetregel onder de composer.
 *
 * Het artboard zet er twee zinnen: "Bee Flow draait op je eigen server.
 * Gesprekken verlaten je organisatie niet." Op élke installatie is minstens
 * één daarvan onwaar — op beeflow.nl de eerste, op self-host de tweede zodra
 * de org een externe provider gebruikt. De code zei tot nu toe iets anders
 * (hardgecodeerd "AI can make mistakes…"), dus dit is geen vertaalklus maar
 * een claimklus.
 *
 * Wat hier vastligt:
 *
 *   1. De serverzin verschijnt ALLEEN op self-host, en alleen voor iemand die
 *      is ingelogd. Dat is de "nee-configuratie"-test die het programma voor
 *      elke privacy- of statusclaim eist.
 *   2. De onbewijsbare zin verschijnt NOOIT — niet achter een vlag, niet in een
 *      andere formulering. Er is niets wat dit scherm kan opvragen dat zegt of
 *      het antwoordende model lokaal draait.
 *   3. Het eigen `warningText` van een call-site wint onverkort. Acht plekken
 *      delen deze box; EmbedChat draait op de website van een klant en zet daar
 *      zijn eigen tekst neer. Een widget hoort geen uitspraken te doen over
 *      wiens server dit is.
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
        // Een verbodslijst vangt alleen de formuleringen die iemand heeft
        // bedacht; dezelfde belofte in andere woorden glipt erdoor. Daarom
        // hier de positieve vorm: de serverzin IS deze zin, letterlijk. Wie er
        // iets aan vastplakt — in welke bewoording dan ook — komt hier langs.
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
        // De zuivere functie kent deze regel al; deze test pint de BEDRADING.
        // Zonder hem kan `signedIn: !!user` naar `signedIn: true` verschuiven
        // en krijgt een bezoeker op de website van een klant "Bee Flow runs on
        // your own server" te lezen — een uitspraak over de server van iemand
        // anders — zonder dat er iets rood wordt.
        deployment = 'self-hosted';
        render(<Harness user={null} />);
        const footer = await screen.findByTestId('composer-footer');
        expect(footer.textContent).not.toMatch(/your own server/i);
        expect(footer.textContent).toMatch(/AI can make mistakes/i);
    });

    it('staat in dezelfde leeskolom als de berichten erboven (C9)', async () => {
        // Eén kolom, in twee bestanden geschreven: 760px hier en COLUMN_MAX_W
        // in MessageItem/index.jsx. Liepen ze uit elkaar (900 vs 768, later
        // 760 vs 768), dan staat het gesprek net niet boven zijn eigen
        // invoerveld — het soort verschil dat niemand benoemt en iedereen ziet.
        render(<Harness />);
        const column = await screen.findByTestId('composer-column');
        expect(column.className).toContain('max-w-[760px]');
        expect(column.className).not.toContain('max-w-3xl');
    });

    it('laat het eigen warningText van een call-site onverkort winnen', async () => {
        // EmbedChat geeft ?warning=… door. Die tekst hoort de hele mededeling
        // te zijn: een widget op andermans website claimt niets over servers.
        deployment = 'self-hosted';
        render(<Harness warningText="Antwoorden van de gemeente zijn niet bindend." />);
        const footer = await screen.findByTestId('composer-footer');
        expect(footer.textContent).toContain('Antwoorden van de gemeente zijn niet bindend.');
        expect(footer.textContent).not.toMatch(OWN_SERVER);
        expect(footer.textContent).not.toMatch(MISTAKES);
    });
});
