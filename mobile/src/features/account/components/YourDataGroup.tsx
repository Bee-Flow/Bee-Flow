/**
 * Your data. Bee Flow has no one-tap "download my data" endpoint; it has a
 * GDPR request that your organisation's administrators fulfil within thirty
 * days, and pretending otherwise would be a compliance claim the product does
 * not make. Account deletion is an erasure request too — there is no
 * self-service delete. Your Privacy Shield choices are a Settings row of their
 * own, so this group does not link there.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Group, Icon, SettingRow } from '@/shared/ui';

export function YourDataGroup({ onRequest }: { onRequest: () => void }) {
    const theme = useTheme();
    const t = useTranslation();
    return (
        <Group
            title={t('mobile.account.your_data', 'Your data')}
            footer={t(
                'mobile.account.your_data_footer',
                "Your organisation's administrators handle these requests within thirty days, as the GDPR requires. There is no delete button: your organisation may have to keep some records, so deleting your account is a request too.",
            )}
        >
            <SettingRow
                label={t('mobile.account.data_request', 'Request, correct or delete my data')}
                icon={<Icon name="Download" size={16} color={theme.colors.textSecondary} />}
                onPress={onRequest}
            />
        </Group>
    );
}
