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
import { Lock, ShieldCheck, ShieldOff, KeyRound, AlertTriangle } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useOrgSettingRead } from '@/components/admin/org/useOrgSettingRead';

import EncryptExistingData from './EncryptExistingData';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { messageOf } from '@/utils/caughtError';
import ChoiceCards from '@/components/shared/ChoiceCards';
import type { ChoiceCardOption } from '@/components/shared/ChoiceCards';
import { toast } from '@/components/shared/Toast';
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
            await refetch();
        },
        onError: (err) => toast.error(messageOf(err, t('admin.encryption.save_failed', 'Could not save encryption settings'))),
    });
    const handleSave = () => { if (server && isDirty) save.mutate(); };
    return { server, loading, loadError, tier, setTier, isDirty, saving: save.isPending, handleSave };
}

export default function OrgEncryptionEditor({ orgId }: { orgId: string }) {
    const { t } = useTranslation();
    const { server, loading, loadError, tier, setTier, isDirty, saving, handleSave } = useEncryptionForm(orgId, t);

    // Note: this component owns its save bar rather than reporting up through
    // the shell's onStateChange — OrgInfoPanel already drives that for the org
    // form, and two writers would overwrite each other's state.

    const options = useMemo(() => tierChoiceOptions(server, t), [server, t]);

    if (loading) {
        return <div className="p-4 text-sm opacity-70">{t('common.loading', 'Loading…')}</div>;
    }

    if (loadError) {
        return (
            <div className="p-4">
                <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
                    <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
                    {t('admin.encryption.load_failed', 'Could not load encryption settings.')} {loadError}
                </div>
            </div>
        );
    }

    const selected = (server?.tierOptions || []).find(o => o.tier === tier);

    return (
        <div className="space-y-5 p-1">
            <header>
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                    <Lock className="h-5 w-5" aria-hidden="true" />
                    {t('admin.encryption.title', 'Encryption')}
                </h2>
                <p className="mt-1 text-sm opacity-75">
                    {t(
                        'admin.encryption.intro',
                        'Choose how your organisation’s conversation content is stored. This affects new messages; existing messages are left exactly as they are and stay readable either way.',
                    )}
                </p>
            </header>

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
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
                    <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
                    {selected.warningReason}
                </div>
            )}

            {/* Switching into zk signs everyone out — say so before they save. */}
            {isDirty && tier === 'zk' && (
                <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
                    <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
                    {t(
                        'admin.encryption.warn_zk_signout',
                        'Saving this will sign out everyone in the organisation, including you. Each person must sign in again so their encryption key can be created. Data can no longer be recovered by an administrator.',
                    )}
                </div>
            )}

            {(server?.tier === 'managed' || server?.tier === 'zk') && (
                <EncryptExistingData orgId={orgId} dirty={isDirty} />
            )}

            <div className="flex items-center gap-3 border-t border-black/10 pt-4 dark:border-white/10">
                <button
                    type="button"
                    onClick={handleSave}
                    disabled={!isDirty || saving}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 hover:bg-blue-700"
                >
                    {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
                </button>
                {isDirty && server && (
                    <button
                        type="button"
                        onClick={() => setTier(server.tier)}
                        disabled={saving}
                        className="text-sm underline opacity-75 hover:opacity-100"
                    >
                        {t('common.cancel', 'Cancel')}
                    </button>
                )}
            </div>
        </div>
    );
}
