import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import { API_BASE } from '@/utils/helpers';
import { settled } from '@/api/settled';
import type { AdminMessage, AdminOrganization, AskConfirm, OrgFormData } from './types';
import { mutate, ApiError } from '@/api/mutate';

const EMPTY_ORG: OrgFormData = {
    id: '', name: '', description: '', tagline: '', address: '', email: '', phone: '', website: '',
    kvk: '', vat: '', logo: '', footerText: '', defaultGroups: [], allowSignup: false,
};

export interface OrgActions {
    orgData: OrgFormData;
    setOrgData: Dispatch<SetStateAction<OrgFormData>>;
    showAddOrg: boolean;
    showEditOrg: boolean;
    openAddOrg: () => void;
    openEditOrg: (org: AdminOrganization) => void;
    closeOrgModal: () => void;
    handleAddOrg: () => Promise<void>;
    handleUpdateOrg: () => Promise<void>;
    handleDeleteOrg: (orgId: string) => void;
    handleRemoveNcBinding: (org: AdminOrganization) => void;
    /** Logo writes from the Organisation modal (add/edit) — a not-yet-created
     * org only gets a local preview, held in `_logoFile` until the org exists. */
    handleOrgLogoUpload: (file: File) => Promise<void>;
    handleOrgLogoRemove: () => Promise<void>;
    /** Logo writes from the My Organization tab — the org always exists there. */
    handleMyOrgLogoUpload: (file: File) => Promise<void>;
    handleMyOrgLogoRemove: () => Promise<void>;
}

export interface UseOrgActionsOptions {
    loadData: () => Promise<void>;
    setMessage: Dispatch<SetStateAction<AdminMessage | null>>;
    askConfirm: AskConfirm;
    t: TranslateFn;
    /** Which tab is showing, and the caller's own organisation — both drive
     * the my-organization form seed below. */
    activeSection: string;
    myOrg?: AdminOrganization;
}

export default function useOrgActions({ loadData, setMessage, askConfirm, t, activeSection, myOrg }: UseOrgActionsOptions): OrgActions {
    const [showAddOrg, setShowAddOrg] = useState(false);
    const [showEditOrg, setShowEditOrg] = useState(false);
    const [orgData, setOrgData] = useState<OrgFormData>(EMPTY_ORG);

    const closeOrgModal = () => { setShowAddOrg(false); setShowEditOrg(false); };

    // Seed the org form when the my-organization section opens. This used to run
    // as a `setTimeout(..., 0)` from inside the render path, so it re-fired on
    // every render until the state landed.
    if (activeSection === 'my-organization' && myOrg && orgData.id !== myOrg.id) {
        setOrgData({
            id: myOrg.id,
            name: myOrg.name || '',
            description: myOrg.description || '',
            tagline: myOrg.tagline || '',
            address: myOrg.address || '',
            email: myOrg.email || '',
            phone: myOrg.phone || '',
            website: myOrg.website || '',
            kvk: myOrg.kvk || '',
            vat: myOrg.vat || '',
            logo: myOrg.logo || '',
            footerText: myOrg.footerText || '',
            defaultGroups: myOrg.defaultGroups || [],
            allowSignup: !!myOrg.allowSignup,
        });
    }

    const openAddOrg = () => {
        setOrgData(EMPTY_ORG);
        setShowAddOrg(true);
    };

    const openEditOrg = (org: AdminOrganization) => {
        const rawIntegrations = org.enabledIntegrations as string | string[] | undefined | null;
        const parsedIntegrations = rawIntegrations
            ? (typeof rawIntegrations === 'string' ? JSON.parse(rawIntegrations) : rawIntegrations)
            : null;
        setOrgData({
            id: org.id, name: org.name || '', description: org.description || '', tagline: org.tagline || '',
            address: org.address || '', email: org.email || '', phone: org.phone || '', website: org.website || '',
            kvk: org.kvk || '', vat: org.vat || '', logo: org.logo || '', footerText: org.footerText || '',
            defaultGroups: org.defaultGroups || [], allowSignup: !!org.allowSignup, enabledIntegrations: parsedIntegrations,
        });
        setShowEditOrg(true);
    };

    const handleAddOrg = async () => {
        if (!orgData.name) return;
        try {
            // POST /auth/organizations refuses unknown keys: the id is minted from
            // the name on the server and the integrations come from the global default.
            const { id: _id, enabledIntegrations: _integrations, ...body } = orgData;
            const res = await settled(`${API_BASE}/auth/organizations`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.ok) {
                setMessage({ type: 'success', text: 'Organization created successfully' });
                setShowAddOrg(false);
                loadData();
            } else {
                const data = res.body;
                setMessage({ type: 'error', text: data.error || 'Failed to create organization' });
            }
        } catch (err) { setMessage({ type: 'error', text: 'Connection error' }); }
    };

    const handleUpdateOrg = async () => {
        try {
            // The id travels in the URL; the update route refuses it as a body key.
            const { id, ...body } = orgData;
            const res = await settled(`${API_BASE}/auth/organizations/${id}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.ok) {
                setMessage({ type: 'success', text: 'Organization updated successfully' });
                setShowEditOrg(false);
                loadData();
            } else {
                const data = res.body;
                setMessage({ type: 'error', text: data.error || 'Failed to update organization' });
            }
        } catch (err) { setMessage({ type: 'error', text: 'Connection error' }); }
    };

    const handleDeleteOrg = (orgId: string) => {
        askConfirm({
            title: t('admin.sec_delete_org_title', 'Delete this organisation?'),
            description: t('admin.sec_delete_org_desc', 'Its groups and settings go with it. Members keep their accounts but lose access to everything scoped to this organisation.'),
            confirmLabel: t('admin.sec_delete', 'Delete'),
            destructive: true,
            onConfirm: () => doDeleteOrg(orgId),
        });
    };

    const doDeleteOrg = async (orgId: string) => {
        try {
            const res = await settled(`${API_BASE}/auth/organizations/${orgId}`, { method: 'DELETE' });
            if (res.ok) { setMessage({ type: 'success', text: 'Organization deleted' }); loadData(); }
            else { const d = res.body; setMessage({ type: 'error', text: d.error || 'Failed' }); }
        } catch (err) { setMessage({ type: 'error', text: 'Connection error' }); }
    };

    const handleRemoveNcBinding = (org: AdminOrganization) => {
        askConfirm({
            title: t('admin.sec_nc_unlink_title', 'Disconnect this Nextcloud instance?'),
            description: t('admin.org_nc_remove_confirm', { name: org.name }),
            confirmLabel: t('admin.sec_nc_unlink_confirm', 'Disconnect'),
            destructive: true,
            onConfirm: () => doRemoveNcBinding(org),
        });
    };

    const doRemoveNcBinding = async (org: AdminOrganization) => {
        try {
            const res = await settled(`${API_BASE}/auth/admin/nc-bindings/org/${org.id}`, { method: 'DELETE' });
            if (res.ok) { setMessage({ type: 'success', text: t('admin.org_nc_remove_success') }); loadData(); }
            else { const d = res.body; setMessage({ type: 'error', text: d.error || t('admin.org_nc_remove_error') }); }
        } catch (err) { setMessage({ type: 'error', text: 'Connection error' }); }
    };

    const handleOrgLogoUpload = async (file: File) => {
        if (!orgData.id && !showEditOrg) {
            // Preview locally for new orgs
            const reader = new FileReader();
            reader.onload = (ev) => setOrgData(p => ({ ...p, logo: String(ev.target?.result || ''), _logoFile: file }));
            reader.readAsDataURL(file);
            return;
        }
        const formData = new FormData();
        formData.append('logo', file);
        try {
            const res = await mutate(`${API_BASE}/auth/organizations/${orgData.id}/logo`, { method: 'POST', body: formData }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
                const data = await res.json();
                setOrgData(p => ({ ...p, logo: data.logo }));
                setMessage({ type: 'success', text: 'Logo uploaded' });
            }
        } catch (err) { setMessage({ type: 'error', text: 'Upload failed' }); }
    };

    const handleOrgLogoRemove = async () => {
        if (orgData.id) {
            await settled(`${API_BASE}/auth/organizations/${orgData.id}/logo`, { method: 'DELETE' }, 'empty');
        }
        setOrgData(p => ({ ...p, logo: '', _logoFile: null }));
    };

    const handleMyOrgLogoUpload = async (file: File) => {
        if (!orgData.id) return;
        const formData = new FormData();
        formData.append('logo', file);
        try {
            const res = await mutate(`${API_BASE}/auth/organizations/${orgData.id}/logo`, { method: 'POST', body: formData }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
                const data = await res.json();
                setOrgData(p => ({ ...p, logo: data.logo }));
                setMessage({ type: 'success', text: 'Logo uploaded' });
            }
        } catch (err) { setMessage({ type: 'error', text: 'Upload failed' }); }
    };

    const handleMyOrgLogoRemove = async () => {
        if (orgData.id) {
            await settled(`${API_BASE}/auth/organizations/${orgData.id}/logo`, { method: 'DELETE' }, 'empty');
        }
        setOrgData(p => ({ ...p, logo: '' }));
    };

    return {
        orgData, setOrgData,
        showAddOrg, showEditOrg,
        openAddOrg, openEditOrg, closeOrgModal,
        handleAddOrg, handleUpdateOrg, handleDeleteOrg, handleRemoveNcBinding,
        handleOrgLogoUpload, handleOrgLogoRemove,
        handleMyOrgLogoUpload, handleMyOrgLogoRemove,
    };
}
