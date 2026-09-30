/**
 * One system knowledge base (SystemKnowledgeBasesPanel.jsx card): what it is,
 * how much of it is loaded, and the switch that makes it usable for the
 * organisation's agents and chat. A platform operator's bypass is said out
 * loud, so "off" does not read as "unavailable to you".
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { timeAgo, useTranslation } from '@/core/i18n';
import type { SystemKb } from '@/features/knowledge';
import { Badge, ListRow, Switch } from '@/shared/ui';

const styles = StyleSheet.create({ trailing: { alignItems: 'flex-end', gap: 6 } });

export function SystemKbRow({
    kb,
    locked,
    busy,
    onToggle,
}: {
    kb: SystemKb;
    /** The switch cannot move: no feature behind it, a governed plan, or a save running. */
    locked: boolean;
    busy: boolean;
    onToggle: (kb: SystemKb) => void;
}) {
    const t = useTranslation();
    const counts = t('mobile.knowledge.system_counts', '{docs} documents · {chunks} chunks', { docs: kb.documentCount, chunks: kb.totalChunks });
    const updated = kb.updatedAt ? t('knowledge.updated_chip', 'Updated {when}', { when: timeAgo(kb.updatedAt, { suffix: true }) }) : null;
    return (
        <ListRow
            testID={`system-kb-${kb.id}`}
            title={kb.icon ? `${kb.icon} ${kb.name}` : kb.name}
            subtitle={kb.description ?? undefined}
            meta={[counts, updated].filter(Boolean).join(' · ')}
            wrapTitle
            trailing={
                <View style={styles.trailing}>
                    <Switch
                        testID={`system-kb-${kb.id}-switch`}
                        value={kb.enabledForOrg}
                        disabled={locked || busy || !kb.slug}
                        accessibilityLabel={
                            kb.enabledForOrg
                                ? t('mobile.orgIntegrations.kb_on', 'Enabled for organisation')
                                : t('mobile.orgIntegrations.kb_off', 'Disabled for organisation')
                        }
                        onValueChange={() => onToggle(kb)}
                    />
                    {kb.superAdminBypass && !kb.enabledForOrg ? (
                        <Badge label={t('mobile.knowledge.system_bypass', 'Available to you (super-admin)')} tone="info" icon="ShieldCheck" />
                    ) : null}
                </View>
            }
        />
    );
}
