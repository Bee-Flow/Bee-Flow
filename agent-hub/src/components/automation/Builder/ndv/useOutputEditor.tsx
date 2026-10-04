// "Edit output" (BFSF-408/409): write a step's output by hand so the steps
// after it can be built and tested before it has ever run. Moved out of
// NodeDetailView unchanged. Raw text plus an explicit Apply, never a commit
// per keystroke: every definition save writes a full version snapshot.
import { Pencil } from 'lucide-react';
import { useState } from 'react';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { isTruncatedOutput } from '../mapping/realOutputs';
import { MAX_PINNED_BYTES, jsonByteLength, safeJsonText } from '../outputDrafts';
import OutputEditorPanel from '../OutputEditorPanel';

const isTruncated = isTruncatedOutput as (v: unknown) => boolean;

export default function useOutputEditor({
    t, runStepOutput, pinnedOutput, describedSample, emptyFormAnswers, outputPinned, outputEdited,
    canEditOutput, saving, persistStepPatch, onOpened,
}: {
    t: TranslateFn;
    runStepOutput: unknown;
    pinnedOutput: unknown;
    describedSample: unknown;
    emptyFormAnswers: unknown;
    outputPinned: boolean;
    outputEdited: boolean;
    canEditOutput: boolean;
    saving: boolean;
    persistStepPatch: (patch: Record<string, unknown>) => Promise<void>;
    onOpened: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [text, setText] = useState('');
    const [error, setError] = useState<string | null>(null);

    const close = () => { setOpen(false); setError(null); };
    const openEditor = () => {
        setText(safeJsonText(runStepOutput ?? pinnedOutput ?? describedSample ?? {}));
        setError(null);
        setOpen(true);
        // The quick strip is collapsible; opening the editor into an invisible
        // panel would be the "nothing happened" bug the strip was added to fix.
        onOpened();
    };
    const fillWithEmptyAnswers = () => {
        if (!emptyFormAnswers) return;
        setText(safeJsonText(emptyFormAnswers));
        setError(null);
    };
    const apply = async () => {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch (e) {
            setError(t('automations.ndv.err_invalid_json', 'Invalid JSON: {message}', { message: (e as Error).message }));
            return;
        }
        if (parsed === null) {
            setError(t('automations.ndv.err_nothing_to_save', 'Nothing to save — use {remove} to clear the saved output.', { remove: t('common.remove', 'Remove') }));
            return;
        }
        if (isTruncated(parsed)) {
            setError(t('automations.ndv.err_truncated_placeholder', 'That is the server\'s "output too large" placeholder, not data. Replace it with the shape the next steps should see.'));
            return;
        }
        // Capped BEFORE the PUT: the drawer PUTs the whole definition on every
        // save, so one oversized pin would 400 every later, unrelated edit.
        const bytes = jsonByteLength(parsed);
        if (bytes == null) { setError(t('automations.ndv.err_not_json', 'That value cannot be stored as JSON.')); return; }
        if (bytes > MAX_PINNED_BYTES) {
            setError(t(
                'automations.ndv.err_too_big',
                'Too big to save: {size} KB, and the limit is {limit} KB. '
                + 'Keep a representative record or two — what the steps downstream map against is the shape, not the volume.',
                { size: Math.ceil(bytes / 1024), limit: MAX_PINNED_BYTES / 1024 },
            ));
            return;
        }
        try {
            await persistStepPatch({ pinnedOutput: parsed, pinnedAt: new Date().toISOString(), pinnedSource: 'edited' });
            setOpen(false);
            setError(null);
        } catch (e) {
            setError((e as Error)?.message || t('automations.ndv.save_failed', 'Save failed'));
        }
    };
    const remove = async () => {
        try {
            await persistStepPatch({ pinnedOutput: null, pinnedAt: null, pinnedSource: undefined });
            setOpen(false);
            setError(null);
        } catch { /* the save chip in the header reports it */ }
    };

    const editor = (
        <OutputEditorPanel
            text={text}
            error={error}
            saving={saving}
            canRemove={outputPinned}
            onEmptyAnswers={emptyFormAnswers ? fillWithEmptyAnswers : null}
            onChange={(v: string) => { setText(v); if (error) setError(null); }}
            onApply={apply}
            onRemove={remove}
            onCancel={close}
        />
    );
    const button = canEditOutput ? (
        <button
            type="button"
            data-testid="ndv-edit-output"
            onClick={open ? close : openEditor}
            aria-expanded={open}
            title={t('automations.ndv.edit_output_hint', "Write this step's output by hand, so the steps after it can be built and tested before this one has ever run")}
            className={`inline-flex items-center gap-1 normal-case tracking-normal text-[11px] px-2 py-0.5 rounded border transition ${
                outputEdited
                    ? 'border-[var(--pinned)] text-[var(--pinned)] bg-[color-mix(in_srgb,var(--pinned)_15%,transparent)]'
                    : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'}`}
        >
            <Pencil size={11} /> {outputEdited ? t('automations.ndv.edited', 'Edited') : t('automations.ndv.edit', 'Edit')}
        </button>
    ) : null;

    return { open, editor, button };
}
