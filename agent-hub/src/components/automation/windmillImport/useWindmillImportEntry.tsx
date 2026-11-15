import { useState } from 'react';
import WindmillImportDialog from './WindmillImportDialog';
import type { DesignerState } from '../useDesignerShell';

/**
 * "Import from Windmill": the dialog, and what its buttons do here. "Complete
 * with AI" opens the AI builder on the imported draft with the briefing in its
 * input box (the person sends it; nothing runs or goes live by itself);
 * "Open in the builder" just opens the draft.
 */
export default function useWindmillImportEntry(d: DesignerState, refresh: () => unknown) {
    const [open, setOpen] = useState(false);
    const openDraft = (automationId: string, brief: string) => {
        setOpen(false);
        d.setAutoSendInput(null);
        d.setPatternOrigin(null);
        d.setBuilderInitialTab(null);
        d.setPresetChatInput(brief);
        d.setBuilderAutomationId(automationId);
    };
    const dialog = (
        <WindmillImportDialog
            open={open}
            onClose={() => setOpen(false)}
            onImported={() => { void refresh(); }}
            onCompleteWithAi={openDraft}
            onOpenAutomation={(id) => openDraft(id, '')}
        />
    );
    return { openDialog: () => setOpen(true), dialog };
}
