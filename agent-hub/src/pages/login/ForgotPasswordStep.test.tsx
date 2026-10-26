import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

    // Issue: the source does `if (email.trim()) onSubmit(email.trim())`, but the field is
    // type="email", and that sanitises its own value. jsdom just as well as a real
    // browser strips surrounding spaces before `setEmail`. Those two `.trim()` calls
    // are therefore dead code behind this field type: remove them and nothing changes.
    // They guard nothing. They only suggest that the component sanitises itself. To be
    // changed in stage L16 (either the trim goes, or the field becomes type="text" and
    // the trim really works).
    // The two tests below therefore pin what does happen: the INPUT FIELD sanitises,
    // and only afterwards does the component look at it.
    it('never sees the padding around an address — the email field strips it first', () => {
        const { container, p } = renderStep();
        const input = screen.getByTestId('forgot-email-input');
        fireEvent.change(input, { target: { value: '  ada@example.com  ' } });
        // This is the assertion that holds the mechanism: the value is already clean in the
        // field, not only in the submit handler.
        expect(input).toHaveValue('ada@example.com');
        fireEvent.submit(container.querySelector('form')!);
        expect(p.onSubmit).toHaveBeenCalledWith('ada@example.com');
    });

    it('treats an address of whitespace alone as no address at all', () => {
        const { container, p } = renderStep();
        const input = screen.getByTestId('forgot-email-input');
        fireEvent.change(input, { target: { value: '   ' } });
        // Same sanitising: the field is empty, so the button does not wake up …
        expect(input).toHaveValue('');
        expect(screen.getByText('Send reset link').closest('button')).toBeDisabled();
        // … and a submit that is forced past it passes nothing on.
        fireEvent.submit(container.querySelector('form')!);
        expect(p.onSubmit).not.toHaveBeenCalled();
    });

    it('offers a way back to sign in', async () => {
        const user = userEvent.setup();
        const { p } = renderStep();
        await user.click(screen.getAllByText('Back to sign in')[0]);
        expect(p.onBack).toHaveBeenCalled();
    });
});

describe('after the address has been submitted', () => {
    it('says the same non-committal thing whether or not the account exists', () => {
        renderStep({ sent: true });
        expect(screen.getByText("If an account exists for that email, we've sent a password reset link. Check your inbox.")).toBeInTheDocument();
    });

    // Issue: `sent` is the ONLY thing that decides this screen, and LoginPage flips it in
    // the catch branch too. So a request that never left the browser looks exactly like a
    // delivered mail. Deliberate for account enumeration, misleading for an offline user.
    // To be changed in stage L16 (a separate network error, without revealing existence).
    it('offers no retry and no error state at all once sent', () => {
        renderStep({ sent: true });
        expect(screen.queryByTestId('forgot-email-input')).toBeNull();
        expect(screen.queryByText('Send reset link')).toBeNull();
        expect(screen.getByText('Back to sign in')).toBeInTheDocument();
    });
});
