import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ResetPasswordStep from './ResetPasswordStep';

/**
 * CHARACTERISATION — the new-password form behind a reset link (L0).
 *
 * The reset TOKEN lives in the parent (LoginPage strips it from the URL); this
 * step only validates locally and hands the new password up. Two rules are
 * enforced here and nowhere else on this screen: at least eight characters,
 * and the two fields must match.
 */
vi.mock('../../hooks/useTranslation', () => import('@/test/useTranslationMock'));

function renderStep(overrides = {}) {
    const p = {
        onSubmit: vi.fn(),
        onDone: vi.fn(),
        isLoading: false,
        done: false,
        inputClass: 'input', labelClass: 'label',
        ...overrides,
    };
    return { ...render(<ResetPasswordStep {...p} />), p };
}

const fill = (pw, confirm) => {
    fireEvent.change(screen.getByTestId('reset-new-password'), { target: { value: pw } });
    const [, second] = screen.getAllByPlaceholderText('••••••••');
    fireEvent.change(second, { target: { value: confirm } });
};

describe('choosing a new password', () => {
    it('asks for the new password twice', () => {
        renderStep();
        expect(screen.getByText('Choose a new password for your account.')).toBeInTheDocument();
        expect(screen.getAllByPlaceholderText('••••••••')).toHaveLength(2);
    });

    it('accepts a matching pair of at least eight characters', () => {
        const { container, p } = renderStep();
        fill('correct-horse', 'correct-horse');
        fireEvent.submit(container.querySelector('form'));
        expect(p.onSubmit).toHaveBeenCalledWith('correct-horse');
    });

    it('refuses a password under eight characters and says so in place', () => {
        const { container, p } = renderStep();
        fill('short', 'short');
        fireEvent.submit(container.querySelector('form'));
        expect(screen.getByText('Password must be at least 8 characters')).toBeInTheDocument();
        expect(p.onSubmit).not.toHaveBeenCalled();
    });

    it('refuses two passwords that do not match', () => {
        const { container, p } = renderStep();
        fill('correct-horse', 'correct-hors');
        fireEvent.submit(container.querySelector('form'));
        expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
        expect(p.onSubmit).not.toHaveBeenCalled();
    });

    it('clears the local complaint on the next attempt', () => {
        const { container } = renderStep();
        fill('short', 'short');
        fireEvent.submit(container.querySelector('form'));
        fill('correct-horse', 'correct-horse');
        fireEvent.submit(container.querySelector('form'));
        expect(screen.queryByText('Password must be at least 8 characters')).toBeNull();
    });

    // wrat: this is the ONLY strength rule on the reset path — length. The
    // first-run root password advertises "uppercase, lowercase and number"
    // (login.password_requirements) and signup runs signupValidation, so the
    // same account can be reset to a weaker password than it could be created
    // with. Hoort in stage L16 te veranderen.
    it('accepts eight lowercase letters with no digit or capital', () => {
        const { container, p } = renderStep();
        fill('aaaaaaaa', 'aaaaaaaa');
        fireEvent.submit(container.querySelector('form'));
        expect(p.onSubmit).toHaveBeenCalledWith('aaaaaaaa');
    });

    // wrat: the submit button is only disabled by `isLoading`, never by the
    // local validation, so an empty form is clickable and the complaint only
    // appears after pressing it. Hoort in stage L12 te veranderen.
    it('leaves the button pressable while both fields are still empty', () => {
        renderStep();
        expect(screen.getByText('Set new password').closest('button')).not.toBeDisabled();
    });

    it('locks the button while the reset request is in flight', () => {
        renderStep({ isLoading: true });
        expect(screen.getByRole('button')).toBeDisabled();
    });
});

describe('after a successful reset', () => {
    it('confirms and offers the way back to sign in', () => {
        const { p } = renderStep({ done: true });
        expect(screen.getByText('Your password has been reset. You can now sign in with your new password.')).toBeInTheDocument();
        expect(screen.queryByTestId('reset-new-password')).toBeNull();
        fireEvent.click(screen.getByText('Go to sign in'));
        expect(p.onDone).toHaveBeenCalled();
    });
});
