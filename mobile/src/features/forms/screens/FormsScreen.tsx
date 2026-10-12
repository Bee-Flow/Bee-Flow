/**
 * Forms — every form your organisation has published (the web's Studio →
 * Forms and /app/forms in one list).
 *
 * A form is the front door of an automation: whoever fills it in starts it. The
 * list is org-scoped on purpose — a form has an address, and an address
 * belongs to the organisation. Tapping a form opens its Form page when it is
 * yours (or its answers are shared with you), and otherwise opens it to fill
 * in. "New form" creates one.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { QueryList } from '@/shared/patterns';
import { Button, Screen, ScreenHeader } from '@/shared/ui';

import { FormRow } from '../components/FormRow';
import { useForms, useRememberFormOpened } from '../hooks/queries';
import { listTarget } from '../model/formPage';
import type { FormSummary } from '../model/types';

const matches = (form: FormSummary, needle: string) => `${form.title} ${form.description ?? ''}`.toLowerCase().includes(needle);

export function FormsScreen() {
    const t = useTranslation();
    const router = useRouter();
    const remember = useRememberFormOpened();
    const query = useForms();
    const forms = query.data;
    const open = (form: FormSummary) => {
        const target = listTarget(form);
        if (!target) return;
        // Opened from the list counts, as on the web's forms page.
        remember(form.id);
        if (target.kind === 'page') router.push(`/forms/${encodeURIComponent(target.automationId)}`);
        else router.push(`/forms/fill/${encodeURIComponent(target.token)}`);
    };
    const count = forms
        ? forms.length === 1
            ? t('forms.studio.count', '{count} form', { count: forms.length })
            : t('forms.studio.count_plural', '{count} forms', { count: forms.length })
        : undefined;

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader
                title={t('sidebar.forms', 'Forms')}
                subtitle={count}
                actions={<Button size="sm" iconName="Plus" label={t('forms.studio.new', 'New form')} onPress={() => router.push('/forms/new')} testID="forms-new" />}
            />
            <QueryList
                query={query}
                keyExtractor={(form) => form.id}
                search={{ placeholder: t('mobile.forms.search', 'Search forms'), match: matches }}
                renderItem={({ item }) => <FormRow form={item} onPress={listTarget(item) ? () => open(item) : undefined} />}
                empty={{
                    icon: 'ClipboardList',
                    title: t('forms.studio.empty_title', 'No forms yet'),
                    message: t('forms.studio.empty_body', 'A form is a page the colleagues you share it with can fill in. Create one and it appears here.'),
                    actionLabel: t('forms.studio.new', 'New form'),
                    onAction: () => router.push('/forms/new'),
                }}
                noMatch={{
                    title: t('mobile.forms.no_match', 'No form matches that'),
                    message: t('mobile.forms.no_match_hint', 'Try another word.'),
                    clearLabel: t('automations.mapping.clear_search', 'Clear search'),
                }}
            />
        </Screen>
    );
}
