/**
 * The Form page's header — the web's FormPage header on the Studio object
 * header: the form's tile and name (the owner taps it to rename), Live or Not
 * live, the one primary action — fill it in, here — and a ⋯ with the rest:
 * share the link, open it in the browser, open the routine behind it.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { formLiveness, type FormTab } from '@/features/forms/model/formPage';
import type { FormDetail } from '@/features/forms/model/types';
import { ActionMenu, Badge, Button, Icon, IconButton, ObjectHeader, type ActionMenuItem, type TabBarItem } from '@/shared/ui';

function statusBadge(t: TranslateFn, form: FormDetail) {
    switch (formLiveness(form)) {
        case 'live':
            return <Badge label={t('forms.status.live', 'Live')} tone="success" />;
        case 'off':
            return <Badge label={t('forms.status.off', 'Not live')} tone="neutral" />;
        default:
            return <Badge label={t('forms.status.unknown', 'Status unknown')} tone="neutral" />;
    }
}

export interface FormPageHeaderProps {
    form: FormDetail;
    tabs: readonly TabBarItem<FormTab>[];
    tab: FormTab;
    onTab: (tab: FormTab) => void;
    onRename?: () => void;
    onShare: () => void;
}

export function FormPageHeader({ form, tabs, tab, onTab, onRename, onShare }: FormPageHeaderProps) {
    const t = useTranslation();
    const router = useRouter();
    const [menu, setMenu] = useState(false);
    const fill = () => router.push(`/forms/fill/${encodeURIComponent(form.id)}`);
    const items: ActionMenuItem[] = [
        { id: 'share', label: t('forms.share.link_title', 'Link to the form'), icon: 'Share2', onPress: onShare },
        ...(form.mine
            ? [{ id: 'routine', label: t('forms.studio.open_routine', 'Open the routine'), icon: 'Workflow' as const, onPress: () => router.push(`/automations/${form.automationId}/build`) }]
            : []),
    ];
    return (
        <>
            <ObjectHeader
                kind="form"
                title={form.title || t('forms.studio.untitled', 'Untitled form')}
                status={statusBadge(t, form)}
                onTitlePress={onRename}
                titleHint={onRename ? t('mobile.forms.rename_hint', 'Renames this form') : undefined}
                backLabel={t('forms.page.back', 'All forms')}
                primary={
                    form.canOpen && form.id ? (
                        <Button size="sm" label={t('forms.page.open_form', 'Open the form')} onPress={fill} testID="form-page-fill" />
                    ) : undefined
                }
                extras={<IconButton icon={<Icon name="Ellipsis" size={20} />} accessibilityLabel={t('mobile.forms.more', 'More')} onPress={() => setMenu(true)} />}
                tabs={tabs}
                activeTab={tab}
                onTab={onTab}
                testID="form-page-header"
            />
            <ActionMenu visible={menu} onClose={() => setMenu(false)} title={form.title} items={items} />
        </>
    );
}
