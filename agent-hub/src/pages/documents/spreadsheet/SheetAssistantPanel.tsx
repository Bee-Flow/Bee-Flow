// The assistant beside the grid: ask about the sheet, or tell it what to
// change. The conversation lives in useSheetAssistant (owned by the editor,
// so closing the panel does not lose it).

import { Sparkles, X } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import { ICON_BUTTON } from '../editor/ui';
import SheetAssistantComposer from './SheetAssistantComposer';
import SheetAssistantMessages, { Suggestions } from './SheetAssistantMessages';
import type { SelectionKind } from './sheetModel';
import type { AssistantTier } from './useAssistantTier';
import type { SheetAssistant } from './useSheetAssistant';

export interface SheetAssistantPanelProps {
    assistant: SheetAssistant;
    /** "B2:D9" or "C4": the selection that travels with a question. */
    selection: string | null;
    selectionKind?: SelectionKind;
    /** The depth slider's state (owned by the editor, shared with the inline ask). */
    tier: AssistantTier | null;
    readOnly: boolean;
    onClose: () => void;
}

/**
 * Beside the grid when the editor is wide enough (720px: the panel plus room for the grid),
 * else over the grid's right side: in a narrow container a 360px column would hide the grid.
 * Needs a `@container/sheet relative` parent (SpreadsheetEditor).
 */
export default function SheetAssistantPanel({ assistant, selection, selectionKind, tier, readOnly, onClose }: SheetAssistantPanelProps) {
    const { t } = useTranslation();
    const { messages, busy } = assistant;
    const ask = (text: string) => { assistant.send(text, selection, tier?.value ?? 'auto', selectionKind).catch(() => undefined); };
    return (
        <aside
            className="flex flex-col w-[360px] max-w-full shrink-0 min-h-0 h-full border-l border-[var(--border-subtle)] bg-[var(--bg-secondary)] absolute inset-y-0 right-0 z-30 shadow-2xl @[720px]/sheet:static @[720px]/sheet:shadow-none"
            aria-label={t('spreadsheet.assistant.title', 'Assistant')} data-testid="sheet-assistant"
        >
            <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-[var(--border-subtle)]">
                <Sparkles size={14} aria-hidden="true" className="text-[var(--accent-primary)]" />
                <h2 className="flex-1 m-0 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('spreadsheet.assistant.title', 'Assistant')}</h2>
                <button type="button" className={ICON_BUTTON} onClick={onClose} aria-label={t('spreadsheet.assistant.close', 'Close the assistant')}><X size={14} /></button>
            </div>
            {readOnly && <p className="shrink-0 m-0 px-3 py-2 text-[12px] text-[var(--text-secondary)] border-b border-[var(--border-subtle)]">{t('spreadsheet.assistant.read_only', 'View only: I can answer questions but not change cells.')}</p>}
            {messages.length === 0 && !busy
                ? <div className="flex-1 min-h-0 overflow-y-auto"><Suggestions onPick={ask} disabled={busy} /></div>
                : <SheetAssistantMessages messages={messages} busy={busy} onStop={assistant.stop} tiers={tier?.tiers ?? {}} readOnly={readOnly} onUndo={assistant.undo} />}
            <SheetAssistantComposer selection={selection} tier={tier} busy={busy} readOnly={readOnly} onSend={ask} />
        </aside>
    );
}
