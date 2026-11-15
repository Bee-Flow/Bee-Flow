/**
 * Organisation encryption settings — the org admin picks the tier.
 *
 * Two things the server tells us that this screen must respect:
 *
 *   • `tierOptions[].selectable` + `blockedBy` — a tier can be blocked for two
 *     very different reasons, and they need different copy. `entitlement` is a
 *     billing answer (show an upgrade link); `readiness` is a configuration
 *     answer (show an ops note — an upgrade would not fix it).
 *
 *   • Locked tiers are still RENDERED, disabled, with the reason underneath.
 *     Hiding them is the failure mode called out in the Privacy Shield's
 *     ProcessingTab: the admin cannot tell the difference between "this product
 *     has no such option" and "your plan does not include it".
 *
 * `scope` (per-surface toggles) is deliberately absent — the server only
 * accepts it from a super-admin, so offering the control here would mean a
 * save that 403s.
 */
import { ShieldCheck, ShieldOff, KeyRound, AlertTriangle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useOrgSettingRead } from '@/components/admin/org/useOrgSettingRead';

import EncryptExistingData from './EncryptExistingData';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { messageOf } from '@/utils/caughtError';
import ChoiceCards from '@/components/shared/ChoiceCards';
import type { ChoiceCardOption } from '@/components/shared/ChoiceCards';
import { toast } from '@/components/shared/Toast';
import SaveFooter from '@/components/shared/SaveFooter';
import { ALERT_ERROR, ALERT_WARNING } from '@/components/shared/adminUi';
import { errorBody, RefusedError } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';

type EncryptionTier = 'none' | 'managed' | 'zk';

/** One entry of `tierOptions` (server stores/encryptionAvailability.js). */
interface TierOption {
    tier: EncryptionTier;
    selectable: boolean;
    /** Why the tier is blocked; null when selectable. */
    reason?: string | null;
    /** 'entitlement' (billing), 'readiness' (configuration) or null. */
    blockedBy?: string | null;
    /** Advisory, not a blocker. */
    warningReason?: string | null;
}

/** GET /auth/organizations/:id/encryption — the fields this screen reads. */
interface EncryptionSettings {
    tier: EncryptionTier;
    entitled?: boolean;
    tierOptions?: TierOption[];
}

const TIER_ICON = { none: ShieldOff, managed: ShieldCheck, zk: KeyRound };

/** The tier cards: label and description per tier, a locked tier disabled with its reason (and the upgrade link when it is the plan). */
function tierChoiceOptions(server: EncryptionSettings | null, t: TranslateFn) {
    const meta: Record<string, { label: string; description?: string }> = {
        none: {
            label: t('admin.encryption.tier_none', 'Off'),
            description: t('admin.encryption.tier_none_desc', 'Messages are stored without content encryption.'),
        },
        managed: {
            label: t('admin.encryption.tier_managed', 'Managed'),
            description: t(
                'admin.encryption.tier_managed_desc',
                'Encrypted at rest. Your administrators can reset a password without the user losing their data.',
            ),
        },
        zk: {
            label: t('admin.encryption.tier_zk', 'Zero-knowledge'),
            description: t(
                'admin.encryption.tier_zk_desc',
                'Encrypted with each user’s own secret. Nobody — not your administrators, not Bee Flow support — can recover a user’s data if they lose their password and recovery key.',
            ),
        },
    };

    return (server?.tierOptions || []).map((opt): ChoiceCardOption<EncryptionTier> => {
        const m = meta[opt.tier] || { label: opt.tier };
        const blockedByPlan = opt.blockedBy === 'entitlement';
        return {
            value: opt.tier,
            label: m.label,
            description: m.description,
            Icon: TIER_ICON[opt.tier],
            disabled: !opt.selectable,
            badge: blockedByPlan ? t('license.enterprise', 'Enterprise') : undefined,
            lockedNotice: !opt.selectable ? (
                <>
                    {opt.reason}
                    {blockedByPlan && (
                        <>
                            {' '}
                            <a
                                href="https://beeflow.nl/pricing"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline"
                            >
                                {t('license.upgrade_at_beeflow', 'Upgrade at beeflow.nl')}
                            </a>
                        </>
                    )}
                </>
            ) : undefined,
        };
    });
}

/** The loaded settings, the tier picked from them, and the save. */
function useEncryptionForm(orgId: string, t: TranslateFn) {
    const { server, loading, loadError, refetch } = useOrgSettingRead<EncryptionSettings>('GET /auth/organizations/{id}/encryption', orgId);
    const [tier, setTier] = useState<EncryptionTier | null>(null);       // current selection
    const [seeded, setSeeded] = useState<EncryptionSettings | null>(null);
    if (server && server !== seeded) {
        setSeeded(server);
        setTier(server.tier);
    }
    const isDirty = !!server && tier !== server.tier;
    const [savedAt, setSavedAt] = useState<Date | null>(null);
    const [saveFailed, setSaveFailed] = useState(false);

    const save = useMutation({
        mutationFn: async () => {
            try {
                const res = await apiRequest('PUT /auth/organizations/{id}/encryption', { params: { id: orgId }, body: { tier: tier as EncryptionTier } });
                return { refused: null as string | null, body: await res.json().catch(() => ({})) };
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const body = errorBody(err) ?? {};
                return { refused: (body.message || body.error || '') as string, body: {} };
            }
        },
        onSuccess: async ({ refused, body }) => {
            if (refused !== null) {
                setSaveFailed(true);
                toast.error(refused || t('admin.encryption.save_failed', 'Could not save encryption settings'));
                return;
            }
            if (body.sessionsBusted) {
                // Everyone, including the admin doing this, has to sign in again.
                toast.info(t(
                    'admin.encryption.sessions_busted',
                    'Everyone in this organisation has been signed out. Each person must sign in again so their encryption key can be created.',
                ));
            } else {
                toast.success(t('admin.encryption.saved', 'Encryption settings saved'));
            }
            setSaveFailed(false);
            setSavedAt(new Date());
            await refetch();
        },
        onError: (err) => {
            setSaveFailed(true);
            toast.error(messageOf(err, t('admin.encryption.save_failed', 'Could not save encryption settings')));
        },
    });
    const handleSave = () => { if (server && isDirty) save.mutate(); };
    return { server, loading, loadError, tier, setTier, isDirty, saving: save.isPending, savedAt, saveFailed, handleSave };
}

export default function OrgEncryptionEditor({ orgId }: { orgId: string }) {
    const { t } = useTranslation();
    const { server, loading, loadError, tier, setTier, isDirty, saving, savedAt, saveFailed, handleSave } = useEncryptionForm(orgId, t);

    // Note: this component owns its save bar rather than reporting up through
    // the shell's onStateChange — OrgInfoPanel already drives that for the org
    // form, and two writers would overwrite each other's state.

    const options = useMemo(() => tierChoiceOptions(server, t), [server, t]);

    if (loading) {
        return <div className="text-sm text-[var(--text-muted)]">{t('common.loading', 'Loading…')}</div>;
    }

    if (loadError) {
        return (
            <div className={ALERT_ERROR} role="alert">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{t('admin.encryption.load_failed', 'Could not load encryption settings.')} {loadError}</span>
            </div>
        );
    }

    const selected = (server?.tierOptions || []).find(o => o.tier === tier);

    return (
        <div className="space-y-5">
            {/* The page title is the dashboard frame's (AdminPage); this is the tier block's own heading. */}
            <div>
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                    {t('admin.encryption.choose_tier', 'Encryption level')}
                </h3>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">
                    {t(
                        'admin.encryption.intro',
                        'Choose how your organisation’s conversation content is stored. This affects new messages; existing messages are left exactly as they are and stay readable either way.',
                    )}
                </p>
            </div>

            <ChoiceCards
                value={tier}
                onChange={setTier}
                options={options}
                columns={1}
                ariaLabel={t('admin.encryption.choose_tier', 'Encryption level')}
                disabled={saving}
            />

            {/* Advisory, not a blocker — e.g. OPAQUE not configured for zk. */}
            {selected?.warningReason && (
                <div className={ALERT_WARNING}>
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{selected.warningReason}</span>
                </div>
            )}

            {/* Switching into zk signs everyone out — say so before they save. */}
            {isDirty && tier === 'zk' && (
                <div className={ALERT_ERROR} role="alert">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>
                        {t(
                            'admin.encryption.warn_zk_signout',
                            'Saving this will sign out everyone in the organisation, including you. Each person must sign in again so their encryption key can be created. Data can no longer be recovered by an administrator.',
                        )}
                    </span>
                </div>
            )}

            <SaveFooter
                onSave={handleSave}
                onCancel={isDirty && server ? () => setTier(server.tier) : undefined}
                saving={saving}
                dirty={isDirty}
                saveState={saving ? 'saving' : saveFailed ? 'error' : savedAt ? 'saved' : 'idle'}
                lastSavedAt={savedAt}
                onRetry={handleSave}
            />

            {/* Below the tier's own save: the backfill acts on the SAVED tier. */}
            {(server?.tier === 'managed' || server?.tier === 'zk') && (
                <EncryptExistingData orgId={orgId} dirty={isDirty} />
            )}
        </div>
    );
}
