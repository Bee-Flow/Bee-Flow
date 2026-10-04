/**
 * The list's "New automation" menu: from scratch or from a template — both the
 * flow editor's new-automation screen, /automations/new.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { ActionMenu } from '@/shared/ui';

export function NewAutomationMenu({ visible, onClose }: { visible: boolean; onClose: () => void }) {
    const t = useTranslation();
    const router = useRouter();
    return (
        <ActionMenu
            visible={visible}
            onClose={onClose}
            title={t('automations.new', 'New automation')}
            items={[
                {
                    id: 'blank', icon: 'Plus', label: t('mobile.automations.new_blank', 'Start from scratch'),
                    accessibilityHint: t('mobile.automations.new_blank_hint', 'An automation with a Run button trigger; add its steps next'),
                    onPress: () => router.push('/automations/new'),
                },
                {
                    id: 'template', icon: 'LayoutTemplate', label: t('mobile.automations.new_template', 'From a template'),
                    onPress: () => router.push('/automations/new?from=template'),
                },
            ]}
        />
    );
}
