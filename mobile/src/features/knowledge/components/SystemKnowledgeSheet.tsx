/**
 * System knowledge bases (GET /api/kb/system) — the read-only collections Bee
 * Flow maintains, how much of each is loaded, and whether this organisation
 * has switched it on (the web's SystemKnowledgeBasesPanel). Opened from the
 * top of the knowledge list; a sheet, not a screen, because it is a status
 * view of that list rather than a place of its own.
 *
 * Switching one on or off is an organisation setting (the beta-feature
 * allow-list) and stays with the organisation admin screens; a super-admin's
 * bypass is said out loud so "off" does not read as "unavailable". Pull to
 * refresh re-reads the counts.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { timeAgo, useTranslation, type TranslateFn } from '@/core/i18n';
import { nOf } from '@/shared/lib/plural';
import { QueryList } from '@/shared/patterns';
import { Badge, ListRow, Sheet } from '@/shared/ui';

import { useSystemKnowledgeBases } from '../hooks/manage';
import type { SystemKb } from '../model/types';

function statusBadge(t: TranslateFn, kb: SystemKb) {
    if (kb.enabledForOrg) return <Badge label={t('mobile.knowledge.system_on', 'On for your organisation')} tone="success" />;
    if (kb.superAdminBypass) return <Badge label={t('mobile.knowledge.system_bypass', 'Available to you (super-admin)')} tone="info" />;
    return <Badge label={t('mobile.knowledge.system_off', 'Off for your organisation')} />;
}

function meta(t: TranslateFn, kb: SystemKb): string {
    const parts = [
        nOf(t, 'knowledge.n_documents', kb.documentCount, ['{count} document', '{count} documents']),
        nOf(t, 'mobile.knowledge.passages', kb.totalChunks, ['{count} passage', '{count} passages']),
        kb.updatedAt ? t('knowledge.updated_chip', 'Updated {when}', { when: timeAgo(kb.updatedAt, { suffix: true }) }) : null,
    ];
    return parts.filter(Boolean).join(' · ');
}

export function SystemKnowledgeSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
    const t = useTranslation();
    const router = useRouter();
    const query = useSystemKnowledgeBases(visible);
    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={t('mobile.knowledge.system_title', 'System knowledge bases')}
            subtitle={t('mobile.knowledge.system_hint', 'Read-only collections maintained by Bee Flow')}
            scroll={false}
            tall
        >
            <QueryList
                query={query}
                keyExtractor={(kb) => kb.id}
                renderItem={({ item }) => (
                    <ListRow
                        title={item.icon ? `${item.icon} ${item.name}` : item.name}
                        subtitle={item.description || undefined}
                        meta={meta(t, item)}
                        wrapTitle
                        trailing={statusBadge(t, item)}
                        onPress={
                            item.enabledForOrg || item.superAdminBypass
                                ? () => {
                                      onClose();
                                      router.push(`/knowledge/${item.id}`);
                                  }
                                : undefined
                        }
                    />
                )}
                empty={{
                    icon: 'Shield',
                    title: t('mobile.knowledge.system_empty', 'No system knowledge bases yet'),
                    message: t('mobile.knowledge.system_empty_hint', 'The server provides them when a feature that uses one is switched on.'),
                }}
            />
        </Sheet>
    );
}
