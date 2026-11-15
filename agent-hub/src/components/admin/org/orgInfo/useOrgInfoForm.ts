import { useCallback, useEffect, useRef, useState, useEffectEvent } from 'react';
import type { ChangeEvent, Dispatch, SetStateAction } from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import { logger } from '@/utils/logger';
import { ApiError, errorBody, RefusedError } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';
import { useOrgFormReads } from '@/api/queries/orgInfoForm';
import { changedOrgFields, orgFormRowFields, orgFormSaveBody, toFormData } from './orgInfoFormRows';
import type { OrgFormData, OrgRow } from './orgInfoFormRows';

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
    handleLogoUpload: (e: ChangeEvent<HTMLInputElement>) => Promise<void>;
    handleLogoRemove: () => Promise<void>;
}

interface UseOrgInfoFormOptions {
    user: OrgInfoUser | null | undefined;
    /**
     * The organisation to edit (the admin dashboard's). Left out, the page
     * resolves the user's own organisation (resolveMyOrg); named, exactly that
     * one, or none when it is not in the list: never another one in its place.
     */
    orgId?: string | null;
    /**
     * The row being edited (OrgInfoPanel's activeSection: 'info', 'auth',
     * 'license', or 'image-limits' for the Models page's card). Its fields are
     * the only ones a save sends and the only ones the save bar calls unsaved.
     * Left out, every field of the form counts.
     */
    section?: string;
    t: TranslateFn;
    onSave?: () => void;
    onStateChange?: (state: OrgInfoSaveState) => void;
}

/**
 * Which organisation this page is about: the user's direct assignment, then
 * the binding the server holds now, then group membership, then (for a global
 * admin) the first org.
 */
async function resolveMyOrg(orgs: OrgRow[], grps: GroupRow[], user: OrgInfoUser | null | undefined, readCurrentOrgId: () => Promise<string | null>): Promise<OrgRow | null> {
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
            const freshOrgId = await readCurrentOrgId();
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
                res = await apiRequest('POST /auth/organizations/{id}/logo', { params: { id: orgId }, init: { body: formData } });
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
                await apiRequest('DELETE /auth/organizations/{id}/logo', { params: { id: orgId } });
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
 * The organisation form: load the right org, track unsaved edits of the row
 * being edited against the stored snapshot, save that row, and the logo. The
 * parent's shared save bar is driven through `onStateChange`.
 */
export default function useOrgInfoForm({ user, orgId, section, t, onSave: parentOnSave, onStateChange }: UseOrgInfoFormOptions): OrgInfoForm {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<FormMessage | null>(null);
    const [orgData, setOrgData] = useState<OrgFormData | null>(null);
    // The organisation as stored: what an unsaved edit is measured against.
    const [saved, setSaved] = useState<OrgFormData | null>(null);
    const rowFields = orgFormRowFields(section);
    // handleSave reads the form, the snapshot and the row from these: the copy
    // the parent's save bar holds is only refreshed when hasChanges/saving/
    // message change, which a switch between two dirty rows does not do.
    const orgDataRef = useRef<OrgFormData | null>(null);
    const savedRef = useRef<OrgFormData | null>(null);
    const rowFieldsRef = useRef(rowFields);
    useEffect(() => {
        orgDataRef.current = orgData;
        rowFieldsRef.current = rowFields;
    });
    const storeSaved = (next: OrgFormData | null) => {
        savedRef.current = next;
        setSaved(next);
    };

    const { readOrgsAndGroups, readCurrentOrgId } = useOrgFormReads<OrgRow, GroupRow>();
    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const { orgs, groups: grps } = await readOrgsAndGroups();

            if (orgs.length > 0) {
                const myOrg = orgId === undefined
                    ? await resolveMyOrg(orgs, grps, user, readCurrentOrgId)
                    : orgs.find(o => o.id === orgId) ?? null;
                if (!myOrg) {
                    setLoading(false);
                    return;
                }
                const data = toFormData(myOrg);
                orgDataRef.current = data;
                setOrgData(data);
                savedRef.current = data;
                setSaved(data);
            }
        } catch (err) {
            console.error('Failed to fetch org data:', err);
        } finally {
            setLoading(false);
        }
    }, [user, orgId, readOrgsAndGroups, readCurrentOrgId]);

    useEffect(() => { fetchData(); }, [fetchData]);

    const hasChanges = !!orgData && !!saved && changedOrgFields(orgData, saved, rowFields).length > 0;

    useEffect(() => {
        if (message) {
            const timer = setTimeout(() => setMessage(null), 3000);
            return () => clearTimeout(timer);
        }
    }, [message]);

    const handleSave = async () => {
        const current = orgDataRef.current;
        const stored = savedRef.current;
        if (!current?.id || !stored) return;
        // Only this row's fields, and of those only the ones that changed: a
        // field another screen saved since this one loaded is never sent back.
        const changed = changedOrgFields(current, stored, rowFieldsRef.current);
        if (changed.length === 0) return;
        // The image limits go out as whole numbers (or null); a text that is not one stops the save.
        const body = orgFormSaveBody(current, changed);
        if (!body) {
            setMessage({ type: 'error', text: t('image_limits.invalid', 'An image limit is a whole number from 0 to 1,000,000, or empty.') });
            return;
        }
        setSaving(true);
        try {
            let res: Response | undefined;
            try {
                // The id is the URL; the route refuses any key it does not update ("Unsupported field(s): id").
                res = await apiRequest('PUT /auth/organizations/{id}', { params: { id: current.id }, body });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const data = errorBody(err) ?? {};
                setMessage({ type: 'error', text: data.error || t('common.save_failed', 'Save failed') });
            }
            if (res) {
                setMessage({ type: 'success', text: t('common.saved', 'Saved') });
                // The sent fields are stored now; an edit made while the PUT
                // was in flight, or on another row, is still unsaved.
                const sent = Object.fromEntries(changed.map(f => [f, current[f]]));
                storeSaved({ ...(savedRef.current ?? stored), ...sent });
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
    // takes the new logo too.
    const markLogoSaved = (logo: string) => {
        if (savedRef.current) storeSaved({ ...savedRef.current, logo });
    };
    const logo = useOrgLogo(orgData?.id, t, setOrgData, setMessage, markLogoSaved);

    return { loading, saving, orgData, setOrgData, ...logo };
}
