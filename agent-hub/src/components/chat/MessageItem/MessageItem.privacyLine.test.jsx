import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, it, expect } from 'vitest';

import MessageItem from './index';

/**
 * C7: the wiring, not the sentence.
 *
 * The token map lands server-side on the ANSWER (`privacy_token_map` → assistantMsgId in
 * hooks/useChatEngine/sseEvents.js), while the line hangs under the USER message. Whoever wires that wrongly
 * gets no error but something much quieter: the screen always degrades, and the demonstration (the core of
 * the product) is nowhere to be seen, without anyone noticing.
 *
 * That is why it is also stated here that the counter form is gone. "1 item redacted" is a claim about a
 * number; C7 replaces it with a hint.
 */

const REAL_EMAIL = 'j.devries@vandijk.nl';
const userMsg = (over = {}) => ({
    id: 'u1',
    role: 'user',
    content: `Klopt de korting voor Van Dijk? Contactpersoon is ${REAL_EMAIL}.`,
    dlpRedactedCount: 1,
    dlpCategories: ['Email'],
    ...over,
});
const answer = (tokenisationInfo) => ({ id: 'a1', role: 'assistant', content: 'Ik kijk het na.', tokenisationInfo });

function renderTurn(messages) {
    return render(<MessageItem idx={0} msg={messages[0]} allMessages={messages} />);
}

describe('MessageItem — de privacyregel onder het gebruikersbericht', () => {
    it('demonstreert met de tokenmap van het antwoord op dit bericht', () => {
        renderTurn([userMsg(), answer({ count: 1, tokenMap: { '[email_1]': REAL_EMAIL } })]);

        expect(screen.getByTestId('privacy-line')).toHaveAttribute('data-privacy-line', 'demonstrated');
        expect(screen.getByTestId('privacy-line-token')).toHaveTextContent('[email_1]');
    });

    it('degradeert eerlijk wanneer die map er niet is', () => {
        renderTurn([userMsg(), answer({ count: 1 })]);

        expect(screen.getByTestId('privacy-line')).toHaveAttribute('data-privacy-line', 'unproven');
        expect(screen.queryByTestId('privacy-line-token')).toBeNull();
    });

    it('levert nooit de tellervorm', () => {
        renderTurn([userMsg({ dlpRedactedCount: 3 }), answer({ count: 3 })]);

        expect(screen.queryByText(/items? redacted/i)).toBeNull();
        expect(screen.getByTestId('privacy-line')).toBeTruthy();
    });

    it('laat de amberen scan-incompleet-pil staan — die zegt iets anders', () => {
        renderTurn([
            userMsg({ dlpRedactedCount: 0, piiScanWarnings: [{ filename: 'groot.pdf', reason: 'overflow' }] }),
            answer({ count: 0 }),
        ]);

        expect(screen.getByText('Scan incomplete')).toBeTruthy();
        expect(screen.queryByTestId('privacy-line')).toBeNull();
    });

    it('zegt niets onder een bericht zonder vervangingen', () => {
        renderTurn([userMsg({ dlpRedactedCount: 0, dlpCategories: [] }), answer({ count: 0 })]);

        expect(screen.queryByTestId('privacy-line')).toBeNull();
    });
});

describe('MessageItem — een doorlaat mag niet stil wegvallen', () => {
    const WARN = { filename: 'dossier.pdf', reason: 'overflow', scannedPages: 3, totalPages: 90 };

    it('geruststelt niet naast een halve controle', () => {
        // The file broke off after 3 of 90 pages, and the rest went under fail_open UNREDACTED to the AI. The pill
        // beside it is a second component with its own burden of proof: the sentence the reader reads must carry
        // the pass-through itself.
        renderTurn([
            userMsg({ dlpRedactedCount: 1, piiScanWarnings: [WARN] }),
            answer({ count: 1, tokenMap: { '[email_1]': REAL_EMAIL } }),
        ]);

        expect(screen.getByTestId('privacy-line-incomplete')).toBeTruthy();
        expect(screen.getByTestId('privacy-line').textContent).toMatch(/could not be checked/i);
        expect(screen.getByTestId('scan-incomplete-pill')).toBeTruthy();
    });

    it('leest een onbekende vorm als "we weten het niet", niet als "er was niets"', () => {
        // One object instead of a list: the shape that a JSON column or a single warning yields. A bare
        // Array.isArray gate let the pass-through vanish here without a trace.
        renderTurn([
            userMsg({ dlpRedactedCount: 0, piiScanWarnings: WARN }),
            answer({ count: 0 }),
        ]);

        expect(screen.getByTestId('scan-incomplete-pill')).toBeTruthy();
    });

    it('valt ook niet stil op een vorm die helemaal geen object is', () => {
        renderTurn([userMsg({ dlpRedactedCount: 0, piiScanWarnings: 'overflow' }), answer({ count: 0 })]);
        expect(screen.getByTestId('scan-incomplete-pill')).toBeTruthy();
    });

    it('zwijgt waar er werkelijk niets gemeld is', () => {
        // The other side of the same rule: fail-closed reading may not invent a pill under a message where nothing
        // was the matter.
        renderTurn([userMsg({ dlpRedactedCount: 0, piiScanWarnings: [] }), answer({ count: 0 })]);
        expect(screen.queryByTestId('scan-incomplete-pill')).toBeNull();
        expect(screen.queryByTestId('privacy-row')).toBeNull();
    });
});

describe('MessageItem — precies één privacyuitspraak per bericht', () => {
    it('zet er niet stilletjes een tweede claim naast', () => {
        // THE PROPERTY, not the wording. The previous pin searched literally for "items redacted"; a second chip with
        // other words (two components that make the same claim with different burdens of proof) slipped past it
        // that way. The row carries the line plus at most the amber pill, and nothing else.
        renderTurn([userMsg(), answer({ count: 1, tokenMap: { '[email_1]': REAL_EMAIL } })]);

        const row = screen.getByTestId('privacy-row');
        expect(row.children).toHaveLength(1);
        expect(row.children[0]).toBe(screen.getByTestId('privacy-line'));
    });

    it('laat de rij bij een doorlaat op de regel plus de pil, en niet meer', () => {
        renderTurn([
            userMsg({ dlpRedactedCount: 1, piiScanWarnings: [{ filename: 'groot.pdf', reason: 'timeout' }] }),
            answer({ count: 1 }),
        ]);

        const row = screen.getByTestId('privacy-row');
        expect(row.children).toHaveLength(2);
        expect(row.children[0]).toBe(screen.getByTestId('privacy-line'));
        expect(row.children[1].contains(screen.getByTestId('scan-incomplete-pill'))).toBe(true);
    });
});

describe('MessageItem — de bedrading die stil kan wegvallen', () => {
    it('telt ook een bericht dat alleen langs de legacy-PII-tak ging', () => {
        // `dlpRedactedCount` comes from the DLP route, `piiTokenizedCount` from the Azure PII route. A message that
        // only the second route saw loses its privacy line entirely once someone removes the max(), without anything
        // turning red.
        renderTurn([
            userMsg({ dlpRedactedCount: 0, piiTokenizedCount: 2 }),
            answer({ count: 2, tokenMap: { '[email_1]': REAL_EMAIL } }),
        ]);

        expect(screen.getByTestId('privacy-line')).toBeTruthy();
        expect(screen.getByTestId('privacy-line-token')).toHaveTextContent('[email_1]');
    });

    it('leest de tekst van een samengesteld bericht, niet alleen een kale string', () => {
        // Text plus attachment is the normal shape in this product. Whoever naively reads `msg.content` here gets no
        // error but a silent degradation: the measurement finds nothing and the demonstration disappears.
        const composed = userMsg({
            content: [
                { type: 'text', text: `Contactpersoon is ${REAL_EMAIL}.` },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
            ],
        });
        renderTurn([composed, answer({ count: 1, tokenMap: { '[email_1]': REAL_EMAIL } })]);

        expect(screen.getByTestId('privacy-line')).toHaveAttribute('data-privacy-line', 'demonstrated');
        expect(screen.getByTestId('privacy-line-token')).toHaveTextContent('[email_1]');
    });
});
