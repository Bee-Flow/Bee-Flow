import { useState } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { inputClass } from './formPrimitives';

/**
 * The toggle + panel pair as the settings form mounts it (BFSF-481): the
 * sentence that used to be dead text is the control now.
 */
export default function JsonConfigSection({ draft, onApply }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    return (
        <>
            <div className="text-[11px] text-[var(--text-tertiary)]">
                <button
                    type="button"
                    data-testid="settings-json-toggle"
                    aria-expanded={open}
                    onClick={() => setOpen(o => !o)}
                    className="underline decoration-dotted underline-offset-2 hover:text-[var(--text-secondary)]"
                >
                    {/* Two words, not a sentence next to "Advanced" that read as a second
                        place for the same options. */}
                    {open ? t('automations.builder.json_view_close', 'Close the JSON view') : t('automations.builder.json_view_open', 'Edit as JSON')}
                </button>
            </div>
            {open && (
                <JsonConfigEditor
                    draft={draft}
                    onApply={(parsed) => { onApply(parsed); setOpen(false); }}
                    onClose={() => setOpen(false)}
                />
            )}
        </>
    );
}

/**
 * The JSON view of a step's settings (BFSF-481) — the working control behind
 * "Advanced options are available in the JSON view", which used to be dead
 * text. It edits the same draft the form edits, so an Apply is reviewed by
 * the same dirty-check and saved by the same Save/autosave path — this is an
 * escape hatch, not a second save channel.
 *
 * Raw text plus an explicit Apply, never a commit per keystroke (the same
 * contract as the output editor): half-typed JSON must not rewrite the form
 * underneath the user.
 */
function JsonConfigEditor({ draft, onApply, onClose }) {
    const { t } = useTranslation();
    const [text, setText] = useState(() => JSON.stringify(draft, null, 2));
    const [error, setError] = useState(null);

    const apply = () => {
        let parsed;
        try { parsed = JSON.parse(text); } catch (e) {
            setError(`Invalid JSON: ${e.message}`);
            return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            setError('The step config must be a JSON object.');
            return;
        }
        onApply(parsed);
    };

    return (
        <div className="rounded-md border border-[var(--border-subtle)] p-3 space-y-2" data-testid="settings-json-editor">
            <textarea
                aria-label={t('automations.json_config_editor.step_config_as_json', 'Step config as JSON')}
                value={text}
                onChange={(e) => { setText(e.target.value); if (error) setError(null); }}
                rows={Math.min(24, text.split('\n').length + 1)}
                spellCheck={false}
                className={inputClass() + ' font-mono text-[11px] leading-snug whitespace-pre'}
            />
            {error && (
                <div className="text-[11px] text-red-600 dark:text-red-400" role="alert">{error}</div>
            )}
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={apply}
                    className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90"
                >
                    {t('automations.json_config_editor.apply_json', 'Apply JSON')}
                </button>
                <button
                    type="button"
                    onClick={onClose}
                    className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                >
                    {t('automations.json_config_editor.back_to_the_form', 'Back to the form')}
                </button>
            </div>
        </div>
    );
}
