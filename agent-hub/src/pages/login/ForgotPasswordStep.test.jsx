import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ForgotPasswordStep from './ForgotPasswordStep';

/**
 * CHARACTERISATION — the "forgot your password" email step as it is today (L0).
 *
 * The privacy contract of this screen is that it must not reveal whether an
 * account exists, and the whole confirmation is driven by ONE prop (`sent`)
 * that the parent flips regardless of what the server said. The tests below
 * pin that, because it is exactly the kind of thing a redesign "improves" by
 * adding a helpful "no such account" message.
 */
vi.mock('../../hooks/useTranslation', () => import('@/test/useTranslationMock'));

function renderStep(overrides = {}) {
    const p = {
        onSubmit: vi.fn(),
        onBack: vi.fn(),
        isLoading: false,
        sent: false,
        inputClass: 'input', labelClass: 'label',
        ...overrides,
    };
    return { ...render(<ForgotPasswordStep {...p} />), p };
}

describe('asking where to send the link', () => {
    it('explains what will happen and asks for one email address', () => {
        renderStep();
        expect(screen.getByText("Enter your email and we'll send you a link to reset your password.")).toBeInTheDocument();
        expect(screen.getByTestId('forgot-email-input')).toHaveAttribute('type', 'email');
        expect(screen.getByTestId('forgot-email-input')).toBeRequired();
    });

    it('keeps the send button dead until an address is typed', () => {
        renderStep();
        const send = screen.getByText('Send reset link').closest('button');
        expect(send).toBeDisabled();
        fireEvent.change(screen.getByTestId('forgot-email-input'), { target: { value: 'ada@example.com' } });
        expect(send).not.toBeDisabled();
    });

    // wrat: de bron doet `if (email.trim()) onSubmit(email.trim())`, maar het
    // veld is type="email" en dat saneert zijn eigen waarde — jsdom net zo goed
    // als een echte browser strippen omringende spaties vóór `setEmail`. Die
    // twee `.trim()`-aanroepen zijn achter dit veldtype dus dode code: haal ze
    // weg en er verandert niets. Ze bewaken niets, ze suggereren alleen dat de
    // component zelf saneert. Hoort in stage L16 te veranderen (of de trim
    // verdwijnt, of het veld wordt type="text" en de trim gaat écht werken).
    // De twee tests hieronder pinnen daarom wat er wél gebeurt: het INVOERVELD
    // saneert, en pas dáárna kijkt de component ernaar.
    it('never sees the padding around an address — the email field strips it first', () => {
        const { container, p } = renderStep();
        const input = screen.getByTestId('forgot-email-input');
        fireEvent.change(input, { target: { value: '  ada@example.com  ' } });
        // Dit is de assertie die het mechanisme vasthoudt: de waarde is al
        // schoon in het veld, niet pas in de submit-handler.
        expect(input).toHaveValue('ada@example.com');
        fireEvent.submit(container.querySelector('form'));
        expect(p.onSubmit).toHaveBeenCalledWith('ada@example.com');
    });

    it('treats an address of whitespace alone as no address at all', () => {
        const { container, p } = renderStep();
        const input = screen.getByTestId('forgot-email-input');
        fireEvent.change(input, { target: { value: '   ' } });
        // Zelfde sanitisatie: het veld is leeg, dus de knop wordt niet wakker …
        expect(input).toHaveValue('');
        expect(screen.getByText('Send reset link').closest('button')).toBeDisabled();
        // … en een submit die er langs geforceerd wordt, geeft niets door.
        fireEvent.submit(container.querySelector('form'));
        expect(p.onSubmit).not.toHaveBeenCalled();
    });

    it('offers a way back to sign in', () => {
        const { p } = renderStep();
        fireEvent.click(screen.getAllByText('Back to sign in')[0]);
        expect(p.onBack).toHaveBeenCalled();
    });
});

describe('after the address has been submitted', () => {
    it('says the same non-committal thing whether or not the account exists', () => {
        renderStep({ sent: true });
        expect(screen.getByText("If an account exists for that email, we've sent a password reset link. Check your inbox.")).toBeInTheDocument();
    });

    // wrat: `sent` is the ONLY thing that decides this screen, and LoginPage
    // flips it in the catch branch too — so a request that never left the
    // browser looks exactly like a delivered mail. Deliberate for account
    // enumeration, misleading for an offline user. Hoort in stage L16 te
    // veranderen (een aparte netwerkfout, zonder het bestaan te verklappen).
    it('offers no retry and no error state at all once sent', () => {
        renderStep({ sent: true });
        expect(screen.queryByTestId('forgot-email-input')).toBeNull();
        expect(screen.queryByText('Send reset link')).toBeNull();
        expect(screen.getByText('Back to sign in')).toBeInTheDocument();
    });
});
