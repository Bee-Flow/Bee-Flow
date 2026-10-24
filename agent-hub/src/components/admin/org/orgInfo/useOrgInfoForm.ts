import { useCallback, useEffect, useRef, useState, useEffectEvent } from 'react';
import type { ChangeEvent, Dispatch, SetStateAction } from 'react';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { logger } from '../../../../utils/logger';
import { mutate, ApiError, errorBody, RefusedError } from '../../../../api/mutate';

/** The organisation's editable fields; every one is sent on save. */
interface OrgFormFields {
    name: string;
    description: string;
    tagline: string;
    address: string;
    billingLine2: string;
    billingPostalCode: string;
    billingCity: string;
    billingCountry: string;
    email: string;
    phone: string;
    website: string;
    kvk: string;
    vat: string;
    logo: string;
    footerText: string;
    defaultGroups: string[];
    allowSignup: boolean;
    authMethod: string | null;
    autoApproveSSO: boolean;
    usagePooled: boolean;
    allowedDomains: string[];
}

/** The organisation form as this page edits it. */
export interface OrgFormData extends OrgFormFields {
    id: string;
}

/** One row of GET /auth/organizations, as far as the form reads it. */
type OrgRow = Partial<OrgFormFields> & { id: string };

interface GroupRow {
    id: string;
    organizationId?: string | null;
}

export interface OrgInfoUser {
    organizationId?: string | null;
    /** Group ids. */
    groups?: string[];
    role?: string;
    [key: string]: unknown;
}

export interface FormMessage {
    type: 'success' | 'error';
    text: string;
}

/** What the parent's shared save bar needs to drive this form. */
export interface OrgInfoSaveState {
    hasChanges: boolean;
    saving: boolean;
    message: FormMessage | null;
    handleSave: () => Promise<void>;
}

export interface OrgInfoForm {
    loading: boolean;
    saving: boolean;
    orgData: OrgFormData | null;
    setOrgData: Dispatch<SetStateAction<OrgFormData | null>>;
    /** The sign-in method as STORED: it locks once saved. */
    isAuthLocked: boolean;
    handleLogoUpload: (e: ChangeEvent<HTMLInputElement>) => Promise<void>;
    handleLogoRemove: () => Promise<void>;
}

interface UseOrgInfoFormOptions {
    user: OrgInfoUser | null | undefined;
    t: TranslateFn;
    onSave?: () => void;
    onStateChange?: (state: OrgInfoSaveState) => void;
}

/** The form's starting values from the stored row. */
function toFormData(myOrg: OrgRow): OrgFormData {
    return {
        id: myOrg.id,
        name: myOrg.name || '',
        description: myOrg.description || '',
        tagline: myOrg.tagline || '',
        address: myOrg.address || '',
        billingLine2: myOrg.billingLine2 || '',
        billingPostalCode: myOrg.billingPostalCode || '',
        billingCity: myOrg.billingCity || '',
        billingCountry: myOrg.billingCountry || '',
        email: myOrg.email || '',
        phone: myOrg.phone || '',
        website: myOrg.website || '',
        kvk: myOrg.kvk || '',
        vat: myOrg.vat || '',
        logo: myOrg.logo || '',
        footerText: myOrg.footerText || '',
        defaultGroups: myOrg.defaultGroups || [],
        allowSignup: !!myOrg.allowSignup,
        authMethod: myOrg.authMethod || null,
        autoApproveSSO: !!myOrg.autoApproveSSO,
        // Default to pooled (true) when the column is null on
        // pre-migration orgs — matches the server-side default.
        usagePooled: myOrg.usagePooled === undefined ? true : !!myOrg.usagePooled,
        allowedDomains: Array.isArray(myOrg.allowedDomains) ? myOrg.allowedDomains : [],
    };
}

/**
 * Which organisation this page is about: the user's direct assignment, then
 * the binding the server holds now, then group membership, then (for a global
 * admin) the first org.
 */
async function resolveMyOrg(orgs: OrgRow[], grps: GroupRow[], user: OrgInfoUser | null | undefined): Promise<OrgRow | null> {
    let myOrg: OrgRow | null | undefined = null;
    if (user?.organizationId) {
        myOrg = orgs.find(o => o.id === user.organizationId);
    }
    // Self-heal: the cached user prop may predate an org rename or NC-bootstrap
    // re-binding (or simply be empty for a fresh session). Always re-query
    // /auth/user when we got orgs back but couldn't match against
    // user.organizationId — the SaaS is the authority for the current binding.
    if (!myOrg) {
        try {
            const fresh = await authFetch(`${API_BASE}/auth/user`).then((r: Response) => r.ok ? r.json() : null);
            const freshOrgId = fresh?.user?.organizationId;
            if (freshOrgId) {
                myOrg = orgs.find(o => o.id === freshOrgId);
            }
        } catch (err) { logger.debug('best-effort', err); }
    }
    // Fallback: detect from group membership
    if (!myOrg) {
        const userGroups = user?.groups || [];
        const userOrgIds = new Set<string>();
        for (const gid of userGroups) {
            const g = grps.find(gr => gr.id === gid);
            if (g?.organizationId) userOrgIds.add(g.organizationId);
        }
        myOrg = orgs.find(o => userOrgIds.has(o.id));
    }
    // Final fallback for global admins: show first org
    if (!myOrg && (user?.role === 'admin')) {
        myOrg = orgs[0];
    }
    return myOrg || null;
}

/** Logo upload and removal; both endpoints store the change themselves. */
function useOrgLogo(
    orgId: string | undefined,
    t: TranslateFn,
    setOrgData: Dispatch<SetStateAction<OrgFormData | null>>,
    setMessage: Dispatch<SetStateAction<FormMessage | null>>,
    markLogoSaved: (logo: string) => void,
) {
    const handleLogoUpload = async (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        // Clear the picker so choosing the same file again (a retry) fires onChange.
        e.target.value = '';
        if (!file || !orgId) return;
        const formData = new FormData();
        formData.append('logo', file);
        try {
            let res: Response;
            try {
                res = await mutate(`${API_BASE}/auth/organizations/${orgId}/logo`, {
                method: 'POST',
                body: formData,
            });
            } catch (err) {
                if (!(err instanceof ApiError)) throw err;
                setMessage({ type: 'error', text: t('org.logo_upload_failed', 'Logo upload failed') });
                return;
            }
            const data = await res.json();
            markLogoSaved(data.logo);
            setOrgData(p => ({ ...p, logo: data.logo }) as OrgFormData);
            setMessage({ type: 'success', text: t('org.logo_uploaded', 'Logo uploaded') });
        } catch {
            setMessage({ type: 'error', text: t('org.logo_upload_failed', 'Logo upload failed') });
        }
    };

    const handleLogoRemove = async () => {
        if (!orgId) return;
        try {
            try {
                await mutate(`${API_BASE}/auth/organizations/${orgId}/logo`, { method: 'DELETE' });
            } catch (err) {
                if (!(err instanceof ApiError)) throw err;
                setMessage({ type: 'error', text: t('org.logo_remove_failed', 'Failed to remove logo') });
                return;
            }
            markLogoSaved('');
            setOrgData(p => ({ ...p, logo: '' }) as OrgFormData);
            setMessage({ type: 'success', text: t('org.logo_removed', 'Logo removed') });
        } catch {
            setMessage({ type: 'error', text: t('org.logo_remove_failed', 'Failed to remove logo') });
        }
    };

    return { handleLogoUpload, handleLogoRemove };
}

/**
 * The organisation form: load the right org, track unsaved edits against the
 * stored snapshot, save, and the logo. The parent's shared save bar is driven
 * through `onStateChange`.
 */
export default function useOrgInfoForm({ user, t, onSave: parentOnSave, onStateChange }: UseOrgInfoFormOptions): OrgInfoForm {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<FormMessage | null>(null);
    const [orgData, setOrgData] = useState<OrgFormData | null>(null);
    const [hasChanges, setHasChanges] = useState(false);
    const originalDataRef = useRef<string | null>(null);
    const orgDataRef = useRef<OrgFormData | null>(null);
    // The sign-in method as STORED. It locks once saved; a card merely picked
    // in the form is still "Selected" and can be changed until Save.
    const [savedAuthMethod, setSavedAuthMethod] = useState<string | null>(null);

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const [orgsRes, groupsRes] = await Promise.all([
                authFetch(`${API_BASE}/auth/organizations`),
                authFetch(`${API_BASE}/auth/groups`),
            ]);
            let orgs: OrgRow[] = [];
            let grps: GroupRow[] = [];
            if (orgsRes.ok) orgs = await orgsRes.json();
            if (groupsRes.ok) grps = await groupsRes.json();

            if (orgs.length > 0) {
                const myOrg = await resolveMyOrg(orgs, grps, user);
                if (!myOrg) {
                    setLoading(false);
                    return;
                }
                const data = toFormData(myOrg);
                setOrgData(data);
                setSavedAuthMethod(data.authMethod);
                originalDataRef.current = JSON.stringify(data);
                setHasChanges(false);
            }
        } catch (err) {
            console.error('Failed to fetch org data:', err);
        } finally {
            setLoading(false);
        }
    }, [user]);

    useEffect(() => { fetchData(); }, [fetchData]);

    useEffect(() => {
        // handleSave reads the form from here: the copy the parent's save bar
        // holds is only refreshed when hasChanges/saving/message change.
        orgDataRef.current = orgData;
        if (orgData && originalDataRef.current) {
            setHasChanges(JSON.stringify(orgData) !== originalDataRef.current);
        }
    }, [orgData]);

    useEffect(() => {
        if (message) {
            const timer = setTimeout(() => setMessage(null), 3000);
            return () => clearTimeout(timer);
        }
    }, [message]);

    const handleSave = async () => {
        const current = orgDataRef.current;
        if (!current?.id) return;
        setSaving(true);
        try {
            // The id is the URL; the route refuses any key it does not update ("Unsupported field(s): id").
            const { id, ...fields } = current;
            let res: Response | undefined;
            try {
                res = await mutate(`${API_BASE}/auth/organizations/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fields),
            });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const data = errorBody(err) ?? {};
                setMessage({ type: 'error', text: data.error || t('common.save_failed', 'Save failed') });
            }
            if (res) {
                setMessage({ type: 'success', text: t('common.saved', 'Saved') });
                originalDataRef.current = JSON.stringify(current);
                setSavedAuthMethod(current.authMethod);
                // The sign-in method is set once: the server keeps the one it
                // stored, so the form shows that one rather than a later pick.
                if (current.authMethod) {
                    setOrgData(p => (p && p.authMethod !== current.authMethod ? { ...p, authMethod: current.authMethod } : p));
                }
                // An edit made while the PUT was in flight is still unsaved.
                setHasChanges(JSON.stringify(orgDataRef.current) !== originalDataRef.current);
                if (parentOnSave) parentOnSave();
            }
        } catch {
            setMessage({ type: 'error', text: t('error.network', 'Network error. Please check your connection.') });
        } finally {
            setSaving(false);
        }
    };

    // Notify parent of save state
    const notifyParent = useEffectEvent(() => {
        if (onStateChange) onStateChange({ hasChanges, saving, message, handleSave });
    });
    useEffect(() => { return notifyParent(); }, [hasChanges, saving, message]);

    // The logo endpoints store the change themselves, so the saved snapshot
    // takes the new logo too — otherwise the bar would call an upload that
    // already happened an unsaved change.
    const markLogoSaved = (logo: string) => {
        if (!originalDataRef.current) return;
        originalDataRef.current = JSON.stringify({ ...JSON.parse(originalDataRef.current), logo });
    };
    const logo = useOrgLogo(orgData?.id, t, setOrgData, setMessage, markLogoSaved);

    return { loading, saving, orgData, setOrgData, isAuthLocked: !!savedAuthMethod, ...logo };
}
