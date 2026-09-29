import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';

import TokenisedBadge from './TokenisedBadge';

/**
 * Twee bevindingen liggen hier bovenop elkaar.
 *
 * ── C7 — deze component doet geen privacyclaim meer ─────────────────────────
 * De blauwe "N items redacted"-pil is weg. Hij beweerde een AANTAL en zette de
 * plaatsvervanger plus de zin "the real values stay here" één klik diep. De
 * regel onder het bericht (MessageItem/PrivacyLine.jsx) doet die claim nu, mét
 * de plaatsvervanger die er echt voor in de plaats ging — en zonder
 * geruststelling waar die onbekend is. Wat hier overblijft is de amberen
 * doorlaatmelding, en die claimt niets over redactie.
 *
 * De test die dat vasthoudt is de belangrijkste van dit bestand: hij geeft de
 * component `count` en `categories` mee — de oude pil-props — en eist dat er
 * niets verschijnt. Zonder die test komt de tellervorm er ongemerkt weer in
 * naast de regel, en dan staan er twee claims onder één bericht met
 * verschillende bewijslast.
 *
 * ── BFSF-303 — de overlay ───────────────────────────────────────────────────
 * jsdom heeft geen layout-engine en geen stylesheet, dus de twee helften van
 * die bug staan gepind op de structurele feiten die ze onmogelijk maken:
 *
 *   • Layering: het paneel MOET een body-portal zijn, geen afstammeling van de
 *     berichtenrij. Binnen de rij zat het in de stacking context van die rij
 *     (de glasthema's zetten een backdrop-filter op elk berichtvlak), en dan
 *     kan geen z-index het boven de volgende bubbel tillen.
 *   • Doorschijnendheid: het paneel MOET `data-tokenised-popover` dragen — de
 *     haak waar de glasthema-regels in index.css hun dichte vlak aan ophangen.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WARNINGS = [{ filename: 'big.pdf', reason: 'overflow', scannedPages: 3, totalPages: 40 }];

function Row(props) {
    // Spiegelt het echte call-site: de badge staat in de berichtenrij, die in
    // de glasthema's een eigen stacking context is.
    return (
        <div data-testid="message-row" style={{ position: 'relative', zIndex: 0 }}>
            <TokenisedBadge {...props} />
        </div>
    );
}

describe('TokenisedBadge — C7: geen redactieclaim meer in deze component', () => {
    beforeEach(cleanup);

    it('rendert niets wanneer er alleen een redactietelling is', () => {
        // Precies de oude aanroep. Hij moet stil blijven: de telling is de
        // claim van PrivacyLine, en die kan hem onderbouwen.
        render(<Row count={3} categories={['Email', 'Email', 'Phone']} />);
        expect(screen.queryByRole('button')).toBeNull();
        expect(document.body.textContent).not.toMatch(/redacted/i);
        expect(document.body.textContent).not.toMatch(/stay here/i);
    });

    it('rendert niets zonder waarschuwingen', () => {
        render(<Row />);
        expect(document.querySelector('[data-tokenised-popover]')).toBeNull();
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('toont de doorlaatmelding wél, ook zonder telling', () => {
        render(<Row warnings={WARNINGS} />);
        expect(screen.getByTestId('scan-incomplete-pill')).toBeTruthy();
        expect(screen.getByText('Scan incomplete')).toBeTruthy();
    });

    it('schildert geen enkele kleur buiten de thematokens om', () => {
        // De pil verfde zich met rgba(217,119,6,…) en rgb(180,83,9): één vaste
        // lichte amber voor twaalf thema's. Een hex of rgb() in de bron is het
        // bewijs dat er weer een kleur buiten index.css om is gekozen.
        const src = fs.readFileSync(path.join(HERE, 'TokenisedBadge.jsx'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^[ \t]*\/\/.*$/gm, '');
        expect(src).not.toMatch(/rgba?\(/);
        expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(src).toContain('var(--warning');
    });
});

describe('TokenisedBadge — de overlay (BFSF-303)', () => {
    beforeEach(cleanup);

    it('houdt het paneel dicht tot de pil wordt aangeklikt', () => {
        render(<Row warnings={WARNINGS} />);
        expect(document.querySelector('[data-tokenised-popover]')).toBeNull();
    });

    it('ontsnapt aan de berichtenrij: het paneel is een portalkind van <body>', () => {
        render(<Row warnings={WARNINGS} />);
        fireEvent.click(screen.getByTestId('scan-incomplete-pill'));

        const panel = document.querySelector('[data-tokenised-popover="warn"]');
        expect(panel).toBeTruthy();
        expect(panel.parentElement).toBe(document.body);
        expect(screen.getByTestId('message-row').contains(panel)).toBe(false);
    });

    it('legt het paneel fixed boven elk chatvlak', () => {
        render(<Row warnings={WARNINGS} />);
        fireEvent.click(screen.getByTestId('scan-incomplete-pill'));

        const panel = document.querySelector('[data-tokenised-popover="warn"]');
        expect(panel.style.position).toBe('fixed');
        // Een portal alleen is niet genoeg — het paneel moet ook boven de
        // eigen overlays van de app uitkomen. AnchoredMenu's 10050 is het
        // gedeelde plafond.
        expect(Number(panel.style.zIndex)).toBeGreaterThanOrEqual(10050);
    });

    it('draagt de haak waar de glasthemas hun dichte vlak aan ophangen', () => {
        render(<Row warnings={WARNINGS} />);
        fireEvent.click(screen.getByTestId('scan-incomplete-pill'));

        // Verdwijnt dit attribuut, dan stoppen de [data-theme^="glass"]-regels
        // in index.css met matchen en valt het paneel stil terug op het
        // doorschijnende --bg-card.
        expect(document.querySelectorAll('[data-tokenised-popover]').length).toBe(1);
    });

    it('noemt het bestand en wat er niet gecontroleerd is', () => {
        render(<Row warnings={WARNINGS} />);
        fireEvent.click(screen.getByTestId('scan-incomplete-pill'));

        const panel = document.querySelector('[data-tokenised-popover="warn"]');
        expect(panel.textContent).toContain('big.pdf');
        expect(panel.textContent).toContain('Scanned 3 of 40 pages');
        expect(panel.textContent).toContain('too large to fully check');
    });

    it('sluit op Escape en op een druk erbuiten', () => {
        render(<Row warnings={WARNINGS} />);
        fireEvent.click(screen.getByTestId('scan-incomplete-pill'));
        expect(document.querySelector('[data-tokenised-popover]')).toBeTruthy();

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(document.querySelector('[data-tokenised-popover]')).toBeNull();

        fireEvent.click(screen.getByTestId('scan-incomplete-pill'));
        expect(document.querySelector('[data-tokenised-popover]')).toBeTruthy();
        fireEvent.mouseDown(document.body);
        expect(document.querySelector('[data-tokenised-popover]')).toBeNull();
    });

    it('sluit via de X in het paneel', () => {
        render(<Row warnings={WARNINGS} />);
        fireEvent.click(screen.getByTestId('scan-incomplete-pill'));
        fireEvent.click(screen.getByLabelText('Close'));
        expect(document.querySelector('[data-tokenised-popover]')).toBeNull();
    });
});
