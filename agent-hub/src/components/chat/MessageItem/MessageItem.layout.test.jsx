import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, it, expect } from 'vitest';

import MessageItem from './index';
import DlpChatTextRenderer from '../dlpReview/DlpChatTextRenderer';

/**
 * De VORM van een bericht: waar het staat, wie ernaast staat, en waarmee de
 * bubbel geschilderd wordt (C9 en C10).
 *
 * ── WAT HIER VASTLIGT ──────────────────────────────────────────────────────
 *
 * 1. Berichten staan in de leeskolom uit het artboard (760px), niet in een
 *    eigen bredere kolom dan de composer eronder.
 * 2. Het antwoord heeft een afzendertegel LINKS ervan — een broer van de
 *    berichtkolom, niet een regel erbóven. Een tegel die boven de tekst
 *    staat markeert geen kolom, hij is een tweede titelregel.
 * 3. Er is precies ÉÉN gezicht per beurt. Bij multi-agent stond de avatar van
 *    de antwoordende agent in een eigen rondje boven de bubbel; die is nu de
 *    vulling van de tegel, niet een tweede exemplaar ernaast.
 * 4. De gebruiker en tool-berichten krijgen geen tegel.
 * 5. De gebruikersbubbel schildert met `--user-bubble-bg/-fg` en met NIETS
 *    anders: geen hex-noodwaarde die in een warm of donker thema een koele
 *    grijze slab zou tekenen als het token ooit wegviel.
 *
 * Er wordt op de eigenschap getest, niet op de opmaak — met één uitzondering
 * die geen andere vorm kan hebben: "welk token schildert dit" is in jsdom
 * alleen als klasse-/style-tekst te lezen, want jsdom rekent geen `var()` uit.
 */

const assistant = (over = {}) => ({
    id: 'a-1',
    role: 'assistant',
    content: 'Nee, niet helemaal — de offerte staat op 18%.',
    ...over,
});

const user = (over = {}) => ({
    id: 'u-1',
    role: 'user',
    content: 'Klopt de korting in de offerte?',
    ...over,
});

/** De buitenste omhulling van dit bericht (draagt de leeskolom). */
const wrapperOf = (msg) => screen.getByTestId(`message-${msg.id}`);

describe('C9 — de leeskolom', () => {
    it('zet het bericht in de kolom uit het artboard', () => {
        const msg = assistant();
        render(<MessageItem idx={0} msg={msg} />);
        expect(wrapperOf(msg).className).toContain('max-w-[760px]');
    });

    it('BIJT — en niet in de bredere kolom die naast de composer stond', () => {
        // 900px berichten boven een 768px composer: twee kolommen onder elkaar
        // die je op het scherm ziet als een gesprek dat niet boven zijn eigen
        // invoerveld staat.
        const msg = assistant();
        render(<MessageItem idx={0} msg={msg} />);
        expect(wrapperOf(msg).className).not.toContain('max-w-[900px]');
    });

    it('geldt net zo goed voor het bericht van de gebruiker', () => {
        const msg = user();
        render(<MessageItem idx={0} msg={msg} />);
        expect(wrapperOf(msg).className).toContain('max-w-[760px]');
    });
});

describe('C9 — de afzendertegel', () => {
    it('staat NAAST het antwoord, niet erboven', () => {
        const msg = assistant();
        render(<MessageItem idx={0} msg={msg} />);

        const tile = screen.getByTestId('assistant-avatar');
        const body = screen.getByTestId('assistant-body');

        // Broers onder dezelfde omhulling — en de tegel eerst, dus links.
        expect(tile.parentElement).toBe(wrapperOf(msg));
        expect(body.closest(`[data-testid="message-${msg.id}"]`)).toBe(wrapperOf(msg));
        expect(tile.contains(body)).toBe(false);
        expect(tile.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('BIJT — de gebruiker krijgt er geen', () => {
        render(<MessageItem idx={0} msg={user()} />);
        expect(screen.queryByTestId('assistant-avatar')).toBeNull();
    });

    it('BIJT — en een tool-bericht ook niet', () => {
        render(<MessageItem idx={0} msg={{ id: 't-1', role: 'tool', content: 'ok' }} />);
        expect(screen.queryByTestId('assistant-avatar')).toBeNull();
    });

    it('draagt het gezicht van de agent die antwoordde', () => {
        render(<MessageItem
            idx={0}
            msg={assistant({ respondingAgentName: 'Verkoopassistent', respondingAgentAvatar: '🦊' })}
        />);
        expect(screen.getByTestId('assistant-avatar').textContent).toBe('🦊');
    });

    it('BIJT — en dan staat er precies één gezicht, niet twee', () => {
        // Vóór C9 tekende de multi-agent-regel zijn eigen rondje bóven de
        // bubbel; met een tegel ernaast zouden dat er twee zijn voor één
        // spreker. De naam blijft wél staan — een naam is geen avatar.
        const { container } = render(<MessageItem
            idx={0}
            msg={assistant({ respondingAgentName: 'Verkoopassistent', respondingAgentAvatar: '🦊' })}
        />);
        const faces = [...container.querySelectorAll('*')]
            .filter(el => el.children.length === 0 && el.textContent === '🦊');
        expect(faces).toHaveLength(1);
        expect(screen.getByText('Verkoopassistent')).toBeTruthy();
    });

    it('en een geüploade avatar wordt een plaatje in diezelfde tegel', () => {
        render(<MessageItem
            idx={0}
            msg={assistant({ respondingAgentName: 'Verkoopassistent', respondingAgentAvatar: '/uploads/avatar.png' })}
        />);
        const img = screen.getByTestId('assistant-avatar').querySelector('img');
        expect(img).toBeTruthy();
        expect(img.getAttribute('src')).toContain('/uploads/avatar.png');
    });
});

describe('C10 — de bubbel schildert met een token', () => {
    it('gebruikt --user-bubble-bg en --user-bubble-fg', () => {
        render(<MessageItem idx={0} msg={user()} />);
        const bubble = screen.getByTestId('user-bubble');
        expect(bubble.className).toContain('bg-[var(--user-bubble-bg)]');
        expect(bubble.className).toContain('text-[var(--user-bubble-fg)]');
    });

    it('BIJT — zonder hex-noodwaarde erachter', () => {
        // `--user-bubble-bg/-fg` staat voor alle acht thema's in index.css, dus
        // de noodwaarde kon nooit meer aan de beurt komen. Hij liet wél zien
        // dat er "eigenlijk" een vaste grijstint onder lag — precies de
        // bewering die C10 weghaalt.
        render(<MessageItem idx={0} msg={user()} />);
        expect(screen.getByTestId('user-bubble').className).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    });

    it('en de DLP-revisie schildert de bubbel met dezelfde twee tokens', () => {
        // De revisie toont "jouw bericht, geannoteerd". Een eigen kleur daar
        // maakt er een los rapport van.
        const { container } = render(<DlpChatTextRenderer text="Bel j.devries@vandijk.nl" spans={[]} />);
        const style = container.querySelector('[style]').getAttribute('style');
        expect(style).toContain('var(--user-bubble-bg)');
        expect(style).toContain('var(--user-bubble-fg)');
        expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    });
});
