/**
 * Where the routine lives and whose it is: its folder (the sidebar folders
 * are organisation-wide; moving a routine files it for everyone who can see
 * the folder), and who it runs as — the owner, with the owner's connected
 * apps and permissions, which is why only the owner can edit it.
 */

import React, { createContext, useContext, useState } from 'react';
import { FlatList, type ListRenderItem } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import type { FlowFolder } from '@/features/flow-editor/api';
import { useFolders, useMoveToFolder } from '@/features/flow-editor/hooks';
import { AppIcon, Group, Icon, InfoRow, ListRow, NoteRow, SettingRow, Sheet, useToast } from '@/shared/ui';

interface Choice {
    id: string | null;
    name: string;
    icon: string | null;
}

const Pick = createContext<{ current: string | null; onPick: (id: string | null) => void }>({ current: null, onPick: () => undefined });

function FolderChoice({ choice }: { choice: Choice }) {
    const { current, onPick } = useContext(Pick);
    const selected = choice.id === current;
    return (
        <ListRow
            title={choice.name}
            leading={choice.icon ? <AppIcon name={choice.icon} fallback="Folder" size={18} /> : <Icon name="House" size={18} />}
            trailing={selected ? <Icon name="Check" size={18} /> : undefined}
            selected={selected}
            onPress={() => onPick(choice.id)}
            testID={`folder-${choice.id ?? 'top'}`}
        />
    );
}
const renderChoice: ListRenderItem<Choice> = ({ item }) => <FolderChoice choice={item} />;
const keyOf = (c: Choice) => c.id ?? '__top__';

function FolderSheet({ folders, current, onPick, onClose }: { folders: FlowFolder[]; current: string | null; onPick: (id: string | null) => void; onClose: () => void }) {
    const t = useTranslation();
    const choices: Choice[] = [
        { id: null, name: t('mobile.flow.settings.top_level', 'No folder (top level)'), icon: null },
        ...folders.map((f) => ({ id: f.id, name: f.name, icon: f.icon })),
    ];
    return (
        <Sheet visible onClose={onClose} title={t('mobile.flow.settings.move_to', 'Move to folder')} scroll={false} tall>
            <Pick.Provider value={{ current, onPick }}>
                <FlatList data={choices} renderItem={renderChoice} keyExtractor={keyOf} testID="folder-list" />
            </Pick.Provider>
        </Sheet>
    );
}

export function PlacementGroup({ flowKey, folderId }: { flowKey: string; folderId: string | null }) {
    const t = useTranslation();
    const { toast } = useToast();
    const { user } = useAuth();
    const folders = useFolders();
    const [picking, setPicking] = useState(false);
    const move = useMoveToFolder(flowKey, {
        onSuccess: () => toast(t('mobile.flow.settings.moved', 'Moved'), 'success'),
        onError: (err) => toast(describeError(err).message, 'error'),
    });
    const list = folders.data ?? [];
    const current = list.find((f) => f.id === folderId);
    const folderName = folderId ? current?.name ?? t('mobile.flow.settings.a_folder', 'A folder') : t('common.none', 'None');
    return (
        <>
            <Group title={t('mobile.flow.settings.placement', 'Folder and owner')}>
                <SettingRow
                    label={t('routines.settings.folder', 'Folder')}
                    value={move.isPending ? t('common.saving', 'Saving…') : folderName}
                    onPress={() => setPicking(true)}
                    icon={<Icon name="Folder" size={18} />}
                    testID="settings-folder"
                />
                <InfoRow label={t('mobile.flow.settings.runs_as', 'Runs as')} value={user?.displayName || user?.email || t('mobile.flow.settings.you', 'You')} />
                <NoteRow>
                    {t('mobile.flow.settings.runs_as_hint', 'A routine runs with its owner’s connected apps and permissions, so only its owner can edit it.')}
                </NoteRow>
            </Group>
            {picking ? (
                <FolderSheet
                    folders={list}
                    current={folderId}
                    onClose={() => setPicking(false)}
                    onPick={(id) => {
                        setPicking(false);
                        if (id !== folderId) move.mutate(id);
                    }}
                />
            ) : null}
        </>
    );
}
