/**
 * The hub's Templates block. A 403 means "templates are not switched on for
 * this organisation", which the empty copy explains better than a red error
 * with a dead retry button.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { isUnavailable, type Template, type useTemplates } from '@/features/templates';
import { nOf } from '@/shared/lib/plural';
import { Icon, ListRow } from '@/shared/ui';

import { HubRows } from './HubRows';
import { HubSection } from './HubSection';

function TemplateHubRow({ template }: { template: Template }) {
    const t = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    return (
        <ListRow
            title={template.name}
            subtitle={template.description || template.fileName || undefined}
            meta={nOf(t, 'mobile.library.n_fields', template.parameters.length, ['{count} field', '{count} fields'])}
            wrapTitle
            leading={<Icon name="PanelsTopLeft" size={16} color={theme.colors.textMuted} />}
            onPress={() => router.push('/templates')}
        />
    );
}

export function TemplatesHubSection({ templates }: { templates: ReturnType<typeof useTemplates> }) {
    const t = useTranslation();
    const router = useRouter();
    const off = isUnavailable(templates.error);
    return (
        <HubSection
            title={t('documents.library.templates', 'Templates')}
            icon="PanelsTopLeft"
            count={templates.data?.length}
            onSeeAll={() => router.push('/templates')}
            loading={templates.isLoading}
            error={templates.isError && !off ? templates.error : undefined}
            onRetry={() => void templates.refetch()}
            isEmpty={(templates.data?.length ?? 0) === 0 || off}
            emptyTitle={off ? t('mobile.library.templates_off', 'Templates are not enabled') : t('mobile.library.templates_empty', 'No templates yet')}
            emptyMessage={
                off
                    ? t('mobile.library.templates_off_hint', 'Templates are a beta feature. An administrator can switch them on for your organisation.')
                    : t('mobile.library.templates_empty_hint', 'Upload a Word document with {{placeholders}} and Bee Flow will fill it in for you.')
            }
            emptyActionLabel={off ? undefined : t('mobile.library.templates_open', 'Open templates')}
            onEmptyAction={off ? undefined : () => router.push('/templates')}
        >
            <HubRows items={templates.data ?? []} renderRow={(template) => <TemplateHubRow template={template} />} />
        </HubSection>
    );
}
