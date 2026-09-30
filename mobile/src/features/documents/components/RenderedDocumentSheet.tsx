/**
 * A generated PDF, offered to the apps that can open it.
 *
 * The bytes are fetched through the session cookie and handed to the OS —
 * never a bare Linking call, because an external viewer has a different
 * cookie jar and would be bounced to the login page.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { shareServerFile } from '@/core/api/shareFile';
import { timeAgo, useTranslation } from '@/core/i18n';
import { PreviewSheet } from '@/features/knowledge';
import { formatBytes } from '@/shared/lib/bytes';
import { useToast } from '@/shared/ui';

import type { RenderedDocument } from '../model/types';

export function RenderedDocumentSheet({ doc, onClose }: { doc: RenderedDocument | null; onClose: () => void }) {
    const t = useTranslation();
    const { toast } = useToast();
    const [busy, setBusy] = useState(false);

    const open = async (target: RenderedDocument) => {
        setBusy(true);
        try {
            await shareServerFile(target.viewUrl, target.name, 'application/pdf');
        } catch (err) {
            toast(describeError(err).message, 'error');
        } finally {
            setBusy(false);
        }
    };

    return (
        <PreviewSheet
            visible={Boolean(doc)}
            onClose={onClose}
            title={doc?.name ?? ''}
            subtitle={
                doc
                    ? `${formatBytes(doc.sizeBytes)} · ${t('mobile.documents.rendered_when', 'rendered {when}', { when: timeAgo(doc.createdAt, { suffix: true }) })}`
                    : undefined
            }
            kind="binary"
            busyAction={busy}
            onOpenWith={() => {
                if (doc) void open(doc);
            }}
        />
    );
}
