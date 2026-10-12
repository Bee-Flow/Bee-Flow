/**
 * A library row's actions, as on the web: duplicate (which is also how a
 * template is used — the copy is a private document) and archive, which asks
 * first. Archiving keeps the versions an automation or an app still references.
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { ActionMenu, useToast } from '@/shared/ui';

import { useDeleteStudioDocument, useDuplicateStudioDocument } from '../hooks/mutations';
import { useArchiveConfirm } from '../hooks/useArchiveConfirm';
import type { StudioDocumentRow } from '../model/types';

export interface RowActionsProps {
    row: StudioDocumentRow | null;
    onClose: () => void;
    onOpen: (row: StudioDocumentRow) => void;
}

export function RowActions({ row, onClose, onOpen }: RowActionsProps) {
    const t = useTranslation();
    const confirmArchive = useArchiveConfirm();
    const { toast } = useToast();
    const onError = (error: Error) => toast(describeError(error).message, 'error');
    const duplicate = useDuplicateStudioDocument({
        onSuccess: (doc) => {
            if (doc) onOpen(doc);
        },
        onError,
    });
    const archive = useDeleteStudioDocument({
        onSuccess: () => toast(t('mobile.studio_documents.archived', 'Document archived'), 'success'),
        onError,
    });

    const askArchive = async (target: StudioDocumentRow) => {
        if (await confirmArchive(target.name)) archive.mutate(target.id);
    };

    return (
        <ActionMenu
            visible={row !== null}
            onClose={onClose}
            title={row?.name}
            items={
                row
                    ? [
                          { id: 'open', label: t('mobile.studio_documents.open', 'Open'), icon: 'FileText', onPress: () => onOpen(row) },
                          {
                              id: 'duplicate',
                              label: t('mobile.studio_documents.duplicate', 'Duplicate / use template'),
                              icon: 'Copy',
                              onPress: () => duplicate.mutate({ id: row.id, kind: 'document' }),
                          },
                          {
                              id: 'archive',
                              label: t('mobile.studio_documents.archive_document', 'Archive document'),
                              icon: 'Trash2',
                              destructive: true,
                              onPress: () => void askArchive(row),
                          },
                      ]
                    : []
            }
        />
    );
}
