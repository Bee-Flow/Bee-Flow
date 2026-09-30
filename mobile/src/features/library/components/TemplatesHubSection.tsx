/**
 * The hub's Templates block. A 403 means "templates are not switched on for
 * this organisation", which the empty copy explains better than a red error
 * with a dead retry button.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTheme } from '@/core/theme/ThemeProvider';
import { isUnavailable, type Template, type useTemplates } from '@/features/templates';
import { plural } from '@/shared/lib/format';
import { Icon, ListRow } from '@/shared/ui';

import { HubRows } from './HubRows';
import { HubSection } from './HubSection';

function TemplateHubRow({ template }: { template: Template }) {
    const theme = useTheme();
    const router = useRouter();
    return (
        <ListRow
            title={template.name}
            subtitle={template.description || template.fileName || undefined}
            meta={plural(template.parameters.length, 'field')}
            wrapTitle
            leading={<Icon name="PanelsTopLeft" size={16} color={theme.colors.textMuted} />}
            onPress={() => router.push('/templates')}
        />
    );
}

export function TemplatesHubSection({ templates }: { templates: ReturnType<typeof useTemplates> }) {
    const router = useRouter();
    const off = isUnavailable(templates.error);
    return (
        <HubSection
            title="Templates"
            icon="PanelsTopLeft"
            count={templates.data?.length}
            onSeeAll={() => router.push('/templates')}
            loading={templates.isLoading}
            error={templates.isError && !off ? templates.error : undefined}
            onRetry={() => void templates.refetch()}
            isEmpty={(templates.data?.length ?? 0) === 0 || off}
            emptyTitle={off ? 'Templates are not enabled' : 'No templates yet'}
            emptyMessage={
                off
                    ? 'Templates are a beta feature. An administrator can switch them on for your organisation.'
                    : 'Upload a Word document with {{placeholders}} and Bee Flow will fill it in for you.'
            }
            emptyActionLabel={off ? undefined : 'Open templates'}
            onEmptyAction={off ? undefined : () => router.push('/templates')}
        >
            <HubRows items={templates.data ?? []} renderRow={(t) => <TemplateHubRow template={t} />} />
        </HubSection>
    );
}
