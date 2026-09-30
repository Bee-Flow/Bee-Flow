/** One knowledge base in the list: what it holds, a star when it is a favourite, a chip when it is a draft or automatic. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { nOf } from '@/shared/lib/plural';
import { Badge, Icon, ListRow } from '@/shared/ui';

import { countLabel } from '../model/format';
import type { KnowledgeBase } from '../model/types';

const styles = StyleSheet.create({ trailing: { flexDirection: 'row', alignItems: 'center', gap: 6 } });

function kindBadge(t: TranslateFn, kb: KnowledgeBase): React.ReactElement | null {
    if (kb.organization_id && !kb.is_published) return <Badge label={t('studio.status.draft', 'Draft')} tone="warning" />;
    if (!kb.source_kind || kb.source_kind === 'manual') return null;
    if (kb.source_kind === 'notebook') return <Badge label={t('mobile.knowledge.from_notebook', 'From a notebook')} />;
    if (kb.source_kind === 'webpage') return <Badge label={t('mobile.knowledge.from_webpage', 'From a webpage')} />;
    if (kb.source_kind === 'system_managed') return <Badge label={t('mobile.knowledge.system', 'System')} />;
    return <Badge label={t('mobile.knowledge.automatic', 'Automatic')} />;
}

export function KnowledgeBaseRow({
    kb,
    favorite,
    onPress,
    onLongPress,
}: {
    kb: KnowledgeBase;
    favorite: boolean;
    onPress: () => void;
    onLongPress: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const docs = Number(kb.document_count ?? 0);
    const chunks = Number(kb.total_chunks ?? 0);
    return (
        <ListRow
            title={kb.name}
            subtitle={kb.description || undefined}
            meta={countLabel([
                // The web's own document count (KnowledgeOverview.jsx), and
                // "passages" — the web's word for what search finds — rather
                // than the index's "chunks".
                nOf(t, 'knowledge.n_documents', docs, ['{count} document', '{count} documents']),
                chunks > 0 ? nOf(t, 'mobile.knowledge.passages', chunks, ['{count} passage', '{count} passages']) : null,
            ])}
            wrapTitle
            leading={<Icon name={kb.source_kind === 'system_managed' ? 'Shield' : 'Database'} size={18} color={theme.colors.textMuted} />}
            trailing={
                <View style={styles.trailing}>
                    {favorite ? <Icon name="Star" size={14} color={theme.colors.warningInk} /> : null}
                    {kindBadge(t, kb)}
                </View>
            }
            onPress={onPress}
            onLongPress={onLongPress}
        />
    );
}
