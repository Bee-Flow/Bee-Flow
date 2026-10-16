import { useEffect, useState } from 'react';
import type { SetStateAction } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { toast } from '../../../shared/Toast';
import useConfirm from '../../../shared/useConfirm';
import { apiJson } from '../hooks/useApi';
import { messageOf } from '../../../../utils/caughtError';

export type GeoMode = 'off' | 'allowlist' | 'blocklist';

/** What PUT /auth/admin/signup-settings stores. */
export interface SignupSettings {
    allowOrgSignups: boolean;
    allowConsumerSignups: boolean;
    waitlistEnabled: boolean;
    emailVerificationEnabled: boolean;
    requireMfaForPasswordAccounts: boolean;
    consumerLoginMethods: string[];
    connectorOnly: boolean;
    geoMode: GeoMode;
    geoCountries: string[];
    geoBlockUnknown: boolean;
    geoApplyConnector: boolean;
}

/** Read-only facts the server reports next to the settings. */
export interface SignupEnvironment {
    /** Service Email has a sender, so email verification can be enforced. */
    serviceEmailConfigured: boolean;
    /** ALLOW_SIGNUPS is not forcing signups off for the whole deployment. */
    allowSignupsEnv: boolean;
}

export interface WaitlistUser {
    id: string;
    username?: string;
    displayName?: string;
    email?: string;
    createdAt?: string;
}

export type UpdateSetting = <K extends keyof SignupSettings>(key: K, value: SetStateAction<SignupSettings[K]>) => void;

const DEFAULTS: SignupSettings = {
    allowOrgSignups: true,
    allowConsumerSignups: true,
    waitlistEnabled: false,
    emailVerificationEnabled: false,
    requireMfaForPasswordAccounts: true,
    consumerLoginMethods: ['password', 'google', 'microsoft'],
    connectorOnly: false,
    geoMode: 'off',
    geoCountries: [],
    geoBlockUnknown: false,
    geoApplyConnector: true,
};

type SettingsResponse = Partial<SignupSettings> & Partial<SignupEnvironment> & { geoMode?: string };

/** The stored settings over the defaults, read the way the server means them (absent = on where noted). */
function fromResponse(data: SettingsResponse, prev: SignupSettings): SignupSettings {
    return {
        allowOrgSignups: data.allowOrgSignups !== false,
        allowConsumerSignups: data.allowConsumerSignups !== false,
        waitlistEnabled: !!data.waitlistEnabled,
        emailVerificationEnabled: !!data.emailVerificationEnabled,
        requireMfaForPasswordAccounts: data.requireMfaForPasswordAccounts !== false,
        consumerLoginMethods: Array.isArray(data.consumerLoginMethods) ? data.consumerLoginMethods : prev.consumerLoginMethods,
        connectorOnly: !!data.connectorOnly,
        geoMode: ['off', 'allowlist', 'blocklist'].includes(data.geoMode as string) ? data.geoMode as GeoMode : prev.geoMode,
        geoCountries: Array.isArray(data.geoCountries) ? data.geoCountries : prev.geoCountries,
        geoBlockUnknown: !!data.geoBlockUnknown,
        geoApplyConnector: data.geoApplyConnector !== false,
    };
}

/** Signup settings, the server's overrides on them, and the waitlist queue. */
export default function useSignupSettings() {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [settings, setSettings] = useState<SignupSettings>(DEFAULTS);
    const [env, setEnv] = useState<SignupEnvironment>({ serviceEmailConfigured: true, allowSignupsEnv: true });
    const [waitlistUsers, setWaitlistUsers] = useState<WaitlistUser[]>([]);

    const update: UpdateSetting = (key, value) => setSettings(prev => ({
        ...prev,
        [key]: typeof value === 'function' ? (value as (p: SignupSettings[typeof key]) => SignupSettings[typeof key])(prev[key]) : value,
    }));

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const data: SettingsResponse = await apiJson('/auth/admin/signup-settings');
                if (!alive) return;
                setSettings(prev => fromResponse(data, prev));
                setEnv({
                    serviceEmailConfigured: data.serviceEmailConfigured !== false,
                    allowSignupsEnv: data.allowSignupsEnv !== false,
                });
            } catch (e) {
                console.warn('Failed to fetch signup settings:', e);
            } finally {
                if (alive) setLoading(false);
            }
            try {
                const list = await apiJson('/auth/admin/waitlist');
                if (alive) setWaitlistUsers(list);
            } catch (e) { /* ignore */ }
        })();
        return () => { alive = false; };
    }, []);

    const handleSave = async () => {
        setSaving(true);
        try {
            const s = settings;
            await apiJson('/auth/admin/signup-settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    allowOrgSignups: s.allowOrgSignups, allowConsumerSignups: s.allowConsumerSignups,
                    waitlistEnabled: s.waitlistEnabled, emailVerificationEnabled: s.emailVerificationEnabled,
                    requireMfaForPasswordAccounts: s.requireMfaForPasswordAccounts, consumerLoginMethods: s.consumerLoginMethods,
                    connectorOnly: s.connectorOnly, geoMode: s.geoMode, geoCountries: s.geoCountries,
                    geoBlockUnknown: s.geoBlockUnknown, geoApplyConnector: s.geoApplyConnector,
                }),
            });
            toast.success(t('admin_subscriptions.access_saved', 'Signup settings saved.'));
        } catch (e) {
            toast.error(messageOf(e, t('admin_subscriptions.access_save_failed', 'Save failed')));
        } finally {
            setSaving(false);
        }
    };

    const nameOf = (u: WaitlistUser) => u.displayName || u.username;
    const approve = async (u: WaitlistUser) => {
        try {
            await apiJson(`/auth/admin/waitlist/${u.id}/approve`, { method: 'POST' });
            setWaitlistUsers(prev => prev.filter(w => w.id !== u.id));
            toast.success(t('admin_subscriptions.access_approved', '{name} approved.', { name: nameOf(u) }));
        } catch (e) { toast.error(t('admin_subscriptions.access_approve_failed', 'Failed to approve.')); }
    };
    const reject = async (u: WaitlistUser) => {
        if (!(await confirm({ title: t('admin_subscriptions.access_reject_confirm', 'Reject and delete {name}?', { name: nameOf(u) }), confirmLabel: t('admin_subscriptions.access_reject', 'Reject'), destructive: true }))) return;
        try {
            await apiJson(`/auth/admin/waitlist/${u.id}/reject`, { method: 'POST' });
            setWaitlistUsers(prev => prev.filter(w => w.id !== u.id));
            toast.success(t('admin_subscriptions.access_rejected', '{name} rejected.', { name: nameOf(u) }));
        } catch (e) { toast.error(t('admin_subscriptions.access_reject_failed', 'Failed to reject.')); }
    };

    return { loading, saving, settings, update, env, waitlistUsers, handleSave, approve, reject, confirmDialog };
}
