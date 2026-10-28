/** The user's own shield switches. Everything but the master switch needs it on. */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Group, Icon, ToggleRow } from '@/shared/ui';

import type { UserShield } from '../model/types';

export function YourShieldGroup({
    shield,
    onChange,
}: {
    shield: UserShield;
    onChange: (changes: Partial<UserShield>) => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    return (
        <Group
            title={t('mobile.org.my_shield_title', 'Your shield')}
            footer={t('mobile.org.my_shield_footer', 'Applies to everything you send from any device signed in to this account.')}
        >
            <ToggleRow
                label={t('settings.privacy_shield', 'Privacy Shield')}
                description={t('mobile.org.my_shield_enabled_desc', 'Screen your messages before they reach a model')}
                value={shield.enabled}
                onValueChange={(value) => onChange({ enabled: value })}
                icon={
                    <Icon
                        name="Shield"
                        size={16}
                        color={shield.enabled ? theme.colors.success : theme.colors.textMuted}
                    />
                }
            />
            <ToggleRow
                label={t('mobile.org.my_shield_pii', 'Detect personal data')}
                description={t('mobile.org.my_shield_pii_desc', 'Find names, numbers and identifiers in what you send')}
                value={shield.piiDetectionEnabled}
                disabled={!shield.enabled}
                onValueChange={(value) => onChange({ piiDetectionEnabled: value })}
            />
            <ToggleRow
                label={t('mobile.org.shield_eu_only', 'EU-only models')}
                description={t('mobile.org.my_shield_eu_desc', 'Route your work to models hosted in the EU')}
                value={shield.euModeEnabled}
                disabled={!shield.enabled}
                onValueChange={(value) => onChange({ euModeEnabled: value })}
                icon={<Icon name="Globe" size={16} color={theme.colors.textSecondary} />}
            />
            <ToggleRow
                label={t('mobile.org.my_shield_no_search', 'No web search on uploads')}
                description={t('mobile.org.my_shield_no_search_desc', 'Keep uploaded documents out of any web lookup')}
                value={shield.disableSearchOnUpload}
                disabled={!shield.enabled}
                onValueChange={(value) => onChange({ disableSearchOnUpload: value })}
            />
        </Group>
    );
}
