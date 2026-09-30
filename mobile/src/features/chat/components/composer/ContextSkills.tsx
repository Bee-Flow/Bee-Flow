/**
 * Skills in the ＋ sheet, from the store the Skills screen writes, with a link
 * there: /skills had no inbound route outside the More tab, so the one place
 * that names it is also a way to it.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useActiveSkills } from '@/features/skills';
import { nOf } from '@/shared/lib/plural';
import { Button, Text } from '@/shared/ui';

import { ContextSectionLabel } from './ContextSectionLabel';

export function ContextSkills({ onClose }: { onClose: () => void }) {
    const t = useTranslation();
    const router = useRouter();
    const { activeSkillIds } = useActiveSkills();
    return (
        <View>
            <ContextSectionLabel>{t('chat.composer.skills', 'Skills')}</ContextSectionLabel>
            {activeSkillIds.length ? (
                <Text variant="caption" tone="secondary">
                    {nOf(t, 'mobile.chat.skills_on', activeSkillIds.length, [
                        '{count} skill is switched on and will be used.',
                        '{count} skills are switched on and will be used.',
                    ])}
                </Text>
            ) : (
                <Text variant="caption" tone="tertiary">
                    {t('mobile.chat.skills_none', 'None switched on.')}
                </Text>
            )}
            <Button
                label={t('mobile.chat.skills_manage', 'Manage skills')}
                variant="ghost"
                onPress={() => {
                    onClose();
                    router.push('/skills');
                }}
            />
        </View>
    );
}
