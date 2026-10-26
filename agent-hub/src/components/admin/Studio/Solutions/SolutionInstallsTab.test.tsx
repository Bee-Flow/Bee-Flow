import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import SolutionInstallsTab, { installsBadge } from './SolutionInstallsTab';
import type { ComponentProps } from 'react';
import { stub } from '@/test/mocks';

/**
 * The Installations tab.
 *
 * Two things are guarded here, and the second is a tenancy rule:
 *
 *   1. ZERO IS AN ANSWER, UNKNOWN IS ANOTHER. Someone decides on precisely that
 *      difference whether to discard a Solution.
 *   2. ONLY NUMBERS APPEAR ON THIS SCREEN. No project name, no organisation, no
 *      time — and the number presents itself as a LOWER BOUND, because an
 *      installation from a file or on another instance is invisible here.
 */

const ok = (body: unknown) => ({ status: 'ok', data: body });

describe('zero versus unknown', () => {
    it('A FAILED COUNT SAYS SO — it never renders as "nobody has this"', () => {
        const { getByTestId, queryByTestId } = render(<SolutionInstallsTab remote={{ status: 'error', data: null }} />);
        expect(getByTestId('installs-unreadable')).toBeTruthy();
        expect(queryByTestId('installs-none-yet')).toBeNull();
    });

    it('a real zero is allowed to say nobody has installed it', () => {
        const { getByTestId } = render(<SolutionInstallsTab remote={stub<ComponentProps<typeof SolutionInstallsTab>['remote']>(ok({ installsHere: 0, installsElsewhere: 0 }))} />);
        expect(getByTestId('installs-none-yet')).toBeTruthy();
    });

    it('one unknown half is named as unknown while the other still shows its number', () => {
        const { getByTestId } = render(<SolutionInstallsTab remote={stub<ComponentProps<typeof SolutionInstallsTab>['remote']>(ok({ installsHere: 3, installsElsewhere: null }))} />);
        expect(getByTestId('installs-here').textContent).toMatch(/3 Solutions in your organisation/);
        expect(getByTestId('installs-elsewhere').textContent).toMatch(/could not be read/);
        // …and that is not “zero elsewhere”, so also not “nobody has this”.
        expect(getByTestId('installs-elsewhere').textContent).not.toMatch(/\b0\b/);
    });

    it('counts one thing as one thing', () => {
        const { getByTestId } = render(<SolutionInstallsTab remote={stub<ComponentProps<typeof SolutionInstallsTab>['remote']>(ok({ installsHere: 1, installsElsewhere: 1 }))} />);
        expect(getByTestId('installs-here').textContent).toMatch(/1 Solution in your organisation/);
        expect(getByTestId('installs-elsewhere').textContent).toMatch(/1 other Solution elsewhere/);
    });

    it('while loading it says neither', () => {
        const { queryByTestId } = render(<SolutionInstallsTab remote={{ status: 'loading' }} />);
        expect(queryByTestId('installs-unreadable')).toBeNull();
        expect(queryByTestId('installs-none-yet')).toBeNull();
    });
});

describe('what the number is worth', () => {
    it('ALWAYS says the count is a lower bound, even on a healthy read', () => {
        const { getByTestId } = render(<SolutionInstallsTab remote={stub<ComponentProps<typeof SolutionInstallsTab>['remote']>(ok({ installsHere: 4, installsElsewhere: 2 }))} />);
        expect(getByTestId('installs-incomplete').textContent).toMatch(/at least this many/);
        // The sentence must also say WHY it is a lower bound. Since the server checks the
        // origin claim of a file (install.verifyClaimedBlueprint), a file installation
        // on THIS instance DOES count, so “a file is invisible here” would now be the
        // wrong reassurance — in the direction that makes the number look too low,
        // while file installations may in fact make it rise.
        expect(getByTestId('installs-incomplete').textContent).toMatch(/on another instance is invisible here/);
        expect(getByTestId('installs-incomplete').textContent).not.toMatch(/only installations made from the gallery/);
    });

    it('SHOWS NOTHING BUT NUMBERS — no project, no organisation, no owner', () => {
        const { container } = render(<SolutionInstallsTab remote={stub<ComponentProps<typeof SolutionInstallsTab>['remote']>(ok({
            installsHere: 2, installsElsewhere: 1,
            projects: [{ id: 'p9', name: 'Acme onboarding', ownerId: 'u_bob', organizationId: 'org_b' }],
            organizations: [{ id: 'org_b', name: 'Acme BV', installs: 1 }],
            lastInstalledAt: '2026-09-07T12:00:00Z',
        }))} />);
        const text = container.textContent;
        for (const leak of ['Acme', 'org_b', 'u_bob', 'p9', '2026-09-07']) {
            expect(text).not.toMatch(leak);
        }
    });
});

describe('the tab badge', () => {
    it('is the total when both halves are known', () => {
        expect(installsBadge(stub<Parameters<typeof installsBadge>[0]>(ok({ installsHere: 2, installsElsewhere: 3 })))).toEqual({ count: 5 });
    });

    it('IS NO NUMBER AT ALL when either half is unknown — never a half-sum', () => {
        expect(installsBadge(stub<Parameters<typeof installsBadge>[0]>(ok({ installsHere: 2, installsElsewhere: null })))).toEqual({ count: undefined });
        expect(installsBadge({ status: 'error', data: null })).toEqual({ count: undefined });
        expect(installsBadge({ status: 'loading' })).toEqual({ count: undefined });
    });

    it('A REAL ZERO GETS NO BADGE EITHER — a bare "0" on a tab strip is a claim without its caveat', () => {
        // A number > 0 is a LOWER BOUND and remains true even if it is too low; a “0”
        // reads as “nobody uses this”, while a file installation by definition is not
        // counted. The tab itself says which of the two it is.
        expect(installsBadge(stub<Parameters<typeof installsBadge>[0]>(ok({ installsHere: 0, installsElsewhere: 0 })))).toEqual({ count: undefined });
        expect(installsBadge(stub<Parameters<typeof installsBadge>[0]>(ok({ installsHere: 0, installsElsewhere: 1 })))).toEqual({ count: 1 });
    });
});
