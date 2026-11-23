/**
 * "Preview" under a form in a chat: the document with what is filled in so
 * far, in a dialog (FilledPreview.tsx). The editor has the same page next to
 * its form; a chat has no room beside the answer, so there it opens on request.
 * What was typed a moment ago is saved first, so the page shows it.
 */
import { useState } from 'react';
import { Eye } from 'lucide-react';

import type { FillDocument, TemplateFillApi } from '@/api/templateFillApi';
import Modal from '@/components/shared/Modal';
import useTranslation from '@/hooks/useTranslation';
import FilledPreview from './FilledPreview';
import { FILL_SECONDARY } from './fillStyles';

export default function PreviewButton({ doc, load, flush }: {
    doc: FillDocument;
    load: NonNullable<TemplateFillApi['preview']>;
    /** Save what is typed and not sent yet. */
    flush: () => Promise<unknown>;
}) {
    const { t } = useTranslation();
    // Each opening reads the page anew: `round` is its revision.
    const [view, setView] = useState({ open: false, round: 0 });
    const open = async () => {
        await flush();
        setView((v) => ({ open: true, round: v.round + 1 }));
    };
    const close = () => setView((v) => ({ ...v, open: false }));
    const label = t('chat_templates.preview_title', 'Preview');
    return (
        <>
            <button type="button" onClick={() => { void open(); }} data-testid="template-fill-preview" className={FILL_SECONDARY}>
                <Eye size={15} aria-hidden="true" />{label}
            </button>
            <Modal open={view.open} onClose={close} title={doc.name} size="xl" data-testid="template-fill-preview-dialog">
                <div className="h-[70vh] overflow-hidden rounded-lg border border-[var(--border-subtle)]">
                    <FilledPreview documentId={doc.id} revision={String(view.round)} load={load} onEscape={close} />
                </div>
            </Modal>
        </>
    );
}
