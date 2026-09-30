/**
 * Who approves a playbook whose recipe has an approval phase (the web's
 * NewPlaybookDialog "Approver group"): the owner, or one of the
 * organisation's groups. `/auth/groups` refuses people without user
 * management; they still get the owner, which is also the server's default.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useOrgGroups } from '@/shared/patterns';
import { OptionRow, Text } from '@/shared/ui';

export function ApproverPicker({ value, onPick }: { value: string; onPick: (groupId: string) => void }) {
    const t = useTranslation();
    const groups = useOrgGroups();
    return (
        <View testID="playbook-approver">
            <Text variant="label" tone="secondary">
                {t('playbooks.new.approver', 'Approver group (optional)')}
            </Text>
            <OptionRow
                label={t('playbooks.new.approver_me', 'Me (the owner)')}
                selected={!value}
                onPress={() => onPick('')}
                testID="playbook-approver-me"
            />
            {(groups.data ?? []).map((g) => (
                <OptionRow
                    key={g.id}
                    label={g.name || g.id}
                    selected={value === g.id}
                    onPress={() => onPick(g.id)}
                    testID={`playbook-approver-${g.id}`}
                />
            ))}
        </View>
    );
}
