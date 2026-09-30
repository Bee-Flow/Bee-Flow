/**
 * Start a routine from a template — the server's gallery
 * (automation/templates.js). Picking one installs it as a new draft routine
 * (POST /templates/:id/create) and hands its id back.
 */

import React, { createContext, useContext } from 'react';
import { FlatList, type ListRenderItem, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { FlowTemplateSummary } from '@/features/flow-editor/api';
import { useCreateFromTemplate, useTemplates } from '@/features/flow-editor/hooks';
import { AppIcon, EmptyState, ErrorState, ListRow, ListSkeleton, Sheet, useToast } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    list: { paddingBottom: theme.spacing[6] } satisfies ViewStyle,
    glyph: { color: theme.colors.textSecondary },
});

const PickContext = createContext<(id: string) => void>(() => undefined);

function TemplateRow({ template }: { template: FlowTemplateSummary }) {
    const styles = useThemedStyles(makeStyles);
    const onPick = useContext(PickContext);
    return (
        <ListRow
            title={template.title}
            subtitle={template.description}
            meta={template.category}
            wrapTitle
            leading={<AppIcon name={template.icon} fallback="Workflow" size={18} color={styles.glyph.color} />}
            onPress={() => onPick(template.id)}
            testID={`template-${template.id}`}
        />
    );
}

const renderTemplate: ListRenderItem<FlowTemplateSummary> = ({ item }) => <TemplateRow template={item} />;
const keyOf = (template: FlowTemplateSummary) => template.id;

export function TemplateSheet({ visible, onClose, onCreated }: { visible: boolean; onClose: () => void; onCreated: (automationId: string) => void }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const { toast } = useToast();
    const templates = useTemplates();
    const create = useCreateFromTemplate({
        onSuccess: (result) => {
            const id = result?.automation?.id;
            if (id) onCreated(id);
            else toast(t('mobile.flow.template_gone', 'That template is no longer available.'), 'error');
        },
        onError: (err) => toast(describeError(err).message, 'error'),
    });
    const list = templates.data?.templates ?? [];
    let body: React.ReactElement;
    if (templates.isLoading) body = <ListSkeleton />;
    else if (templates.isError) body = <ErrorState error={templates.error} onRetry={() => void templates.refetch()} />;
    else if (!list.length) body = <EmptyState icon="LayoutTemplate" title={t('mobile.flow.templates_none', 'No templates yet')} />;
    else body = <FlatList data={list} renderItem={renderTemplate} keyExtractor={keyOf} contentContainerStyle={styles.list} testID="template-list" />;
    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={t('mobile.flow.from_template', 'Start from a template')}
            subtitle={create.isPending ? t('mobile.flow.template_creating', 'Setting it up…') : undefined}
            scroll={false}
            tall
        >
            <PickContext.Provider value={(id) => !create.isPending && create.mutate(id)}>{body}</PickContext.Provider>
        </Sheet>
    );
}
