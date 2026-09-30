/**
 * Privacy Shield and compliance.
 *
 * Three layers, and the screen keeps them visibly separate because they behave
 * differently:
 *
 *   1. YOUR shield (`/api/org-privacy-shield/user/me`) — editable by you,
 *      applies to your own messages, and SECURE BY DEFAULT: `implicitDefault`
 *      marks an account that never changed it, so the UI can say "these are
 *      the defaults in force" rather than pretending you chose them.
 *   2. YOUR ORGANISATION's shield (`/api/org-privacy-shield/:orgId`) — read
 *      here, editable only in the web app, applied on top of yours.
 *   3. Compliance (`/api/dsr/requests`) — data-subject requests, visible to
 *      administrators with `admin_compliance`.
 */

import React, { useState } from 'react';

import { useHasPermission } from '@/core/access';
import { describeError } from '@/core/api/errors';
import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { useUserRefresh } from '@/shared/patterns';
import { GroupedScroll, LoadingState, Screen, ScreenHeader, Banner, useToast } from '@/shared/ui';

import { CategorySheet } from '../components/CategorySheet';
import { DataRightsGroup } from '../components/DataRightsGroup';
import { DetectionGroups } from '../components/DetectionGroups';
import { DsrRequestsGroup } from '../components/DsrRequestsGroup';
import { OrgShieldGroup } from '../components/OrgShieldGroup';
import { ShieldBanners } from '../components/ShieldBanners';
import { YourShieldGroup } from '../components/YourShieldGroup';
import { useSaveUserShield } from '../hooks/mutations';
import { useDsrRequests, useGuardStatus, useOrgShield, useUserShield } from '../hooks/queries';
import type { UserShield } from '../model/types';

export function OrgPrivacyScreen() {
    const t = useTranslation();
    const { toast } = useToast();
    const { user } = useAuth();
    const canAdminCompliance = useHasPermission('admin_compliance');
    const [categorySheet, setCategorySheet] = useState(false);

    const shield = useUserShield();
    const guard = useGuardStatus();
    const orgShield = useOrgShield(user?.organizationId ?? null);
    const dsr = useDsrRequests(canAdminCompliance);
    const save = useSaveUserShield({ onSaved: () => toast(t('mobile.org.privacy_saved', 'Privacy settings saved'), 'success') });

    const current = shield.data;
    const patch = (changes: Partial<UserShield>) => {
        if (!current) return;
        save.mutate({ ...current, ...changes });
    };

    const refresh = useUserRefresh(() => Promise.all([shield.refetch(), guard.refetch(), orgShield.refetch()]));

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader
                title={t('mobile.org.your_privacy', 'Your privacy settings')}
                subtitle={t('mobile.org.privacy_subtitle', 'What leaves your device, and what does not')}
            />

            <GroupedScroll refresh={refresh}>
                <ShieldBanners
                    saveError={save.isError ? save.error : null}
                    guard={guard.data}
                    shield={current}
                />

                {shield.isLoading ? (
                    <LoadingState label={t('mobile.org.privacy_loading', 'Reading your privacy settings')} />
                ) : shield.isError ? (
                    <Banner tone="error">{describeError(shield.error).message}</Banner>
                ) : current ? (
                    <>
                        <YourShieldGroup shield={current} onChange={patch} />
                        <DetectionGroups
                            shield={current}
                            onChange={patch}
                            onPickCategories={() => setCategorySheet(true)}
                        />
                    </>
                ) : null}

                {orgShield.data ? <OrgShieldGroup shield={orgShield.data} /> : null}
                <DataRightsGroup />
                {canAdminCompliance ? (
                    <DsrRequestsGroup requests={dsr.data} loading={dsr.isLoading} />
                ) : null}
            </GroupedScroll>

            <CategorySheet
                visible={categorySheet}
                onClose={() => setCategorySheet(false)}
                selected={current?.piiDetectionCategories ?? []}
                saving={save.isPending}
                onSave={(categories) => {
                    patch({ piiDetectionCategories: categories });
                    setCategorySheet(false);
                }}
            />
        </Screen>
    );
}
