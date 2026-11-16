// The organisation form saves one row at a time. It used to send every field
// it had loaded with every save, so a save of Organisation info put back the
// auto-approve, default groups and sign-up values it had read when the page
// opened, undoing a change made on the Users screen in the meantime.

import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import useOrgInfoForm, { type OrgInfoSaveState } from './useOrgInfoForm';
import { orgFormRowFields, type OrgFormData } from './orgInfoFormRows';
import type { TranslateFn } from '@/hooks/useTranslation';
import { renderHookWithClient } from '@/test/render';
import { setDemoTransport } from '@/utils/helpers';

const ORG = {
    id: 'org1', name: 'Acme', tagline: 'Old', authMethod: 'password', allowedDomains: ['acme.nl'],
    autoApproveSSO: true, defaultGroups: ['g1'], allowSignup: true, footerText: 'Footer', usagePooled: true,
};

const t: TranslateFn = (key, fallback) => (typeof fallback === 'string' ? fallback : String(key));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let puts: Record<string, unknown>[];

beforeEach(() => {
    puts = [];
    setDemoTransport(async (url: unknown, init: RequestInit = {}) => {
        const path = String(url);
        if ((init.method || 'GET') === 'PUT') {
            puts.push(JSON.parse(String(init.body)));
            return json({ success: true });
        }
        if (path.endsWith('/auth/organizations')) return json([ORG]);
        if (path.endsWith('/auth/groups')) return json([]);
        return json({}, 404);
    });
});
afterEach(() => { setDemoTransport(null); });

/** The form on `section`, with what it last told the save bar (hasChanges, handleSave). */
async function mountForm(section: string) {
    const states: OrgInfoSaveState[] = [];
    const hook = renderHookWithClient(
        ({ row }: { row: string }) => useOrgInfoForm({ user: null, orgId: 'org1', section: row, t, onStateChange: s => states.push(s) }),
        { initialProps: { row: section } },
    );
    await waitFor(() => expect(hook.result.current.orgData).not.toBeNull());
    const bar = () => states[states.length - 1];
    const edit = (patch: Partial<OrgFormData>) => act(() => hook.result.current.setOrgData(p => (p ? { ...p, ...patch } : p)));
    const save = () => act(async () => { await bar().handleSave(); });
    return { hook, bar, edit, save };
}

describe('useOrgInfoForm: a save sends only the row being saved', () => {
    it('Organisation info sends the changed field, never the fields other screens own', async () => {
        const { edit, save } = await mountForm('info');
        edit({ tagline: 'New' });
        await save();
        expect(puts).toEqual([{ tagline: 'New' }]);
    });

    it('an unsaved edit on another row is neither sent nor counted, and stays unsaved', async () => {
        const { hook, bar, edit, save } = await mountForm('info');
        edit({ allowedDomains: ['acme.nl', 'acme.com'] });
        expect(bar().hasChanges).toBe(false);
        edit({ name: 'Acme BV' });
        await waitFor(() => expect(bar().hasChanges).toBe(true));
        await save();
        expect(puts).toEqual([{ name: 'Acme BV' }]);
        await waitFor(() => expect(bar().hasChanges).toBe(false));

        // Over on the sign-in row the domain edit is still waiting for its own save.
        hook.rerender({ row: 'auth' });
        await waitFor(() => expect(bar().hasChanges).toBe(true));
        await save();
        expect(puts[1]).toEqual({ allowedDomains: ['acme.nl', 'acme.com'] });
    });

    it('the sign-in row can change the method again after a save', async () => {
        const { edit, save } = await mountForm('auth');
        edit({ authMethod: 'google' });
        await save();
        edit({ authMethod: 'microsoft' });
        await save();
        expect(puts).toEqual([{ authMethod: 'google' }, { authMethod: 'microsoft' }]);
    });
});

describe('orgFormRowFields', () => {
    it('puts the image limits on their own row (the Models page) in every deployment mode, never on info or licence', () => {
        expect(orgFormRowFields('image-limits')).toEqual(['imageLimits']);
        expect(orgFormRowFields('license')).toEqual(['usagePooled']);
        expect(orgFormRowFields('info')).not.toContain('imageLimits');
    });

    it('gives the sign-in row its two fields, and no row the fields edited elsewhere', () => {
        expect(orgFormRowFields('auth')).toEqual(['authMethod', 'allowedDomains']);
        for (const row of ['info', 'auth', 'license', 'image-limits', undefined]) {
            for (const owned of ['autoApproveSSO', 'defaultGroups', 'allowSignup', 'logo']) {
                expect(orgFormRowFields(row)).not.toContain(owned);
            }
        }
    });
});

describe('useOrgInfoForm: what the form reads but never saves', () => {
    it('carries the stored auto-approve and the Nextcloud binding of the chosen organisation', async () => {
        setDemoTransport(async (url: unknown, init: RequestInit = {}) => {
            const path = String(url);
            if ((init.method || 'GET') === 'PUT') {
                puts.push(JSON.parse(String(init.body)));
                return json({ success: true });
            }
            if (path.endsWith('/auth/organizations')) {
                return json([{ ...ORG, nc_instance_id: 'nc1', nc_base_url: 'https://cloud.example', nc_admin_uid: 'boss', nc_sync_mode: 'selective_groups' }]);
            }
            return json([]);
        });
        const { hook, edit, save } = await mountForm('info');
        expect(hook.result.current.orgData?.autoApproveSSO).toBe(true);
        expect(hook.result.current.orgData?.nc).toEqual({ instanceId: 'nc1', baseUrl: 'https://cloud.example', adminUid: 'boss', syncMode: 'selective_groups' });
        // Neither is a field of a row: a save sends the edited field only.
        edit({ name: 'Acme BV' });
        await save();
        expect(puts).toEqual([{ name: 'Acme BV' }]);
    });

    it('has no Nextcloud binding for an organisation without one', async () => {
        const { hook } = await mountForm('info');
        expect(hook.result.current.orgData?.nc).toBeNull();
    });
});
