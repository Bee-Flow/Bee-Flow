import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';

import TokenisedBadge from './TokenisedBadge';

/**
 * Two findings sit on top of each other here.
 *
 * ── C7: this component no longer makes a privacy claim ─────────────────────────
 * The blue "N items redacted" pill is gone. It claimed a NUMBER, and it put the
 * stand-in plus the sentence "the real values stay here" one click deep. The
 * line under the message (MessageItem/PrivacyLine.jsx) now makes that claim, with
 * the stand-in that really went in its place, and without reassurance where that
 * is unknown. What remains here is the amber pass-through notice, and that one
 * claims nothing about redaction.
 *
 * The test that holds this is the most important one in this file. It gives the
 * component `count` and `categories` (the old pill props) and demands that nothing
 * appears. Without that test the counter form creeps back in unnoticed next to the
 * line, and then there are two claims under one message with different evidentiary
 * burdens.
 *
 * ── BFSF-303: the overlay ───────────────────────────────────────────────────
 * jsdom has no layout engine and no stylesheet, so the two halves of that bug are
 * pinned to the structural facts that make them impossible:
 *
 *   • Layering: the panel MUST be a body portal, not a descendant of the message
 *     row. Inside the row it sat in that row's stacking context (the glass themes
 *     put a backdrop-filter on every message surface), and then no z-index can lift
 *     it above the next bubble.
 *   • Translucency: the panel MUST carry `data-tokenised-popover`, the hook where
 *     the glass-theme rules in index.css hang their opaque surface.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WARNINGS = [{ filename: 'big.pdf', reason: 'overflow', scannedPages: 3, totalPages: 40 }];

function Row(props) {
    // Mirrors the real call site: the badge stands in the message row, which in the
    // glass themes is its own stacking context.
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
        // The pill was painted with rgba(217,119,6,…) and rgb(180,83,9): one fixed light
        // amber for twelve themes. A hex or rgb() in the source is the proof that a
        // color has again been chosen outside index.css.
        const src = fs.readFileSync(path.join(HERE, 'TokenisedBadge.tsx'), 'utf8')
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
        // A portal alone is not enough. The panel must also rise above the app's own
        // overlays. AnchoredMenu's 10050 is the shared ceiling.
        expect(Number(panel.style.zIndex)).toBeGreaterThanOrEqual(10050);
    });

    it('draagt de haak waar de glasthemas hun dichte vlak aan ophangen', () => {
        render(<Row warnings={WARNINGS} />);
        fireEvent.click(screen.getByTestId('scan-incomplete-pill'));

        // If this attribute disappears, the [data-theme^="glass"] rules in index.css
        // stop matching, and the panel silently falls back to the translucent --bg-card.
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
