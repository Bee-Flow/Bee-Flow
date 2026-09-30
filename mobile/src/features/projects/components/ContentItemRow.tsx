/**
 * One thing in a Solution: its kind tile, its name, the facts its listing
 * carries and what it depends on, the worst the checks said about it, and —
 * for someone who may — a way to take it back out.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Badge, Icon, IconButton, KindTile, ListRow } from '@/shared/ui';

import type { ContentRow } from '../model/content';
import { subLines } from '../model/content';
import { itemLabel } from '../model/sections';

export function ContentItemRow({
    row,
    onOpen,
    onRemove,
}: {
    row: ContentRow;
    onOpen: (row: ContentRow) => void;
    onRemove: (row: ContentRow) => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const untitled = t('solutions.depends_unnamed', 'Untitled');
    const title = itemLabel(row.item) ?? untitled;
    const depends = row.dependsOn.length
        ? `→ ${row.dependsOn.map((n) => n.name || untitled).join(', ')}`
        : null;
    const subtitle = [...subLines(row, t), depends].filter(Boolean).join(' · ');
    const blocking = row.finding?.severity === 'error';

    return (
        <ListRow
            title={title}
            subtitle={subtitle || undefined}
            wrapTitle
            testID={`content-row-${row.item.id}`}
            leading={
                row.section.tile ? (
                    <KindTile kind={row.section.tile} size={28} />
                ) : (
                    <Icon name="ShieldCheck" size={18} color={theme.colors.textTertiary} />
                )
            }
            trailing={
                <>
                    {row.finding ? (
                        <Badge
                            tone={blocking ? 'error' : 'warning'}
                            icon="TriangleAlert"
                            label={blocking ? t('solutions.status_blocking', 'Needs fixing') : t('solutions.status_advice', 'Worth a look')}
                        />
                    ) : null}
                    {row.removable ? (
                        <IconButton
                            icon={<Icon name="X" size={16} color={theme.colors.textTertiary} />}
                            accessibilityLabel={t('projects.remove_from_project', 'Remove from project')}
                            onPress={() => onRemove(row)}
                            tone="danger"
                        />
                    ) : null}
                </>
            }
            chevron={false}
            onPress={() => onOpen(row)}
        />
    );
}
