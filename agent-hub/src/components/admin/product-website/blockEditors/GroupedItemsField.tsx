import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { TextField, IconField, RepeatableList } from '../fields';

// GroupedItemsField — reusable nested-RepeatableList editor for blocks
// that store "groups of items" (Integrations categories → tools,
// Architecture layers → tags). Storage keys vary per block: Integrations
// uses `heading` + `items[]` of `{icon, label}`; Architecture uses
// `label` + `tags[]` of bare strings. Callers pass `headingKey` and
// `itemsKey` so this helper writes to the right keys without changing
// any persisted data shape.
interface IconItem { icon?: string; label?: string }
type GroupItem = string | IconItem;
type Group = Record<string, string | GroupItem[]>;
interface GroupedItemsFieldProps {
    groups?: Group[];
    onChange: (groups: Group[]) => void;
    groupsLabel?: string;
    groupNameLabel?: string;
    addGroupLabel?: string;
    newGroupName?: string;
    itemKind?: string;
    headingKey?: string;
    itemsKey?: string;
}

export function GroupedItemsField({
    groups = [],
    onChange,
    groupsLabel = 'Groups',
    groupNameLabel = 'Group name',
    addGroupLabel = 'Add group',
    newGroupName = 'New group',
    itemKind = 'string',     // 'string' | 'icon-label'
    headingKey = 'heading',
    itemsKey = 'items',
}: GroupedItemsFieldProps) {
    const { t } = useTranslation();
    const newGroup = () => ({
        [headingKey]: newGroupName,
        [itemsKey]: [],
    });
    const newItem = (): GroupItem => itemKind === 'icon-label'
        ? { icon: 'Plug', label: 'New item' }
        : 'tag';

    const innerLabel    = itemKind === 'icon-label'
        ? t('cms_site.blocks.shared.items', 'Items')
        : t('cms_site.blocks.shared.tags', 'Tags');
    const innerAddLabel = itemKind === 'icon-label'
        ? t('cms_site.blocks.shared.add_item', 'Add item')
        : t('cms_site.blocks.shared.add_tag', 'Add tag');

    return (
        <RepeatableList
            label={groupsLabel}
            items={groups}
            onChange={onChange}
            makeNew={newGroup}
            itemLabel={(g) => g?.[headingKey] || t('cms_site.blocks.shared.no_name', '(no name)')}
            collapsible
            renderItem={(group, updateGroup) => (
                <>
                    <TextField
                        label={groupNameLabel}
                        value={(group?.[headingKey] || '') as string}
                        onChange={v => updateGroup({ ...group, [headingKey]: v })}
                        align={(group?.[`${headingKey}Align`] || 'left') as string}
                        onAlignChange={v => updateGroup({ ...group, [`${headingKey}Align`]: v })}
                    />
                    <RepeatableList
                        label={innerLabel}
                        items={(group?.[itemsKey] || []) as GroupItem[]}
                        onChange={v => updateGroup({ ...group, [itemsKey]: v })}
                        makeNew={newItem}
                        itemLabel={(it) => itemKind === 'icon-label'
                            ? ((it as IconItem)?.label || t('cms_site.blocks.shared.no_label', '(no label)'))
                            : (it || t('cms_site.blocks.shared.empty', '(empty)'))}
                        renderItem={(it, updateItem) => (
                            itemKind === 'icon-label' ? (
                                <>
                                    <IconField
                                        label={t('cms_site.blocks.shared.icon', 'Icon')}
                                        value={(it as IconItem)?.icon}
                                        onChange={v => updateItem({ ...((it || {}) as IconItem), icon: v })}
                                    />
                                    <TextField
                                        label={t('cms_site.blocks.shared.label', 'Label')}
                                        value={(it as IconItem)?.label || ''}
                                        onChange={v => updateItem({ ...((it || {}) as IconItem), label: v })}
                                    />
                                </>
                            ) : (
                                // Bare string item — update(newString)
                                // replaces it in place in the array.
                                <TextField
                                    label={t('cms_site.blocks.shared.text', 'Text')}
                                    value={(it || '') as string}
                                    onChange={updateItem}
                                    placeholder={t('cms_site.blocks.shared.e_g_postgres', 'e.g. Postgres')}
                                />
                            )
                        )}
                        addLabel={innerAddLabel}
                    />
                </>
            )}
            addLabel={addGroupLabel}
        />
    );
}
