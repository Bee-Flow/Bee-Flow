// The Nextcloud page of an organisation follows the CHOSEN organisation: the
// user sync for a bound one, pairing for the viewer's own unbound one when the
// server offers it, and a line otherwise. Talk meeting notes are not here (the
// Meeting notes page has them).

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonAnswer } from '@/test/http';
import { availabilityAnswer, availabilityOrgOf } from '@/test/organisationHubKit';
import OrgNextcloudSection from './OrgNextcloudSection';

interface Stub {
    ncBound?: boolean;
    pairingAvailable?: boolean;
    /** The availability read fails. */
    fails?: boolean;
}

function stubApi({ ncBound = false, pairingAvailable, fails = false }: Stub = {}): string[] {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        const address = String(url);
        asked.push(address);
        const org = availabilityOrgOf(address);
        if (org) {
            if (fails) return jsonAnswer({ error: 'down' }, 500);
            const answer = availabilityAnswer({ orgId: org, homeOrg: org === 'org-a', ncBound });
            return jsonAnswer({ ...answer, nextcloud: { ...answer.nextcloud, pairingAvailable: pairingAvailable ?? !ncBound } });
        }
        return jsonAnswer({});
    }));
    return asked;
}

const ORG_ADMIN = { id: 'u2', permissions: ['org_admin'], organizationId: 'org-a' };
const PLATFORM_ADMIN = { id: 'u1', isAdmin: true, role: 'admin', permissions: ['all'], organizationId: 'org-a' };

type Props = Partial<Parameters<typeof OrgNextcloudSection>[0]>;
const mount = (props: Props = {}) => renderWithClient(<OrgNextcloudSection user={ORG_ADMIN} orgId="org-a" homeOrg {...props} />);

// Which panel mounted, told by what it reads: the sync its settings, pairing its codes.
const readsSync = (asked: string[]) => asked.some(a => a.includes('/nc-sync'));
const readsPairing = (asked: string[]) => asked.some(a => a.includes('/pairing-codes'));

beforeEach(() => cleanup());
afterEach(() => vi.unstubAllGlobals());

describe('OrgNextcloudSection', () => {
    it('shows the user sync for a bound organisation, and no pairing', async () => {
        const asked = stubApi({ ncBound: true });
        mount();
        await waitFor(() => expect(readsSync(asked)).toBe(true));
        expect(readsPairing(asked)).toBe(false);
        expect(screen.queryByTestId('nextcloud-not-bound')).toBeNull();
    });

    it('offers pairing to an organisation admin of their own unbound organisation', async () => {
        const asked = stubApi({ ncBound: false });
        mount();
        await waitFor(() => expect(readsPairing(asked)).toBe(true));
        expect(readsSync(asked)).toBe(false);
    });

    it('offers no pairing when the server does not', async () => {
        const asked = stubApi({ ncBound: false, pairingAvailable: false });
        mount();
        expect(await screen.findByTestId('nextcloud-not-bound')).toBeInTheDocument();
        expect(readsPairing(asked)).toBe(false);
    });

    it('never offers pairing for another organisation: the codes are the caller\'s own', async () => {
        const asked = stubApi({ ncBound: false });
        mount({ user: PLATFORM_ADMIN, orgId: 'org-b', homeOrg: false });
        expect(await screen.findByTestId('nextcloud-not-bound')).toBeInTheDocument();
        expect(asked.some(a => availabilityOrgOf(a) === 'org-b')).toBe(true);
        expect(readsPairing(asked)).toBe(false);
    });

    it('shows the platform admin the sync of another organisation that is bound', async () => {
        const asked = stubApi({ ncBound: true });
        mount({ user: PLATFORM_ADMIN, orgId: 'org-b', homeOrg: false });
        await waitFor(() => expect(readsSync(asked)).toBe(true));
    });

    it('offers pairing to the platform admin\'s own organisation while the availability cannot be read', async () => {
        const asked = stubApi({ fails: true });
        mount({ user: PLATFORM_ADMIN });
        await waitFor(() => expect(readsPairing(asked)).toBe(true));
    });
});
