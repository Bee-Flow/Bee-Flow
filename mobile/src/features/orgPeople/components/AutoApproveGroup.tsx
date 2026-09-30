/**
 * "Auto-approve users from trusted domains" — the web's toggle above the
 * member list. Only for an organisation whose sign-in method is an external
 * provider: a password organisation's accounts are made by an admin anyway,
 * so the web hides it there and so does this.
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useOrganization, useUpdateOrganization } from '@/features/org';
import { Group, ToggleRow, useToast } from '@/shared/ui';

export function AutoApproveGroup({ orgId }: { orgId: string | null }) {
    const t = useTranslation();
    const { toast } = useToast();
    const org = useOrganization(orgId);
    const update = useUpdateOrganization(orgId);
    const method = org.data?.authMethod;
    if (!method || method === 'password') return null;

    // While a save is in flight the switch shows where it is going.
    const value = update.isPending ? Boolean(update.variables?.autoApproveSSO) : Boolean(org.data?.autoApproveSSO);
    return (
        <Group>
            <ToggleRow
                testID="auto-approve-sso"
                label={t('org.auto_approve_sso', 'Auto-approve users from trusted domains')}
                description={t(
                    'org.auto_approve_desc',
                    'When enabled, users with a matching email domain are added automatically with default permissions. When disabled, they are added as pending and require admin approval.',
                )}
                value={value}
                disabled={update.isPending}
                onValueChange={(next) =>
                    update.mutate(
                        { autoApproveSSO: next },
                        { onError: (error) => toast(describeError(error).message, 'error') },
                    )
                }
            />
        </Group>
    );
}
