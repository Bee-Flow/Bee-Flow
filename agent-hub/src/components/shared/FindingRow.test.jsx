import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import FindingRow from './FindingRow.jsx';

/**
 * De gedeelde rij "dit heeft een mens nodig".
 *
 * Twee oppervlakken tekenen hem (de zwevende validatiepil boven de
 * automation-canvas en de aandachtslijst op Studio Start), dus wat hier
 * vastligt is precies wat verschilt zodra iemand hem verbouwt:
 *
 *   1. DRIE tonen, niet twee. De pil kende alleen error/warning; 'info' is het
 *      enige echt nieuwe gedrag van de extractie, en advies dat in de kleur
 *      van een waarschuwing staat is advies dat als waarschuwing wordt
 *      gelezen;
 *   2. de machinecode staat er, want een supportantwoord citeert hem;
 *   3. een rij die iets opent is een KNOP met een toetsenbord; een rij die
 *      niets opent is gewone tekst.
 */
describe('FindingRow', () => {
    beforeEach(cleanup);

    const bg = (el) => el.getAttribute('style') || '';

    it('geeft elke ernst zijn eigen inkt — advies is neutraal, niet oranje', () => {
        const { rerender } = render(<FindingRow severity="error" message="x" testId="r" />);
        expect(bg(screen.getByTestId('r'))).toMatch(/--error/);
        rerender(<FindingRow severity="warning" message="x" testId="r" />);
        expect(bg(screen.getByTestId('r'))).toMatch(/--warning/);
        rerender(<FindingRow severity="info" message="x" testId="r" />);
        const info = bg(screen.getByTestId('r'));
        expect(info).toMatch(/--text-tertiary/);
        expect(info).not.toMatch(/--warning/);
    });

    it('valt terug op de waarschuwingstoon voor een ernst die we niet kennen', () => {
        render(<FindingRow severity="whatever" message="x" testId="r" />);
        expect(bg(screen.getByTestId('r'))).toMatch(/--warning/);
    });

    it('toont de machinecode, het label, de zin en de fix op zijn eigen regel', () => {
        render(<FindingRow code="app.screens.missing" label="Order portal" message="Has no screens." hint="Add one." testId="r" />);
        const row = screen.getByTestId('r');
        expect(row.textContent).toContain('app.screens.missing');
        expect(row.textContent).toContain('Order portal');
        expect(row.textContent).toContain('Has no screens.');
        expect(row.textContent).toContain('→ Add one.');
    });

    it('is een knop met toetsenbord als er iets te openen valt, en anders tekst', () => {
        const onOpen = vi.fn();
        const { rerender } = render(<FindingRow message="x" onOpen={onOpen} openLabel="Show me" testId="r" />);
        const row = screen.getByTestId('r');
        expect(row.getAttribute('role')).toBe('button');
        expect(row.getAttribute('tabindex')).toBe('0');
        fireEvent.keyDown(row, { key: 'Enter' });
        fireEvent.click(row);
        expect(onOpen).toHaveBeenCalledTimes(2);

        rerender(<FindingRow message="x" testId="r" />);
        expect(screen.getByTestId('r').getAttribute('role')).toBeNull();
    });

    it('draagt de ernst als data-attribuut, zodat een lijst erop kan sorteren en testen', () => {
        render(<FindingRow severity="info" message="x" testId="r" />);
        expect(screen.getByTestId('r').getAttribute('data-severity')).toBe('info');
    });
});
