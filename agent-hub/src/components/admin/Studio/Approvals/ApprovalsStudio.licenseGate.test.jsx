import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Approvals section's licence gate, and the drain exemption it must not
 * swallow.
 *
 * Approvals is Enterprise (`approvals`). BROWSING is what you pay for — the
 * list, its facets and the approver directory are the gated server routes — so
 * an unlicensed org gets the upgrade panel here instead of a list that 403s
 * into a permanently empty state.
 *
 * But a deep link to ONE approval must still open. Server-side,
 * GET /approvals/:id, decide and withdraw carry no gate on purpose: a pending
 * approval holds a paused run, and a lapsed licence must never freeze that run
 * with no way out. The UI has to honour the same split, or the drain exemption
 * exists only in the API and nobody can reach it.
 */

const granted = new Set();

vi.mock('../../../licensing/LicenseContext', () => ({
    // Behaves like the real RequireTier's feature branch: children when the
    // capability is effective, the upgrade panel otherwise.
    RequireTier: ({ feature, children }) => (
        granted.has(feature) ? children : <div data-testid="upgrade-prompt">{feature}</div>
    ),
}));
vi.mock('../../../../hooks/useTranslation', () => ({
    default: () => ({ t: (_k, d) => d || _k, locale: 'en' }),
    useTranslation: () => ({ t: (_k, d) => d || _k, locale: 'en' }),
}));
vi.mock('./ApprovalDetail', () => ({
    default: ({ approvalId }) => <div data-testid="approval-detail">{approvalId}</div>,
}));
vi.mock('./useApprovals', () => ({
    default: () => ({
        rows: [], facets: { status: {} }, loading: false, error: null,
        hasMore: false, loadMore: () => {}, reload: () => {}, patchRow: () => {},
    }),
}));

const { default: ApprovalsStudio } = await import('./ApprovalsStudio');

beforeEach(() => granted.clear());

describe('ApprovalsStudio licence gate', () => {
    it('walls the BROWSE surface behind the approvals capability', () => {
        render(<ApprovalsStudio user={{ id: 'u1' }} />);
        expect(screen.getByTestId('upgrade-prompt')).toHaveTextContent('approvals');
        expect(screen.queryByTestId('approvals-search')).toBeNull();
    });

    it('renders the list once the capability is held', () => {
        granted.add('approvals');
        render(<ApprovalsStudio user={{ id: 'u1' }} />);
        expect(screen.queryByTestId('upgrade-prompt')).toBeNull();
        expect(screen.getByTestId('approvals-search')).toBeTruthy();
    });

    it('DRAIN EXEMPTION: a deep link to one approval opens WITHOUT the capability', () => {
        // The notification/e-mail link. Gating this would strand the pending
        // approval — and the run paused behind it — the day a licence lapses.
        render(<ApprovalsStudio user={{ id: 'u1' }} initialApprovalId="ap_1" />);
        expect(screen.queryByTestId('upgrade-prompt')).toBeNull();
        expect(screen.getByTestId('approval-detail')).toHaveTextContent('ap_1');
    });
});
