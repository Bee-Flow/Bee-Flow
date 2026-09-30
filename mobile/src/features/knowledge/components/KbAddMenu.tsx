/**
 * "Add a source" — every way material gets into a knowledge base, in one menu:
 * the phone's upload / scan / link / paste sheet, a web page or site that
 * refreshes itself, a sitemap, an n8n workflow. A Nextcloud folder is listed
 * as the web lists it (the artboard draws all kinds) but disabled with the
 * web's "coming soon": the server does not create that kind yet
 * (sources.js CREATABLE_KINDS).
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { ActionMenu, type ActionMenuItem } from '@/shared/ui';

import { sourceKindLabel } from '../model/sources';

export type AddChoice = 'files' | 'web' | 'sitemap' | 'workflow';

export function KbAddMenu({ visible, onClose, onChoose }: { visible: boolean; onClose: () => void; onChoose: (choice: AddChoice) => void }) {
    const t = useTranslation();
    const pick = (choice: AddChoice) => () => onChoose(choice);
    const items: ActionMenuItem[] = [
        { id: 'files', label: t('mobile.knowledge.add_files', 'Upload, scan, link or paste'), icon: 'Upload', onPress: pick('files') },
        { id: 'web', label: t('mobile.knowledge.add_web', 'Web page or site, kept up to date'), icon: 'Globe', onPress: pick('web') },
        { id: 'sitemap', label: t('mobile.knowledge.sitemap', 'Sitemap'), icon: 'Map', onPress: pick('sitemap') },
        { id: 'workflow', label: t('mobile.knowledge.workflow', 'n8n workflow'), icon: 'Workflow', onPress: pick('workflow') },
        {
            id: 'nextcloud',
            label: sourceKindLabel(t, 'nextcloud_folder'),
            icon: 'Folder',
            disabled: true,
            accessibilityHint: t('knowledge.add_source_soon', 'Coming soon — this kind of source is not available yet.'),
            onPress: onClose,
        },
    ];
    return <ActionMenu visible={visible} onClose={onClose} title={t('knowledge.add_source', 'Add a source')} items={items} />;
}
