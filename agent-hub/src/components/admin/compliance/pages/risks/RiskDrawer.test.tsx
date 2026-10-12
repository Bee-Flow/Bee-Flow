import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RiskDrawerJs from './RiskDrawer';
import { acceptPatchOf, draftOf, memberOptions, patchOf } from './riskDraft';

/**
 * The risk drawer's two decisions. "Accept risk" used to send only
 * `{ status: 'accepted' }`; the server bumps updated_at on that write, the
 * draft resets on updated_at, and an owner or review date typed just before
 * was gone. It now sends the draft with the status, in one write.
 */
vi.mock('../../../../../hooks/useTranslation', () => {
    const t = (key: string, fallback?: unknown, vars?: Record<string, unknown>) => {
        let s = typeof fallback === 'string' ? fallback : key;
        for (const [k, v] of Object.entries(vars || {})) s = s.split(`{${k}}`).join(String(v));
        return s;
    };
    const hook = () => ({ t, locale: 'en', resolvedLocale: 'en' });
    return { useTranslation: hook, default: hook };
});

interface Risk {
    id: number; title: string; description?: string | null; category: string; likelihood: number; impact: number;
    score?: number; status: string; owner_user_id?: string | null; review_due_at?: string | null;
    accepted_at?: string | null; accepted_by?: string | null; updated_at?: string;
}
interface Member { id: string; displayName?: string; email?: string }

// RiskDrawer is plain JavaScript; these are the props it takes.
const RiskDrawer = RiskDrawerJs as unknown as React.ComponentType<{
    risk: Risk; treatments?: unknown[]; orgUsers?: Member[] | null; busy?: boolean;
    onUpdate?: (id: number, patch: Record<string, unknown>) => unknown;
    onAddTreatment?: (id: number, fields: Record<string, unknown>) => unknown;
    onClose?: () => void; mode?: string;
}>;

afterEach(cleanup);

const USERS: Member[] = [
    { id: 'u1', displayName: 'T. Smit', email: 'tom@example.org' },
    { id: 'u2', displayName: 'R. Bakker', email: 'r@example.org' },
];

const RISK: Risk = {
    id: 2, title: 'Provider outage', description: null, category: 'availability', likelihood: 3, impact: 3, score: 9,
    status: 'treating', owner_user_id: 'u2', review_due_at: '2026-11-01', updated_at: '2026-09-01T10:00:00Z',
};

function renderDrawer(over: Partial<React.ComponentProps<typeof RiskDrawer>> = {}) {
    const onUpdate = vi.fn().mockResolvedValue({});
    const utils = render(<RiskDrawer risk={RISK} orgUsers={USERS} onUpdate={onUpdate} onAddTreatment={vi.fn()} onClose={vi.fn()} {...over} />);
    return { ...utils, onUpdate };
}

describe('RiskDrawer — Accept keeps the edits typed before it', () => {
    it('sends the changed owner and review date together with status "accepted", in one write', async () => {
        const user = userEvent.setup();
        const { onUpdate } = renderDrawer();
        await user.selectOptions(screen.getByTestId('risk-drawer-owner'), 'u1');
        const review = screen.getByTestId('risk-drawer-review');
        await user.clear(review);
        await user.type(review, '2026-12-15');
        await user.click(screen.getByTestId('risk-drawer-accept'));
        expect(onUpdate).toHaveBeenCalledTimes(1);
        expect(onUpdate).toHaveBeenCalledWith(2, {
            title: 'Provider outage', description: null, category: 'availability', likelihood: 3, impact: 3,
            status: 'accepted', owner_user_id: 'u1', review_due_at: '2026-12-15',
        });
    });

    it('acceptPatchOf is patchOf with the accepted status, whatever the status select says', () => {
        const draft = draftOf({ title: ' T ', category: 'integrity', likelihood: 2, impact: 4, status: 'open', review_due_at: '2026-12-15T00:00:00Z' });
        expect(draft.review_due_at).toBe('2026-12-15');
        expect(acceptPatchOf(draft)).toEqual({ ...patchOf(draft), status: 'accepted' });
        expect(patchOf(draft)).toEqual({
            title: 'T', description: null, category: 'integrity', likelihood: 2, impact: 4, status: 'open', owner_user_id: null, review_due_at: '2026-12-15',
        });
    });
});

describe('RiskDrawer — the footer', () => {
    it('holds "Accept risk" on the left and "Save changes" as the primary on the right', async () => {
        const user = userEvent.setup();
        const { onUpdate } = renderDrawer();
        const footer = screen.getByTestId('risk-drawer-actions');
        expect(within(screen.getByTestId('risk-drawer-actions-secondary')).getByTestId('risk-drawer-accept')).toBeTruthy();
        const save = within(footer).getByTestId('risk-drawer-actions-primary');
        expect(save.textContent).toMatch(/Save changes/);
        await user.click(save);
        expect(onUpdate).toHaveBeenCalledWith(2, expect.objectContaining({ status: 'treating', owner_user_id: 'u2' }));
    });

    it('offers no Accept for a risk that is already accepted (the stamp says who and when) or closed', () => {
        const { unmount } = renderDrawer({ risk: { ...RISK, status: 'accepted', accepted_at: '2026-08-01T10:00:00Z', accepted_by: 'u1' } });
        expect(screen.queryByTestId('risk-drawer-accept')).toBeNull();
        expect(screen.getByTestId('risk-drawer-accepted').textContent).toMatch(/Accepted by T\. Smit on 1 Aug/);
        unmount();
        renderDrawer({ risk: { ...RISK, status: 'closed' } });
        expect(screen.queryByTestId('risk-drawer-accept')).toBeNull();
    });
});

describe('RiskDrawer — the owner select', () => {
    it('lists members by name and shows no e-mail while every name is unique', () => {
        renderDrawer();
        const select = screen.getByTestId('risk-drawer-owner') as HTMLSelectElement;
        expect(select.value).toBe('u2');
        expect(Array.from(select.options).map(o => o.textContent)).toEqual(['No owner', 'T. Smit', 'R. Bakker']);
        expect(select.innerHTML).not.toMatch(/@/);
    });

    it('adds the address only to members who share a name, and names a nameless member by address', () => {
        const opts = memberOptions([
            { id: 'a', displayName: 'Sam de Vries', email: 'sam@one.test' },
            { id: 'b', displayName: 'sam de vries', email: 'sam@two.test' },
            { id: 'c', displayName: 'R. Bakker', email: 'r@example.org' },
            { id: 'd', email: 'nameless@example.org' },
        ]);
        expect(opts.map(o => o.label)).toEqual(['Sam de Vries (sam@one.test)', 'sam de vries (sam@two.test)', 'R. Bakker', 'nameless@example.org']);
    });

    it('keeps an option for a stored owner who is no longer a member, so the select does not claim "No owner"', () => {
        expect(memberOptions(USERS, 'gone').at(-1)).toEqual({ value: 'gone', label: '—' });
        expect(memberOptions(null)).toEqual([]);
    });
});
