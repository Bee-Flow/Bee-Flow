import React from 'react';
import DocumentEditor from '../../pages/documents/DocumentEditor';

/**
 * A document in the right-hand chat slot — the sibling of SideWebpagePanel.
 *
 * WHY IT IS FULLY EDITABLE HERE, when SideWebpagePanel is read-only and sends
 * you to Studio to edit. A webpage is a project you build; a document is a page
 * you correct. The whole point of the feature is that the AI drafts an invoice
 * and you fix the amount — asking someone to leave the conversation to change
 * one number would put the chat and the artefact on opposite screens, which is
 * exactly what this panel exists to avoid. So it hosts the real editor,
 * autosave and all, and the expand button is a convenience rather than the
 * place the work happens.
 *
 * A thin wrapper on purpose: forking DocumentEditor would have meant two
 * autosave implementations, and the copy nobody maintains would be this one —
 * the one people actually reach, since a chat link lands here.
 */
export default function SideDocumentPanel({ documentId, onClose, onNavigate }) {
    return (
        <DocumentEditor
            key={documentId}
            documentId={documentId}
            variant="panel"
            onBack={onClose}
            onOpenInStudio={(id) => {
                // Hand the document over to the full screen and close the slot,
                // so the same document is not open twice with two autosavers.
                onClose?.();
                onNavigate?.(`studio/documents/${id}`);
            }}
        />
    );
}
