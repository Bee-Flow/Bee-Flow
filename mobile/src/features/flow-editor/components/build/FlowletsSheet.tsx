/**
 * The automation's flowlets — the web's FlowletsPanel as a sheet: each flowlet
 * with what it holds, opened on its own screen with a tap; a new one made and
 * opened in one go; rename and delete from its ⋯. Deleting follows the web's
 * rule (flowletsModel.ts): one nothing calls goes, an empty one goes with its
 * calls after asking, one that is in use and has steps stays.
 */

import React, { createContext, useContext, useState } from 'react';
import { FlatList, type ListRenderItem } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useDraftState } from '@/features/flow-editor/hooks';
import { createLayerInDefinition, listLayers, renameLayer, type LayerSummary } from '@/features/flow-editor/model';
import type { DraftStore } from '@/features/flow-editor/state';
import { useConfirm } from '@/shared/patterns';
import { ActionMenu, Button, EmptyState, Icon, IconButton, ListRow, Sheet, useToast } from '@/shared/ui';

import { deleteFlowletOp, flowletDelete, flowletLine } from './flowletsModel';
import { RenameFlowletSheet } from './RenameFlowletSheet';

interface RowActions {
    onOpen: (key: string) => void;
    onMore: (layer: LayerSummary) => void;
}

const Actions = createContext<RowActions>({ onOpen: () => undefined, onMore: () => undefined });

function FlowletRow({ layer }: { layer: LayerSummary }) {
    const t = useTranslation();
    const { onOpen, onMore } = useContext(Actions);
    return (
        <ListRow
            title={layer.title}
            subtitle={flowletLine(layer, t)}
            leading={<Icon name="Layers" size={18} />}
            onPress={() => onOpen(layer.key)}
            trailing={
                <IconButton
                    icon={<Icon name="Ellipsis" size={18} />}
                    accessibilityLabel={t('mobile.flow.flowlets.more', 'More for {name}', { name: layer.title })}
                    onPress={() => onMore(layer)}
                />
            }
            testID={`flowlet-${layer.key}`}
        />
    );
}

const renderRow: ListRenderItem<LayerSummary> = ({ item }) => <FlowletRow layer={item} />;
const keyOf = (layer: LayerSummary) => layer.key;

function useFlowletEdits(store: DraftStore, onOpen: (key: string) => void) {
    const t = useTranslation();
    const confirm = useConfirm();
    const { toast } = useToast();
    const create = () => {
        let key: string | null = null;
        store.getState().applyOp((d) => {
            const made = createLayerInDefinition(d, t('mobile.flow.flowlets.new_title', 'New flowlet'));
            key = made.layerKey;
            return made.definition;
        });
        if (key) onOpen(key);
    };
    const remove = async (layer: LayerSummary) => {
        const how = flowletDelete(store.getState().definition, layer.key);
        if (how.kind === 'confirm') {
            const ok = await confirm({
                title: t('mobile.flow.flowlets.delete_empty_title', 'Delete the empty flowlet “{name}”?', { name: layer.title }),
                message: t('mobile.flow.flowlets.delete_empty_message', 'Its {n} “Call flowlet” steps are removed too; the steps around them reconnect.', { n: how.refs }),
                confirmLabel: t('common.delete', 'Delete'),
            });
            if (!ok) return;
        }
        const op = deleteFlowletOp(layer.key, how);
        if (op && store.getState().applyOp(op)) toast(t('mobile.flow.flowlets.deleted', 'Flowlet deleted — Undo brings it back'), 'success');
    };
    return { create, remove, rename: (key: string, title: string) => store.getState().applyOp((d) => renameLayer(d, key, title)) };
}

export function FlowletsSheet({ visible, store, onClose, onOpen }: { visible: boolean; store: DraftStore; onClose: () => void; onOpen: (key: string) => void }) {
    const t = useTranslation();
    const definition = useDraftState(store, (s) => s.definition);
    const locked = useDraftState(store, (s) => s.locked);
    const [menu, setMenu] = useState<LayerSummary | null>(null);
    const [renaming, setRenaming] = useState<LayerSummary | null>(null);
    const open = (key: string) => {
        onClose();
        onOpen(key);
    };
    const edits = useFlowletEdits(store, open);
    const layers = listLayers(definition);
    const blocked = menu ? flowletDelete(definition, menu.key).kind === 'blocked' : false;
    return (
        <>
            <Sheet
                visible={visible}
                onClose={onClose}
                title={t('automations.canvas.flowlets', 'Flowlets')}
                scroll={false}
                tall
                footer={<Button label={t('automations.flowlets_panel.create_a_new_flowlet', 'Create a new flowlet')} iconName="Plus" onPress={edits.create} disabled={locked} fullWidth testID="flowlet-create" />}
            >
                <Actions.Provider value={{ onOpen: open, onMore: setMenu }}>
                    <FlatList
                        data={layers}
                        renderItem={renderRow}
                        keyExtractor={keyOf}
                        ListEmptyComponent={<EmptyState icon="Layers" title={t('mobile.flow.flowlets.none', 'No flowlets yet')} message={t('mobile.flow.flowlets.none_hint', 'A flowlet groups steps into a reusable sub-flow the automation calls.')} />}
                        testID="flowlet-list"
                    />
                </Actions.Provider>
            </Sheet>
            <ActionMenu
                visible={menu !== null}
                onClose={() => setMenu(null)}
                title={menu?.title}
                items={[
                    { id: 'rename', label: t('automations.flowlets_panel.rename_flowlet', 'Rename flowlet'), icon: 'Pencil', disabled: locked, onPress: () => setRenaming(menu) },
                    {
                        id: 'delete',
                        label: t('automations.header.delete_flowlet_label', 'Delete flowlet'),
                        icon: 'Trash2',
                        destructive: true,
                        disabled: locked || blocked,
                        accessibilityHint: blocked ? t('mobile.flow.flowlets.in_use', 'In use — remove the steps that call it first.') : undefined,
                        onPress: () => menu && void edits.remove(menu),
                    },
                ]}
            />
            {renaming ? <RenameFlowletSheet title={renaming.title} onRename={(title) => edits.rename(renaming.key, title)} onClose={() => setRenaming(null)} /> : null}
        </>
    );
}
