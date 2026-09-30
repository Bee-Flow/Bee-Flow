/**
 * "Use in new chats" — the phone's own switch, not the web's: which skills
 * the composer sends as `activeSkillIds` (model/active). A dynamic skill is
 * offered to the model rather than added to every message, and says so.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Card, Icon, ToggleRow, useToast } from '@/shared/ui';

import { capMessage, useActiveSkills } from '../model/active';

export function SkillActiveToggle({ skillId, dynamic }: { skillId: string; dynamic: boolean }) {
    const t = useTranslation();
    const theme = useTheme();
    const { toast } = useToast();
    const { isActive, toggle } = useActiveSkills();

    return (
        <Card padded={false}>
            <ToggleRow
                label={t('mobile.skills.use_in_chats', 'Use in new chats')}
                description={
                    dynamic
                        ? t('mobile.skills.use_dynamic', 'Offered to the model, which pulls it in when it fits.')
                        : t('mobile.skills.use_always', 'Added to every message until you switch it off.')
                }
                value={isActive(skillId)}
                onValueChange={() => {
                    if (!toggle(skillId)) toast(capMessage(t), 'error');
                }}
                icon={<Icon name="Zap" size={18} color={theme.colors.textSecondary} />}
            />
        </Card>
    );
}
