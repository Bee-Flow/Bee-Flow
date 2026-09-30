/**
 * Icon packs (the web's Theme Studio "Icons" tab, IconsEditor.jsx): the
 * built-in set and every pack of your own, the active one checked. A pack is
 * personal on the server — activating one changes the icons YOU see — and
 * packs are made and edited on the web; the phone only switches between them.
 */

import React from 'react';
import { FlatList, type ListRenderItem } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { EmptyState, NoteRow, OptionRow, Sheet } from '@/shared/ui';

import type { IconPacks } from '../api/brandingReaders';

type Row = { id: string | null; label: string; detail?: string; selected: boolean; disabled: boolean; onPick: (id: string | null) => void };

const renderPack: ListRenderItem<Row> = ({ item }) => (
    <OptionRow
        testID={`icon-pack-${item.id ?? 'default'}`}
        label={item.label}
        description={item.detail}
        selected={item.selected}
        disabled={item.disabled}
        onPress={() => item.onPick(item.id)}
    />
);

const keyOf = (row: Row) => row.id ?? 'default';

export function IconPacksSheet({
    visible,
    packs,
    saving,
    onPick,
    onClose,
}: {
    visible: boolean;
    packs: IconPacks | undefined;
    saving: boolean;
    onPick: (id: string | null) => void;
    onClose: () => void;
}) {
    const t = useTranslation();
    const active = packs?.activeIconPackId ?? null;
    const rows: Row[] = [
        { id: null, label: t('mobile.org.icons_default', 'Built-in icons'), selected: active === null, disabled: saving, onPick },
        ...(packs?.packs ?? []).map((pack) => ({
            id: pack.id,
            label: pack.name || pack.id,
            detail: t('mobile.org.icons_count', '{n} custom icons', { n: pack.iconCount }),
            selected: active === pack.id,
            disabled: saving,
            onPick,
        })),
    ];
    return (
        <Sheet visible={visible} onClose={onClose} title={t('mobile.org.icons_title', 'Icon pack')} scroll={false} tall>
            <NoteRow>
                {t(
                    'mobile.org.icons_note',
                    'Icon packs are your own: switching changes the icons you see. Create and edit packs in the web app.',
                )}
            </NoteRow>
            {packs ? (
                <FlatList data={rows} renderItem={renderPack} keyExtractor={keyOf} />
            ) : (
                <EmptyState icon="Image" title={t('mobile.patterns.not_loaded', 'This could not be loaded.')} />
            )}
        </Sheet>
    );
}
