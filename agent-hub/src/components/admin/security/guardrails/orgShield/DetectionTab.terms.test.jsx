/**
 * The Detection tab around its matrix: the two cards under it, and the
 * guard that keeps the matrix's bulk buttons off the org's own types.
 *
 * The org's own words and patterns, and the exceptions that are never hidden,
 * are both edited on "Your own data"; here each is one card that summarises it
 * and opens that pane. The never-hidden editor itself is tested with its
 * component (parts/AllowTermsChips).
 *
 * Run: npx vitest run src/components/admin/security/guardrails/orgShield/DetectionTab.terms.test.jsx
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

import DetectionTab from './tabs/DetectionTab';
import { piiCategoriesLocalized } from '../../../../../config/piiCategories';

const t = (key, fallback, params) => {
    let s = typeof fallback === 'string' ? fallback : key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, v);
    return s;
};

const CUSTOM = 'cdt_0123456789';

function renderTab(over = {}, evidence = null) {
    const f = {
        piiCategories: ['Email', CUSTOM],
        setPiiCategories: vi.fn(),
        toolPiiPolicy: { external: { blockCategories: [CUSTOM] }, internal: { blockCategories: ['Person', CUSTOM] } },
        piiConfidenceThreshold: 0.7,
        setPiiConfidenceThreshold: vi.fn(),
        piiAllowTerms: [],
        piiAllowPublicOrgs: true,
        customDataTypes: [],
        ...over,
    };
    const onGoTo = vi.fn();
    render(
        <DetectionTab
            f={f}
            categories={piiCategoriesLocalized(t)}
            readOnly={false}
            licence={{ canUseWebSearchGuard: true }}
            evidence={evidence}
            toggleToolPiiCat={vi.fn()}
            onGoTo={onGoTo}
            t={t}
        />,
    );
    return { f, onGoTo };
}

describe('DetectionTab link cards', () => {
    it('points to Your own data where "Always hide these" used to be', async () => {
        const user = userEvent.setup();
        const { onGoTo } = renderTab({
            customDataTypes: [{ id: CUSTOM, name: 'A' }, { id: 'cdt_0123456780', name: 'B' }],
        });
        expect(screen.getByText('2 types. They now live under Your own data.')).toBeInTheDocument();
        // The whole card is the button.
        await user.click(screen.getByRole('button', { name: /Your own words and patterns/ }));
        expect(onGoTo).toHaveBeenCalledWith('owndata');
    });

    it('invites an admin with nothing of their own yet', () => {
        renderTab();
        expect(screen.getByText('None yet — add project codes, customer numbers and more.')).toBeInTheDocument();
    });

    it('summarises the never-hidden exceptions and opens Your own data to edit them', async () => {
        const user = userEvent.setup();
        const { onGoTo } = renderTab({ piiAllowTerms: ['Kifid', 'Van Dael'] });
        const card = screen.getByRole('button', { name: /Never hidden/ });
        expect(card).toHaveTextContent('221 well-known companies · 2 of your own.');
        expect(card).toHaveTextContent('"Shell" does not cover "Shell Advies BV"');
        await user.click(card);
        expect(onGoTo).toHaveBeenCalledWith('owndata');
        // The editor moved: nothing on this tab adds an exception any more.
        expect(screen.queryByRole('textbox')).toBeNull();
    });

    it('claims the 221 well-known companies only while that list is on', () => {
        renderTab({ piiAllowPublicOrgs: false });
        const card = screen.getByRole('button', { name: /Never hidden/ });
        expect(card).toHaveTextContent('0 of your own.');
        expect(card).not.toHaveTextContent('221');
        expect(screen.queryByText(/well-known companies are never hidden/)).toBeNull();
    });

});

describe('DetectionTab matrix and the org\'s own types', () => {
    it('counts only the built-in kinds in the matrix header', () => {
        renderTab();
        // One built-in kind (Email) is ticked; the custom id beside it is not
        // a 22nd row.
        expect(screen.getByRole('columnheader', { name: /Hide from AI/ })).toHaveTextContent('look for it · 1 of 21');
    });

    it('never switches the org\'s own types off with the matrix\'s None or All', async () => {
        // The switches of "Your own data" are ids in the SAME lists. A whole-
        // list write from the matrix used to be the whole list, so "None"
        // here would have silently disabled every one of the org's own types.
        const user = userEvent.setup();
        const { f } = renderTab();
        await user.click(screen.getByRole('button', { name: 'None' }));
        expect(f.setPiiCategories).toHaveBeenLastCalledWith([CUSTOM]);
        await user.click(screen.getByRole('button', { name: 'All' }));
        const all = f.setPiiCategories.mock.calls.at(-1)[0];
        expect(all).toContain(CUSTOM);
        expect(all).toHaveLength(22);
    });

    it('shows what left with tools per kind only when the last 30 days are known', () => {
        renderTab({}, { days: 30, toolKinds: { Email: 12 } });
        expect(screen.getByText('12 left with tools')).toBeInTheDocument();
    });

    it('shows no tool figures at all when they are unknown', () => {
        renderTab({}, null);
        expect(screen.queryByText(/left with tools/)).toBeNull();
    });
});
