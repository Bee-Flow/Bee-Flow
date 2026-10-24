import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, it, expect } from 'vitest';

import MessageItem from './index';
import DlpChatTextRenderer from '../dlpReview/DlpChatTextRenderer';

/**
 * The SHAPE of a message: where it stands, who stands beside it, and with what the bubble is painted (C9 and C10).
 *
 * ── WHAT IS FIXED HERE ─────────────────────────────────────────────────────
 *
 * 1. Messages stand in the reading column from the artboard (760px), not in a wider column than the composer below it.
 * 2. The answer has a sender tile on the LEFT of it: a sibling of the message column, not a line above it. A tile
 *    above the text marks no column; it is a second title line.
 * 3. There is exactly ONE face per turn. With multi-agent, the avatar of the answering agent stood in its own
 *    circle above the bubble; that is now the fill of the tile, not a second copy beside it.
 * 4. The user and tool messages get no tile.
 * 5. The user bubble paints with `--user-bubble-bg/-fg` and with NOTHING else: no hex fallback value that would
 *    paint a cool grey slab in a warm or dark theme if the token ever dropped out.
 *
 * It is tested on the property, not on the layout, with one exception that cannot have any other form: "which
 * token paints this" is only readable in jsdom as class or style text, because jsdom does not compute `var()`.
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
        // 900px messages above a 768px composer: two columns under each other, which you see on screen as a
        // conversation that does not stand above its own input field.
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
        // Before C9 the multi-agent line drew its own circle ABOVE the bubble. With a tile beside it there would be
        // two for one speaker. The name does stay: a name is not an avatar.
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
        // The revision shows "your message, annotated". A separate colour there would make it a separate report.
        const { container } = render(<DlpChatTextRenderer text="Bel j.devries@vandijk.nl" spans={[]} />);
        const bubble = container.querySelector('[class*="--user-bubble-bg"]');
        expect(bubble.className).toContain('bg-[var(--user-bubble-bg)]');
        expect(bubble.className).toContain('text-[var(--user-bubble-fg)]');
        expect(bubble.className).not.toMatch(/#[0-9a-fA-F]{3,8}/);
        expect(bubble.getAttribute('style')).toBeNull();
    });
});
