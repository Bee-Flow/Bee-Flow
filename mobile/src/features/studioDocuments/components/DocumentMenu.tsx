/**
 * The editor's overflow menu — the rest of the web toolbar: the preview as a
 * page, the PowerPoint download of a deck, the per-document house-style
 * switch, duplicate, "Save a copy as template", rename and archive.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { ActionMenu, useToast, type ActionMenuItem } from '@/shared/ui';

import type { ExportFormat } from '../api/endpoints';
import { useDeleteStudioDocument, useDuplicateStudioDocument } from '../hooks/mutations';
import { useArchiveConfirm } from '../hooks/useArchiveConfirm';
import type { DocumentWrite } from '../hooks/useDocumentWriter';
import { isDeck } from '../model/format';
import { houseStylePatch, usesHouseStyle } from '../model/patches';
import type { StudioDocument } from '../model/types';

export interface DocumentMenuProps {
    doc: StudioDocument;
    visible: boolean;
    onClose: () => void;
    write: DocumentWrite;
    onExport: (format: ExportFormat) => void;
    onRename: () => void;
}

function useMenuActions(doc: StudioDocument, write: DocumentWrite) {
    const t = useTranslation();
    const router = useRouter();
    const confirmArchive = useArchiveConfirm();
    const { toast } = useToast();
    const onError = (error: Error) => toast(describeError(error).message, 'error');
    const duplicate = useDuplicateStudioDocument({
        onSuccess: (copy) => {
            if (!copy) return;
            if (copy.kind === 'template') toast(t('mobile.studio_documents.template_saved', 'Template saved: {name}', { name: copy.name }), 'success');
            else router.push(`/documents/${copy.id}`);
        },
        onError,
    });
    const archive = useDeleteStudioDocument({ onSuccess: () => router.back(), onError });
    const askArchive = async () => {
        if (await confirmArchive(doc.name)) archive.mutate(doc.id);
    };
    const toggleHouseStyle = () =>
        write((current) => houseStylePatch(!usesHouseStyle(current ?? doc), current)).catch(onError);
    return { duplicate, askArchive, toggleHouseStyle };
}

export function DocumentMenu({ doc, visible, onClose, write, onExport, onRename }: DocumentMenuProps) {
    const t = useTranslation();
    const actions = useMenuActions(doc, write);
    const deck = isDeck(doc);
    const editable = doc.editable;
    const items: ActionMenuItem[] = [
        { id: 'preview', label: t('mobile.studio_documents.open_preview', 'Open the preview as a page'), icon: 'Eye', onPress: () => onExport('preview') },
        ...(deck ? [{ id: 'pptx', label: t('documents.download_pptx', 'Download PowerPoint'), icon: 'Presentation' as const, onPress: () => onExport('pptx') }] : []),
        {
            id: 'house-style',
            label: usesHouseStyle(doc) ? t('documents.house_style_on', 'House style') : t('documents.house_style_off', 'No house style'),
            icon: 'Palette',
            selected: usesHouseStyle(doc),
            disabled: !editable,
            accessibilityHint: usesHouseStyle(doc)
                ? t('mobile.studio_documents.house_style_on_hint', 'Turns the organisation’s house style off for this document only.')
                : t('mobile.studio_documents.house_style_off_hint', 'Turns the house style back on for this document.'),
            onPress: () => void actions.toggleHouseStyle(),
        },
        { id: 'duplicate', label: t('mobile.studio_documents.duplicate', 'Duplicate / use template'), icon: 'Copy', onPress: () => actions.duplicate.mutate({ id: doc.id }) },
        {
            id: 'template',
            label: t('mobile.studio_documents.save_template', 'Save a copy as template'),
            icon: 'LayoutTemplate',
            onPress: () => actions.duplicate.mutate({ id: doc.id, kind: 'template' }),
        },
        { id: 'rename', label: t('mobile.studio_documents.rename', 'Rename'), icon: 'Pencil', disabled: !editable, onPress: onRename },
        { id: 'archive', label: t('mobile.studio_documents.archive_document', 'Archive document'), icon: 'Trash2', destructive: true, disabled: !editable, onPress: () => void actions.askArchive() },
    ];
    return <ActionMenu visible={visible} onClose={onClose} title={doc.name} items={items} />;
}
