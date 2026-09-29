import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import React from 'react';

import MessageItem from './index';

/**
 * C7 — de bedrading, niet de zin.
 *
 * De tokenmap landt server-side op het ANTWOORD (`privacy_token_map` →
 * assistantMsgId in hooks/useChatEngine/sseEvents.js), terwijl de regel onder
 * het GEBRUIKERSbericht hangt. Wie dat verkeerd knoopt krijgt geen fout maar
 * iets veel stillers: het scherm degradeert altijd, en de demonstratie — de
 * kern van het product — is nergens meer te zien zonder dat iemand het merkt.
 *
 * Daarom staat hier ook dat de tellervorm weg is. "1 item redacted" is een
 * bewering over een aantal; C7 vervangt hem door een aanwijzing.
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
        // Het dossier brak na 3 van 90 pagina's af; de rest ging onder
        // fail_open ONGEREDIGEERD naar de AI. De pil ernaast is een tweede
        // component met een eigen bewijslast — de zin die de lezer leest moet
        // de doorlaat zelf dragen.
        renderTurn([
            userMsg({ dlpRedactedCount: 1, piiScanWarnings: [WARN] }),
            answer({ count: 1, tokenMap: { '[email_1]': REAL_EMAIL } }),
        ]);

        expect(screen.getByTestId('privacy-line-incomplete')).toBeTruthy();
        expect(screen.getByTestId('privacy-line').textContent).toMatch(/could not be checked/i);
        expect(screen.getByTestId('scan-incomplete-pill')).toBeTruthy();
    });

    it('leest een onbekende vorm als "we weten het niet", niet als "er was niets"', () => {
        // Eén object in plaats van een lijst — de vorm die een JSON-kolom of
        // een enkele waarschuwing oplevert. Een kale Array.isArray-poort liet
        // de doorlaat hier spoorloos verdwijnen.
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
        // De andere kant van dezelfde regel: fail-closed lezen mag geen pil
        // verzinnen onder een bericht waar niets aan de hand was.
        renderTurn([userMsg({ dlpRedactedCount: 0, piiScanWarnings: [] }), answer({ count: 0 })]);
        expect(screen.queryByTestId('scan-incomplete-pill')).toBeNull();
        expect(screen.queryByTestId('privacy-row')).toBeNull();
    });
});

describe('MessageItem — precies één privacyuitspraak per bericht', () => {
    it('zet er niet stilletjes een tweede claim naast', () => {
        // DE EIGENSCHAP, niet de bewoording. De vorige pin zocht letterlijk
        // naar "items redacted"; een tweede chip met andere woorden — twee
        // componenten die dezelfde claim maken met verschillende bewijslast —
        // gleed er zo langs. De rij draagt de regel plus hooguit de amberen
        // pil, en niets anders.
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
        // `dlpRedactedCount` komt van de DLP-route, `piiTokenizedCount` van de
        // Azure-PII-route. Een bericht dat alleen die tweede route zag verliest
        // zijn privacyregel volledig zodra iemand de max() weghaalt — zonder
        // dat er iets rood wordt.
        renderTurn([
            userMsg({ dlpRedactedCount: 0, piiTokenizedCount: 2 }),
            answer({ count: 2, tokenMap: { '[email_1]': REAL_EMAIL } }),
        ]);

        expect(screen.getByTestId('privacy-line')).toBeTruthy();
        expect(screen.getByTestId('privacy-line-token')).toHaveTextContent('[email_1]');
    });

    it('leest de tekst van een samengesteld bericht, niet alleen een kale string', () => {
        // Tekst + bijlage is de normale vorm in dit product. Wie hier naïef
        // `msg.content` leest krijgt geen fout maar een stille degradatie: de
        // meting vindt niets en de demonstratie verdwijnt.
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
