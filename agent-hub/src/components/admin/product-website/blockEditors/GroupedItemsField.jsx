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
}) {
    const { t } = useTranslation();
    const newGroup = () => ({
        [headingKey]: newGroupName,
        [itemsKey]: [],
    });
    const newItem = () => itemKind === 'icon-label'
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
                        value={group?.[headingKey] || ''}
                        onChange={v => updateGroup({ ...group, [headingKey]: v })}
                        align={group?.[`${headingKey}Align`] || 'left'}
                        onAlignChange={v => updateGroup({ ...group, [`${headingKey}Align`]: v })}
                    />
                    <RepeatableList
                        label={innerLabel}
                        items={group?.[itemsKey] || []}
                        onChange={v => updateGroup({ ...group, [itemsKey]: v })}
                        makeNew={newItem}
                        itemLabel={(it) => itemKind === 'icon-label'
                            ? (it?.label || t('cms_site.blocks.shared.no_label', '(no label)'))
                            : (it || t('cms_site.blocks.shared.empty', '(empty)'))}
                        renderItem={(it, updateItem) => (
                            itemKind === 'icon-label' ? (
                                <>
                                    <IconField
                                        label={t('cms_site.blocks.shared.icon', 'Icon')}
                                        value={it?.icon}
                                        onChange={v => updateItem({ ...(it || {}), icon: v })}
                                    />
                                    <TextField
                                        label={t('cms_site.blocks.shared.label', 'Label')}
                                        value={it?.label || ''}
                                        onChange={v => updateItem({ ...(it || {}), label: v })}
                                    />
                                </>
                            ) : (
                                // Bare string item — update(newString)
                                // replaces it in place in the array.
                                <TextField
                                    label={t('cms_site.blocks.shared.text', 'Text')}
                                    value={it || ''}
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
