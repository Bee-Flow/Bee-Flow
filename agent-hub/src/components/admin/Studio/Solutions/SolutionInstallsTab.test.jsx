import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import SolutionInstallsTab, { installsBadge } from './SolutionInstallsTab';

/**
 * De Installaties-tab.
 *
 * Twee dingen worden hier bewaakt, en het tweede is een tenancy-regel:
 *
 *   1. NUL IS EEN ANTWOORD, ONBEKEND IS EEN ANDER. Op precies dat verschil
 *      besluit iemand of hij een Oplossing weggooit.
 *   2. ER STAAN ALLEEN GETALLEN OP DIT SCHERM. Geen projectnaam, geen
 *      organisatie, geen tijdstip — en het getal presenteert zichzelf als een
 *      ONDERGRENS, want een installatie uit een bestand of op een andere
 *      instantie is hier onzichtbaar.
 */

const ok = (body) => ({ status: 'ok', data: body });

describe('zero versus unknown', () => {
    it('A FAILED COUNT SAYS SO — it never renders as "nobody has this"', () => {
        const { getByTestId, queryByTestId } = render(<SolutionInstallsTab remote={{ status: 'error', data: null }} />);
        expect(getByTestId('installs-unreadable')).toBeTruthy();
        expect(queryByTestId('installs-none-yet')).toBeNull();
    });

    it('a real zero is allowed to say nobody has installed it', () => {
        const { getByTestId } = render(<SolutionInstallsTab remote={ok({ installsHere: 0, installsElsewhere: 0 })} />);
        expect(getByTestId('installs-none-yet')).toBeTruthy();
    });

    it('one unknown half is named as unknown while the other still shows its number', () => {
        const { getByTestId } = render(<SolutionInstallsTab remote={ok({ installsHere: 3, installsElsewhere: null })} />);
        expect(getByTestId('installs-here').textContent).toMatch(/3 Solutions in your organisation/);
        expect(getByTestId('installs-elsewhere').textContent).toMatch(/could not be read/);
        // …en dat is geen "nul elders", dus ook geen "niemand heeft dit".
        expect(getByTestId('installs-elsewhere').textContent).not.toMatch(/\b0\b/);
    });

    it('counts one thing as one thing', () => {
        const { getByTestId } = render(<SolutionInstallsTab remote={ok({ installsHere: 1, installsElsewhere: 1 })} />);
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
        const { getByTestId } = render(<SolutionInstallsTab remote={ok({ installsHere: 4, installsElsewhere: 2 })} />);
        expect(getByTestId('installs-incomplete').textContent).toMatch(/at least this many/);
        // De zin moet ook zeggen WAAROM het een ondergrens is. Sinds de server
        // de herkomstbewering van een bestand naloopt (install.verifyClaimed-
        // Blueprint) telt een bestandsinstallatie op DEZE instantie wél mee, dus
        // "een bestand is hier onzichtbaar" zou nu de verkeerde geruststelling
        // zijn — in de richting die het getal te laag laat lijken terwijl
        // bestandsinstallaties het juist kunnen laten oplopen.
        expect(getByTestId('installs-incomplete').textContent).toMatch(/on another instance is invisible here/);
        expect(getByTestId('installs-incomplete').textContent).not.toMatch(/only installations made from the gallery/);
    });

    it('SHOWS NOTHING BUT NUMBERS — no project, no organisation, no owner', () => {
        const { container } = render(<SolutionInstallsTab remote={ok({
            installsHere: 2, installsElsewhere: 1,
            projects: [{ id: 'p9', name: 'Acme onboarding', ownerId: 'u_bob', organizationId: 'org_b' }],
            organizations: [{ id: 'org_b', name: 'Acme BV', installs: 1 }],
            lastInstalledAt: '2026-09-07T12:00:00Z',
        })} />);
        const text = container.textContent;
        for (const leak of ['Acme', 'org_b', 'u_bob', 'p9', '2026-09-07']) {
            expect(text).not.toMatch(leak);
        }
    });
});

describe('the tab badge', () => {
    it('is the total when both halves are known', () => {
        expect(installsBadge(ok({ installsHere: 2, installsElsewhere: 3 }))).toEqual({ count: 5 });
    });

    it('IS NO NUMBER AT ALL when either half is unknown — never a half-sum', () => {
        expect(installsBadge(ok({ installsHere: 2, installsElsewhere: null }))).toEqual({ count: undefined });
        expect(installsBadge({ status: 'error', data: null })).toEqual({ count: undefined });
        expect(installsBadge({ status: 'loading' })).toEqual({ count: undefined });
    });

    it('A REAL ZERO GETS NO BADGE EITHER — a bare "0" on a tab strip is a claim without its caveat', () => {
        // Een getal > 0 is een ONDERGRENS en blijft waar als hij te laag is; een
        // "0" leest als "niemand gebruikt dit", terwijl een bestandsinstallatie
        // per definitie niet meetelt. De tab zelf zegt welke van de twee het is.
        expect(installsBadge(ok({ installsHere: 0, installsElsewhere: 0 }))).toEqual({ count: undefined });
        expect(installsBadge(ok({ installsHere: 0, installsElsewhere: 1 }))).toEqual({ count: 1 });
    });
});
