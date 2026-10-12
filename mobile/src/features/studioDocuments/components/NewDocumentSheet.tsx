/**
 * "New document": the web's starter gallery — a blank page and the page
 * starters (invoice, proposal, letter, …), then a blank presentation and the
 * deck starters, each with its parameter count.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Banner, Icon, ListRow, LoadingState, Sheet, Text, type IconName } from '@/shared/ui';

import { useDocumentStarters } from '../hooks/queries';
import type { StarterChoice } from '../model/create';
import type { DocumentStarter } from '../model/types';

export interface NewDocumentSheetProps {
    visible: boolean;
    locale: string;
    busy: boolean;
    error: unknown;
    onClose: () => void;
    onPick: (choice: StarterChoice) => void;
}

const styles = StyleSheet.create({ group: { gap: 4 }, heading: { marginTop: 12 } });

function StarterRow({ icon, title, subtitle, disabled, onPress }: { icon: IconName; title: string; subtitle?: string; disabled: boolean; onPress: () => void }) {
    const theme = useTheme();
    return (
        <ListRow
            title={title}
            subtitle={subtitle}
            leading={<Icon name={icon} size={20} color={theme.colors.accentText} />}
            disabled={disabled}
            onPress={onPress}
        />
    );
}

export function NewDocumentSheet({ visible, locale, busy, error, onClose, onPick }: NewDocumentSheetProps) {
    const t = useTranslation();
    const starters = useDocumentStarters(locale, visible);
    const all = starters.data ?? [];
    const count = (s: DocumentStarter) => t('mobile.studio_documents.parameters_count', '{count} parameters', { count: s.parameterCount });
    const rows = (deck: boolean) =>
        all
            .filter((s) => (s.docType === 'presentation') === deck)
            .map((s) => (
                <StarterRow key={s.id} icon={deck ? 'Presentation' : 'FileText'} title={s.name} subtitle={count(s)} disabled={busy} onPress={() => onPick({ starter: s })} />
            ));
    return (
        <Sheet visible={visible} onClose={onClose} title={t('mobile.studio_documents.start_title', 'Start a document')} tall>
            {error ? <Banner tone="error">{describeError(error).message}</Banner> : null}
            {starters.isError ? <Banner tone="error">{describeError(starters.error).message}</Banner> : null}
            <View style={styles.group}>
                <StarterRow icon="FilePlus" title={t('mobile.studio_documents.blank_document', 'Blank document')} disabled={busy} onPress={() => onPick({ blank: 'page' })} />
                {starters.isLoading ? <LoadingState /> : rows(false)}
            </View>
            <Text variant="label" weight="semibold" tone="tertiary" style={styles.heading}>
                {t('mobile.studio_documents.presentations', 'Presentations')}
            </Text>
            <Text variant="caption" tone="tertiary">
                {t(
                    'mobile.studio_documents.presentations_hint',
                    'Slides in the house style: an outline you type, downloaded as PowerPoint or PDF. Placeholders make it a template an automation can fill.',
                )}
            </Text>
            <View style={styles.group}>
                <StarterRow icon="Presentation" title={t('mobile.studio_documents.blank_presentation', 'Blank presentation')} disabled={busy} onPress={() => onPick({ blank: 'deck' })} />
                {rows(true)}
            </View>
        </Sheet>
    );
}
