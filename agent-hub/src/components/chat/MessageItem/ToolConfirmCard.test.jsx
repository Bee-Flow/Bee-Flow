import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';

import TestChatNotice from './TestChatNotice';
import ToolConfirmCard from './ToolConfirmCard';

/**
 * De kaart bij een tegengehouden call, en de regel die zegt welke agent er
 * draaide (A4 deel A).
 *
 * Wat hier bewaakt wordt is niet de opmaak maar wat er BEWEERD wordt:
 *
 *   • een tegengehouden call mag niet lezen als een uitgevoerde;
 *   • een knop die nergens heen kan, hoort er niet te staan — dat is
 *     vals-groen met een muisaanwijzer eraan;
 *   • een beslissing gaat over ÉÉN actie (de argsKey van de server), nooit
 *     over de toolnaam;
 *   • "je concept" mag niet op het scherm komen voor een beurt waarvan
 *     niemand kon zeggen welke config draaide.
 */

const t = (key, fallback, params) => {
    let out = fallback;
    for (const [k, v] of Object.entries(params || {})) out = out.split(`{${k}}`).join(String(v));
    return out;
};

const call = (over = {}) => ({
    callId: 'call_1', toolName: 'gmail_compose', effect: 'sends',
    preview: { to: 'x@example.com', subject: 'Offer' },
    argsKey: 'a'.repeat(32), status: 'pending', ...over,
});

describe('ToolConfirmCard', () => {
    it('zegt dat de agent het WILDE doen, niet dat het gebeurd is', () => {
        render(<ToolConfirmCard calls={[call()]} t={t} />);
        expect(screen.getByTestId('tool-confirm-card')).toHaveAttribute('data-status', 'pending');
        expect(screen.getByText(/has not run/i)).toBeInTheDocument();
    });

    it('toont de argumenten die de server meestuurde, en niets meer', () => {
        render(<ToolConfirmCard calls={[call()]} t={t} />);
        expect(screen.getByText('x@example.com')).toBeInTheDocument();
        expect(screen.getByText('Offer')).toBeInTheDocument();
        expect(screen.getByText('gmail_compose')).toBeInTheDocument();
    });

    it('BIJT — zonder beslispad staan er geen knoppen', () => {
        // Een "Goedkeuren" die stilletjes niets doet is het soort vals-groen
        // dat een testchat hoort te vinden, niet te maken.
        render(<ToolConfirmCard calls={[call()]} t={t} />);
        expect(screen.queryByRole('button')).toBeNull();
        expect(screen.getByText(/Nothing was done/i)).toBeInTheDocument();
    });

    it('met een beslispad zijn er twee knoppen, en ze geven de ACTIESLEUTEL door', () => {
        const onDecide = vi.fn();
        render(<ToolConfirmCard calls={[call()]} onDecide={onDecide} t={t} />);
        fireEvent.click(screen.getByText(/Approve and run/i));
        expect(onDecide).toHaveBeenCalledWith('a'.repeat(32), 'approve', expect.objectContaining({ toolName: 'gmail_compose' }));
        fireEvent.click(screen.getByText(/Do not run it/i));
        expect(onDecide).toHaveBeenLastCalledWith('a'.repeat(32), 'decline', expect.anything());
    });

    it('BIJT — een beslissing gaat over één actie, niet over de tool', () => {
        // Twee mails met dezelfde tool: twee kaarten, twee sleutels. Zou de
        // kaart op toolnaam werken, dan zou één ja beide versturen.
        const onDecide = vi.fn();
        render(
            <ToolConfirmCard
                calls={[call(), call({ argsKey: 'b'.repeat(32), preview: { to: 'other@example.com' } })]}
                onDecide={onDecide} t={t}
            />,
        );
        const cards = screen.getAllByTestId('tool-confirm-card');
        expect(cards).toHaveLength(2);
        fireEvent.click(screen.getAllByText(/Approve and run/i)[1]);
        expect(onDecide).toHaveBeenCalledWith('b'.repeat(32), 'approve', expect.anything());
    });

    it('wat al geklikt is springt niet terug naar "wacht op jou"', () => {
        const { rerender } = render(
            <ToolConfirmCard calls={[call()]} onDecide={() => { }} decided={{ ['a'.repeat(32)]: 'approve' }} t={t} />,
        );
        expect(screen.getByTestId('tool-confirm-card')).toHaveAttribute('data-status', 'approved');
        expect(screen.queryByText(/Approve and run/i)).toBeNull();

        // ...en de server heeft het laatste woord: een geweigerde call blijft
        // geweigerd, ook als de client denkt dat er ja geklikt is.
        rerender(
            <ToolConfirmCard calls={[call({ status: 'declined' })]} onDecide={() => { }}
                decided={{ ['a'.repeat(32)]: 'approve' }} t={t} />,
        );
        expect(screen.getByTestId('tool-confirm-card')).toHaveAttribute('data-status', 'declined');
    });

    it('geen vastgehouden calls, geen kaart', () => {
        const { container } = render(<ToolConfirmCard calls={[]} t={t} />);
        expect(container.textContent).toBe('');
        const { container: c2 } = render(<ToolConfirmCard calls={null} t={t} />);
        expect(c2.textContent).toBe('');
    });
});

/**
 * Wie de stand zette (A4 deel C, `toolConfirmStatus.js`). De kaart en het
 * spoorpaneel lezen sinds dit deel dezelfde functie, zodat ze het nooit
 * verschillend kunnen zeggen.
 */
describe('ToolConfirmCard — wie de stand zette', () => {
    it('BIJT — een klik van zojuist zegt niet dat het GEDRAAID heeft', () => {
        // De beslissing reist mee met het volgende bericht: de call draait pas
        // als het model hem opnieuw voorstelt. "You approved this — it ran" is
        // op dat moment onwaar.
        render(<ToolConfirmCard calls={[call()]} onDecide={() => { }}
            decided={{ ['a'.repeat(32)]: 'approve' }} t={t} />);
        expect(screen.getByText(/runs on your next message/i)).toBeInTheDocument();
        expect(screen.queryByText(/it ran$/i)).toBeNull();
    });

    it('een goedkeuring van de SERVER zegt wél dat het gedraaid heeft', () => {
        render(<ToolConfirmCard calls={[call({ status: 'approved' })]} t={t} />);
        expect(screen.getByText(/it ran/i)).toBeInTheDocument();
    });

    it('BIJT — een stand die we niet kennen wordt geen "wacht op jou"', () => {
        // 'pending' is zelf een bewering ("dit heeft niet gedraaid"). Bij een
        // onleesbare stand kunnen we die niet doen, en dan horen er ook geen
        // knoppen te staan.
        render(<ToolConfirmCard calls={[call({ status: 'ran_maybe' })]} onDecide={() => { }} t={t} />);
        expect(screen.getByTestId('tool-confirm-card')).toHaveAttribute('data-status', 'unknown');
        expect(screen.getByText(/Could not tell whether this ran/i)).toBeInTheDocument();
        expect(screen.queryByText(/Approve and run/i)).toBeNull();
    });
});

describe('TestChatNotice', () => {
    it('zegt dat het concept antwoordde, met wat er live staat ernaast', () => {
        render(<TestChatNotice info={{ active: true, source: 'draft', publishedVersion: 3, unpublishedChanges: 5 }} t={t} />);
        const el = screen.getByTestId('test-chat-notice');
        expect(el).toHaveAttribute('data-source', 'draft');
        expect(el.textContent).toContain('Answered by your draft.');
        expect(el.textContent).toContain('Live is v3');
        expect(el.textContent).toContain('5 unpublished changes');
    });

    it('BIJT — één wijziging is enkelvoud', () => {
        render(<TestChatNotice info={{ active: true, source: 'draft', publishedVersion: 2, unpublishedChanges: 1 }} t={t} />);
        expect(screen.getByTestId('test-chat-notice').textContent).toContain('1 unpublished change.');
        expect(screen.getByTestId('test-chat-notice').textContent).not.toContain('changes');
    });

    it('een agent zonder publicatie krijgt geen versienummer voorgeschoteld', () => {
        render(<TestChatNotice info={{ active: true, source: 'live', publishedVersion: 0, unpublishedChanges: 0 }} t={t} />);
        const el = screen.getByTestId('test-chat-notice');
        expect(el.textContent).toContain('Nothing is published yet');
        expect(el.textContent).not.toContain('Live is v');
    });

    it('BIJT — onbekend wordt niet als "je concept" gepresenteerd', () => {
        render(<TestChatNotice info={{ active: true, source: 'unknown', publishedVersion: 2 }} t={t} />);
        const el = screen.getByTestId('test-chat-notice');
        expect(el).toHaveAttribute('data-source', 'unknown');
        expect(el.textContent).toContain('Could not tell which version');
        expect(el.textContent).not.toContain('your draft');
    });

    it('BIJT — een testchat die tóch de gepubliceerde blob draaide zegt dát', () => {
        render(<TestChatNotice info={{ active: true, source: 'published', publishedVersion: 3 }} t={t} />);
        expect(screen.getByTestId('test-chat-notice').textContent)
            .toContain('came from the published agent');
    });

    it('geen testchat, geen regel', () => {
        const { container } = render(<TestChatNotice info={null} t={t} />);
        expect(container.textContent).toBe('');
        const { container: c2 } = render(<TestChatNotice info={{ active: false, source: 'draft' }} t={t} />);
        expect(c2.textContent).toBe('');
    });
});
