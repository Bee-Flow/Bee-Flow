import { FileText } from 'lucide-react';
import { useRef, useState } from 'react';
import useTranslation from '../hooks/useTranslation';
import DocumentPickerPopover from './DocumentPickerPopover';

interface Props {
    sidePanelDocumentId: string | null;
    openDocumentInSidePanel: (id: string) => void;
    closeDocumentPanel: () => void;
}

/** The chat header's "Documents" button: closes the open document, or opens the picker. */
export default function DocumentsHeaderButton({ sidePanelDocumentId, openDocumentInSidePanel, closeDocumentPanel }: Props) {
    const { t } = useTranslation();
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const isOpen = Boolean(sidePanelDocumentId);
    const label = isOpen ? t('chat.documents_close', 'Close') : t('chat.documents_button', 'Documents');

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                aria-haspopup="dialog"
                aria-expanded={pickerOpen && !isOpen}
                onClick={() => {
                    if (isOpen) closeDocumentPanel();
                    else setPickerOpen((v) => !v);
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors border text-xs font-medium ${isOpen ? 'bg-[var(--accent-primary)]/10 text-[var(--accent-primary)] border-[var(--accent-primary)]/30' : 'bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border-[var(--border-subtle)]'}`}
                title={label}
            >
                <FileText className="w-3.5 h-3.5" />
                {label}
            </button>
            <DocumentPickerPopover
                anchorRef={buttonRef}
                open={pickerOpen && !isOpen}
                onClose={() => setPickerOpen(false)}
                onSelect={openDocumentInSidePanel}
            />
        </>
    );
}
