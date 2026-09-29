import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The authenticator-app enrolment block (BFSF-280): steps, QR, a tap-to-add
 * link and the manual key. What is pinned is what a phone gets that a desktop
 * does not: the otpauth:// link first and the setup key unfolded, because the
 * QR is on the screen of the device that would have to scan it.
 *
 * jsdom has no media queries; the test setup's polyfill reports "no match"
 * (a desktop), and the phone cases stub matchMedia to match.
 */

vi.mock('../../hooks/useTranslation', () => import('@/test/useTranslationMock'));

import AuthenticatorAppSetup from './AuthenticatorAppSetup';

const SETUP = { otpauthUrl: 'otpauth://totp/Example:user?issuer=Example', qr: 'data:image/png;base64,QR', secret: 'JBSWY3DPEHPK3PXP' };

function asPhone() {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
        matches: true, media: query, onchange: null,
        addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
        dispatchEvent: () => false,
    }) as unknown as MediaQueryList);
}

/** Whether `a` comes before `b` in the document. */
const precedes = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

afterEach(() => { vi.restoreAllMocks(); });

describe('AuthenticatorAppSetup', () => {
    it('links to the otpauth URI so the app on this device can take it', () => {
        render(<AuthenticatorAppSetup {...SETUP} />);
        const link = screen.getByRole('link', { name: /Add to the authenticator app on this device/ });
        expect(link).toHaveAttribute('href', SETUP.otpauthUrl);
    });

    it('offers no link for anything that is not an otpauth URI', () => {
        render(<AuthenticatorAppSetup {...SETUP} otpauthUrl="https://example.test/add" />);
        expect(screen.queryByRole('link')).toBeNull();
        expect(screen.getByAltText('MFA QR code')).toBeInTheDocument();
    });

    it('on a desktop: QR first, the link after it, the key folded but openable', async () => {
        const { container } = render(<AuthenticatorAppSetup {...SETUP} />);
        const details = container.querySelector('details') as HTMLDetailsElement;
        expect(details.open).toBe(false);
        expect(precedes(screen.getByAltText('MFA QR code'), screen.getByRole('link'))).toBe(true);
        await userEvent.click(screen.getByText('Can’t scan? Enter this key manually'));
        expect(details.open).toBe(true);
    });

    it('on a phone: the link before the QR, and the setup key already unfolded', () => {
        asPhone();
        const { container } = render(<AuthenticatorAppSetup {...SETUP} />);
        expect(precedes(screen.getByRole('link'), screen.getByAltText('MFA QR code'))).toBe(true);
        expect((container.querySelector('details') as HTMLDetailsElement).open).toBe(true);
        expect(screen.getByText(SETUP.secret)).toBeVisible();
    });

    it('keeps the three numbered steps', () => {
        const { container } = render(<AuthenticatorAppSetup {...SETUP} />);
        expect(container.querySelectorAll('ol li')).toHaveLength(3);
    });
});
