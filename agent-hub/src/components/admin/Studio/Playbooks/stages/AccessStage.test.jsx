import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccessStage from './AccessStage';
import { playbooksApi } from '../playbooksApi';
import { studioAppsApi } from '../../AppStudio/studioAppsApi';

/**
 * The access phase: a sentence becomes a PROPOSAL, and not one byte is written
 * until the person presses Approve (owner, 2026-09-16 — the gate is the
 * feature). The proposal comes from the server with names already resolved;
 * this stage only shows it and, on Approve, applies it.
 */
vi.mock('../playbooksApi', () => {
    const playbooksApi = { accessPlan: vi.fn(), get: vi.fn(), patch: vi.fn(), runPhase: vi.fn() };
    return { playbooksApi, default: playbooksApi };
});
vi.mock('../../AppStudio/studioAppsApi', () => ({
    studioAppsApi: {
        getApp: vi.fn(async (id) => ({ app: { id, name: 'Invoice Dashboard' } })),
        publish: vi.fn(async () => ({ success: true })),
        setNextcloudMenu: vi.fn(async () => ({ success: true, nextcloudMenu: true, ncConnected: true, ncSync: 'synced' })),
    },
}));
const saveRoles = vi.fn(async () => ({}));
const assignMember = vi.fn(async () => ({}));
vi.mock('../../AppStudio/rbac/useAppRoles', () => ({
    default: () => ({ roles: [{ key: 'viewer', label: 'Viewer' }], roleMapping: { default: 'app', byGroup: {} }, tables: [{ id: 'tbl_model01', key: 'invoices', access: { default: 'app', roles: {} } }], members: [], saveRoles, assignMember, isLoading: false }),
    useOrgDirectory: () => ({ groups: [{ id: 'g_fin', name: 'Finance' }], users: [{ id: 'u_ann', name: 'Ann Blok', email: 'ann@x.nl' }], available: true, isLoading: false }),
}));

const t = (k, f, v) => (v ? Object.entries(v).reduce((s, [a, b]) => s.replace(`{${a}}`, String(b)), f) : f);
const PB = { id: 'pb_1', title: 'Invoice Dashboard', phases: [] };
const PHASE = { key: 'access', kind: 'access', status: 'running', attempt: 0, artifacts: { appId: 'app_1' } };

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => cleanup());

const renderStage = (over = {}) => render(<AccessStage playbook={PB} phase={{ ...PHASE, ...over }} dispatch={vi.fn()} t={t} />);

describe('AccessStage — proposed, then approved', () => {
    it('a sentence becomes a proposal and NOTHING is written by it', async () => {
        playbooksApi.accessPlan.mockResolvedValue({
            plan: { audience: { kind: 'groups', groupIds: ['g_fin'], groupNames: ['Finance'] }, roles: [{ key: 'approver', label: 'Approver' }], defaultRole: null, byGroup: { g_fin: 'approver' }, members: [{ userId: 'u_ann', roleKey: 'approver', name: 'Ann Blok' }], unresolved: [{ kind: 'person', name: 'Piet' }], note: 'Finance approves.', empty: false },
        });
        renderStage();
        fireEvent.change(screen.getByTestId('playbook-access-ask'), { target: { value: 'Finance approves, Ann too' } });
        await act(async () => { fireEvent.click(screen.getByTestId('playbook-access-ask-send')); });
        await waitFor(() => expect(playbooksApi.accessPlan).toHaveBeenCalledWith('pb_1', 'access', 'Finance approves, Ann too'));

        // It is on screen, with what it could not find…
        expect(screen.getByTestId('playbook-access-note').textContent).toBe('Finance approves.');
        expect(screen.getByTestId('playbook-access-unresolved').textContent).toContain('Piet');
        // The gate lists what Approve would do, one line each — not a single
        // run-on sentence under a button that publishes an app.
        const willDo = screen.getByTestId('playbook-access-changes').textContent;
        expect(willDo).toContain('Publish it to Finance.');
        expect(willDo).toContain('Create the role "Approver"');
        // The role is NAMED, not keyed: a person consents to "Approver", never
        // to `approver`. Same for the group line.
        expect(willDo).toContain('Give Ann Blok the role "Approver"');
        expect(willDo).toContain('Give Finance the role "Approver"');
        expect(willDo).not.toContain('"approver"');
        expect(willDo).toContain('takes a copy of the app exactly as it stands');
        // …and not one write has happened.
        expect(saveRoles).not.toHaveBeenCalled();
        expect(assignMember).not.toHaveBeenCalled();
        expect(studioAppsApi.publish).not.toHaveBeenCalled();
    });

    it('Approve is what writes — roles, the person, the audience, then the phase lands', async () => {
        const dispatch = vi.fn();
        playbooksApi.accessPlan.mockResolvedValue({
            plan: { audience: { kind: 'organisation' }, roles: [{ key: 'approver', label: 'Approver' }], defaultRole: 'approver', byGroup: {}, members: [{ userId: 'u_ann', roleKey: 'approver', name: 'Ann Blok' }], unresolved: [], note: '', empty: false },
        });
        render(<AccessStage playbook={PB} phase={PHASE} dispatch={dispatch} t={t} />);
        fireEvent.change(screen.getByTestId('playbook-access-ask'), { target: { value: 'everyone, Ann approves' } });
        await act(async () => { fireEvent.click(screen.getByTestId('playbook-access-ask-send')); });
        await waitFor(() => expect(screen.getByTestId('playbook-access-approve').disabled).toBe(false));

        await act(async () => { fireEvent.click(screen.getByTestId('playbook-access-approve')); });
        await waitFor(() => expect(saveRoles).toHaveBeenCalledWith(
            [{ key: 'viewer', label: 'Viewer' }, { key: 'approver', label: 'Approver' }],
            { default: 'approver', byGroup: {} },
            undefined,
        ));
        expect(assignMember).toHaveBeenCalledWith('u_ann', 'approver');
        expect(studioAppsApi.publish).toHaveBeenCalledWith('app_1', { isPublished: true, sharedGroups: [] });
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            type: 'finished',
            key: 'access',
            summary: expect.stringContaining('Shared with the whole organisation'),
        }));
    });

    it('setting it by hand needs the same Approve', async () => {
        renderStage();
        expect(screen.getByTestId('playbook-access-approve').disabled).toBe(true);
        fireEvent.click(screen.getByTestId('playbook-access-audience-private'));
        expect(screen.getByTestId('playbook-access-approve').disabled).toBe(false);
        expect(studioAppsApi.publish).not.toHaveBeenCalled();
        await act(async () => { fireEvent.click(screen.getByTestId('playbook-access-approve')); });
        await waitFor(() => expect(studioAppsApi.publish).toHaveBeenCalledWith('app_1', { isPublished: false }));
    });

    it('Discard drops the proposal without touching anything', async () => {
        playbooksApi.accessPlan.mockResolvedValue({ plan: { audience: { kind: 'organisation' }, roles: [], byGroup: {}, members: [], unresolved: [], note: '', empty: false } });
        renderStage();
        fireEvent.change(screen.getByTestId('playbook-access-ask'), { target: { value: 'everyone' } });
        await act(async () => { fireEvent.click(screen.getByTestId('playbook-access-ask-send')); });
        await waitFor(() => expect(screen.getByTestId('playbook-access-approve').disabled).toBe(false));
        fireEvent.click(screen.getByTestId('playbook-access-discard'));
        expect(screen.getByTestId('playbook-access-approve').disabled).toBe(true);
        expect(studioAppsApi.publish).not.toHaveBeenCalled();
    });

    it('a ready phase starts once; without an app it says so', () => {
        const dispatch = vi.fn();
        const { rerender } = render(<AccessStage playbook={PB} phase={{ ...PHASE, status: 'ready' }} dispatch={dispatch} t={t} />);
        expect(dispatch).toHaveBeenCalledWith({ type: 'start', key: 'access' });
        rerender(<AccessStage playbook={PB} phase={{ ...PHASE, status: 'ready' }} dispatch={dispatch} t={t} />);
        expect(dispatch).toHaveBeenCalledTimes(1);
        cleanup();
        render(<AccessStage playbook={PB} phase={{ ...PHASE, artifacts: {} }} dispatch={vi.fn()} t={t} />);
        expect(screen.getByTestId('playbook-stage-access-missing')).toBeTruthy();
    });

    it('a role per supplier: the rule is shown before Approve, and saved ON the table with the role', async () => {
        // The ask the demo makes: "a role for each supplier, that I can assign
        // to a user or group". The assistant read the values; each role says
        // what it will see BEFORE anything is written.
        playbooksApi.accessPlan.mockResolvedValue({
            plan: {
                audience: null,
                roles: [
                    { key: 'supplier_acme', label: 'ACME', scope: { column: 'supplier', value: 'ACME' } },
                    { key: 'controller', label: 'Controller' },
                ],
                tableRules: [{ tableId: 'tbl_model01', roleKey: 'supplier_acme', expr: 'record.supplier == "ACME"' }],
                defaultRole: null, byGroup: {}, members: [], unresolved: [], note: '', empty: false,
            },
        });
        const dispatch = vi.fn();
        render(<AccessStage playbook={PB} phase={PHASE} dispatch={dispatch} t={t} />);
        fireEvent.change(screen.getByTestId('playbook-access-ask'), { target: { value: 'a role per supplier' } });
        await act(async () => { fireEvent.click(screen.getByTestId('playbook-access-ask-send')); });

        const shown = await screen.findByTestId('playbook-access-roles');
        expect(shown.textContent).toContain('sees only rows where supplier is ACME');
        expect(shown.textContent).toContain('sees every row');   // the unscoped one says so too
        expect(saveRoles).not.toHaveBeenCalled();

        await act(async () => { fireEvent.click(screen.getByTestId('playbook-access-approve')); });
        await waitFor(() => expect(saveRoles).toHaveBeenCalled());
        const [savedRoles, , savedTables] = saveRoles.mock.calls[0];
        expect(savedRoles.map((r) => r.key)).toEqual(['viewer', 'supplier_acme', 'controller']);
        expect(savedTables[0].access.rowFilters).toEqual({ supplier_acme: 'record.supplier == "ACME"' });
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            summary: expect.stringContaining('1 of them see only their own rows'),
        }));
    });

    it('the Nextcloud menu is off until it is ticked, and only offered once the app is shared', async () => {
        renderStage();
        await waitFor(() => expect(studioAppsApi.getApp).toHaveBeenCalled());
        // Nothing chosen, and "Only me": no checkbox to tick.
        expect(screen.queryByTestId('playbook-access-nc-menu')).toBeNull();
        fireEvent.click(screen.getByTestId('playbook-access-audience-private'));
        expect(screen.queryByTestId('playbook-access-nc-menu')).toBeNull();

        fireEvent.click(screen.getByTestId('playbook-access-audience-organisation'));
        const box = screen.getByTestId('playbook-access-nc-menu');
        expect(box.checked).toBe(false);          // off by default (owner, 2026-09-16)

        // Approve without ticking: published, no menu call.
        await act(async () => { fireEvent.click(screen.getByTestId('playbook-access-approve')); });
        expect(studioAppsApi.publish).toHaveBeenCalledWith('app_1', { isPublished: true, sharedGroups: [] });
        expect(studioAppsApi.setNextcloudMenu).not.toHaveBeenCalled();
    });

    it('ticking it publishes first and then asks Nextcloud, and says what Nextcloud answered', async () => {
        const dispatch = vi.fn();
        render(<AccessStage playbook={PB} phase={PHASE} dispatch={dispatch} t={t} />);
        await waitFor(() => expect(studioAppsApi.getApp).toHaveBeenCalled());
        fireEvent.click(screen.getByTestId('playbook-access-audience-organisation'));
        fireEvent.click(screen.getByTestId('playbook-access-nc-menu'));
        await act(async () => { fireEvent.click(screen.getByTestId('playbook-access-approve')); });
        expect(studioAppsApi.publish).toHaveBeenCalledWith('app_1', { isPublished: true, sharedGroups: [] });
        expect(studioAppsApi.setNextcloudMenu).toHaveBeenCalledWith('app_1', true);
        expect(screen.getByTestId('playbook-access-nc-result').textContent).toMatch(/reload Nextcloud/);
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            type: 'finished', artifacts: { appId: 'app_1', accessApplied: true, nextcloudMenu: true },
        }));
    });

    it('a publish the validator refuses says WHY, not just "audience"', async () => {
        const err = new Error('invalid');
        err.status = 422;
        err.body = { error: 'invalid', errors: ['Screen "Dashboard" has no data source', { message: 'Action "save" points at a deleted step' }] };
        studioAppsApi.publish.mockRejectedValueOnce(err);
        renderStage();
        await waitFor(() => expect(studioAppsApi.getApp).toHaveBeenCalled());
        fireEvent.click(screen.getByTestId('playbook-access-audience-organisation'));
        await act(async () => { fireEvent.click(screen.getByTestId('playbook-access-approve')); });
        const list = await screen.findByTestId('playbook-access-blockers');
        expect(list.textContent).toContain('Screen "Dashboard" has no data source');
        expect(list.textContent).toContain('Action "save" points at a deleted step');
    });

    it('says where the app stands before anything is approved', async () => {
        renderStage();
        await waitFor(() => expect(screen.getByTestId('playbook-access-publish-state').textContent).toMatch(/private draft/));
    });
});

describe('AccessStage — a screen you can read', () => {
    it('opens by saying where the app stands, not by asking you to guess', async () => {
        renderStage();
        await waitFor(() => expect(studioAppsApi.getApp).toHaveBeenCalled());
        const now = screen.getByTestId('playbook-access-now');
        expect(now.getAttribute('data-tone')).toBe('private');
        expect(screen.getByTestId('playbook-access-now-who').textContent).toBe('Only you can open it');
        expect(now.textContent).toContain('Nobody holds a named role yet');
        expect(screen.getByTestId('playbook-access-publish-state').textContent).toMatch(/private draft/);
    });

    it('the sentence box shows what it can take, so it is not a blank page', () => {
        renderStage();
        const examples = screen.getAllByText(/Finance may look at it|A role per supplier|Keep it to me/);
        expect(examples.length).toBeGreaterThan(0);
        fireEvent.click(screen.getByText('A role per supplier — each one sees only their own rows.'));
        expect(screen.getByTestId('playbook-access-ask').value).toBe('A role per supplier — each one sees only their own rows.');
    });

    it('a greyed-out Approve says why', () => {
        renderStage();
        expect(screen.getByTestId('playbook-access-approve').disabled).toBe(true);
        expect(screen.getByTestId('playbook-access-why-disabled').textContent).toMatch(/Choose who can open the app/);
        // Groups chosen but none ticked is its own dead end, and says so.
        fireEvent.click(screen.getByTestId('playbook-access-audience-groups'));
        expect(screen.getByTestId('playbook-access-why-disabled').textContent).toMatch(/Pick at least one group/);
        expect(screen.getByTestId('playbook-access-approve').disabled).toBe(true);
    });

    it('people are searchable instead of listed with an empty dropdown each', () => {
        renderStage();
        const search = screen.getByTestId('playbook-access-people-search');
        fireEvent.change(search, { target: { value: 'zzz' } });
        expect(screen.getByTestId('playbook-access-people').textContent).toContain('Nobody by that name.');
        fireEvent.change(search, { target: { value: 'ann' } });
        expect(screen.getByTestId('playbook-access-people').textContent).toContain('Ann Blok');
        // A role that is chosen says what it lets her SEE.
        fireEvent.change(screen.getAllByLabelText('Role for Ann Blok')[0], { target: { value: 'app' } });
        expect(screen.getByTestId('playbook-access-people').textContent).toContain('Can use the app');
    });

    it('group roles follow the audience — not every group in the organisation', async () => {
        playbooksApi.accessPlan.mockResolvedValue({
            plan: { audience: { kind: 'private' }, roles: [{ key: 'approver', label: 'Approver' }], byGroup: {}, members: [], unresolved: [], note: '', empty: false },
        });
        renderStage();
        fireEvent.change(screen.getByTestId('playbook-access-ask'), { target: { value: 'me only' } });
        await act(async () => { fireEvent.click(screen.getByTestId('playbook-access-ask-send')); });
        // Private: no group can open it, so there is no group role to set.
        expect(screen.queryByTestId('playbook-access-group-roles')).toBeNull();
        fireEvent.click(screen.getByTestId('playbook-access-audience-organisation'));
        expect(screen.getByTestId('playbook-access-group-roles').textContent).toContain('Finance');
    });
});
