import React, { useState } from 'react';
import { Smartphone, Monitor } from 'lucide-react';
import PublicFormRenderer, { FormEndingView } from '@/components/forms/PublicFormRenderer';
import { canvasVars } from '@/components/forms/formStyleVars';
import { useTranslation } from '@/hooks/useTranslation';

// KEPT: the preview config is built from the stored form as read (`Loose`), so
// its `theme` is `unknown` and a field's `name`/`type` are not proven strings;
// see the note in FormEditorModal.
const Renderer = PublicFormRenderer as unknown as React.ComponentType<Record<string, unknown>>;
const EndingView = FormEndingView as unknown as React.ComponentType<Record<string, unknown>>;

/**
 * The form editor's right-hand side: what the visitor sees, at desktop or
 * mobile width, on the page ground the theme chose. Contained (isolate, paint
 * containment), so no custom CSS can paint outside the preview box.
 */
export default function FormEditorPreview({ kind, config }: { kind: string | null; config: Record<string, unknown> | null }) {
    const { t } = useTranslation();
    const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
    return (
        <section aria-label={t('automations.form_editor.preview', 'Preview')} className="w-[44%] max-w-[640px] shrink-0 border-l border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-y-auto">
            <div className="sticky top-0 z-10 flex items-center justify-between gap-2 px-3 py-2 bg-[var(--bg-secondary)] border-b border-[var(--border-default)]">
                <span className="text-[11px] font-medium text-[var(--text-secondary)]">{t('automations.form_editor.preview', 'Preview')}</span>
                <div className="inline-flex rounded-md border border-[var(--border-default)] overflow-hidden" role="group" aria-label={t('automations.form_editor.device', 'Preview width')}>
                    <button
                        type="button"
                        aria-pressed={device === 'desktop'}
                        aria-label={t('automations.form_editor.desktop', 'Desktop')}
                        onClick={() => setDevice('desktop')}
                        className={`p-1.5 ${device === 'desktop' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]'}`}
                    >
                        <Monitor size={13} />
                    </button>
                    <button
                        type="button"
                        aria-pressed={device === 'mobile'}
                        aria-label={t('automations.form_editor.mobile', 'Mobile')}
                        onClick={() => setDevice('mobile')}
                        className={`p-1.5 ${device === 'mobile' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]'}`}
                    >
                        <Smartphone size={13} />
                    </button>
                </div>
            </div>
            <div className="p-4">
                {kind && config && (
                    <div
                        data-testid="form-editor-preview"
                        data-device={device}
                        // The page ground (the theme's canvas) around the form, as the
                        // visitor sees it; contained, so no custom CSS can paint outside it.
                        style={canvasVars(config.theme)}
                        className={`mx-auto w-full rounded-md border border-[var(--border-default)] [background:var(--app-canvas,var(--bg-primary))] p-3 relative isolate overflow-hidden [contain:paint] ${device === 'mobile' ? 'max-w-[390px]' : 'max-w-[600px]'}`}
                    >
                        {kind === 'ending'
                            ? <EndingView form={config} />
                            : <Renderer form={config} preview />}
                    </div>
                )}
            </div>
        </section>
    );
}
