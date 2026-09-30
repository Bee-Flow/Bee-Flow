/**
 * "Visible to": Just me, the whole organisation, or one group — and for a
 * group, which one. Only on a new template; the route cannot move one later.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { OptionRow, Text } from '@/shared/ui';

import { scopesFor } from '../model/draft';
import { scopeLabel } from '../model/labels';
import type { TemplateGroup, TemplateScope } from '../model/types';

const styles = StyleSheet.create({ stack: { gap: 4 } });

export function ScopePicker({
    scope,
    groupId,
    canManageOrg,
    groups,
    onScope,
    onGroup,
}: {
    scope: TemplateScope;
    groupId: string;
    canManageOrg: boolean;
    groups: readonly TemplateGroup[];
    onScope: (scope: TemplateScope) => void;
    onGroup: (groupId: string) => void;
}) {
    const t = useTranslation();
    return (
        <View style={styles.stack}>
            <Text variant="label" tone="secondary">
                {t('meeting_notes.template_visible_to', 'Visible to')}
            </Text>
            {scopesFor(canManageOrg).map((option) => (
                <OptionRow
                    key={option}
                    label={scopeLabel(option, t)}
                    selected={scope === option}
                    onPress={() => onScope(option)}
                />
            ))}
            {scope === 'group' ? (
                <>
                    <Text variant="label" tone="secondary">
                        {t('meeting_notes.template_group_choose', 'Choose a group…')}
                    </Text>
                    {groups.map((group) => (
                        <OptionRow
                            key={group.id}
                            label={group.name}
                            selected={groupId === group.id}
                            onPress={() => onGroup(group.id)}
                        />
                    ))}
                </>
            ) : null}
        </View>
    );
}
