/**
 * No subscription yet (OrgLicenseSection.jsx `!sub`): say so, and either
 * point at the plans on sale or — when Stripe offers none — at who to ask.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Group, ListRow, NoteRow, SettingRow } from '@/shared/ui';

export function NoSubscriptionGroup({ plansOnSale, onChoosePlan }: { plansOnSale: boolean; onChoosePlan: () => void }) {
    const t = useTranslation();
    return (
        <Group>
            <ListRow
                title={t('org.no_license', 'No license assigned')}
                subtitle={t('org.no_license_desc', 'Contact your administrator to set up a plan for your organisation.')}
                wrapTitle
            />
            {plansOnSale ? (
                <SettingRow testID="billing-choose-plan" label={t('org.choose_plan', 'Choose a Plan')} onPress={onChoosePlan} />
            ) : (
                <NoteRow>
                    {`${t('org.no_plans_configured', 'No plans are available right now.')} ${t('org.contact_for_plan', 'Reach out to')} info@beeflow.nl ${t('org.to_get_started', 'to get started.')}`}
                </NoteRow>
            )}
        </Group>
    );
}
