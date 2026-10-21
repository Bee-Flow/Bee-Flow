import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Smartphone, Monitor, FileText, Flag, Zap } from 'lucide-react';
import FormBuilderFields, { THEME_PRESETS } from './FormBuilderFields';
import PublicFormRenderer, { FormEndingView } from '../../../../forms/PublicFormRenderer';
import { buildPreviewConfig } from './formPreview';
import type { FormPageEntry } from './formPages';
import { useTranslation } from '../../../../../hooks/useTranslation';

/**
 * The full-screen overview of an automation's hosted form: every page on the
 * left, the page being edited in the middle, what the visitor sees on the right.
 *
 * It owns no persistence. An edit goes to `onChangePage(id, nextForm)`, which the
 * host routes to the same place the side panel writes (the open step's draft for
 * the current page, a step patch for the others). Edits are held locally first so
 * the preview follows every keystroke, and handed on after a short pause so a
 * burst of typing is one save, not forty.
 */

const SAVE_DELAY_MS = 500;

// The editor is JavaScript whose props TypeScript infers from their defaults
// (`= null` becomes the type `null`), so it is typed here.
const Fields = FormBuilderFields as unknown as React.ComponentType<Record<string, unknown>>;
// KEPT: buildPreviewConfig builds from the stored form as read (`Loose`), so its
// `theme` is `unknown`, a field's `name`/`type` are not proven strings and
// `maxSizeMb` types as `{}`. Typing the renderer's `form` as FormDef needs guards
// in buildPreviewConfig first: a runtime change, not part of a types-only commit.
const Renderer = PublicFormRenderer as unknown as React.ComponentType<Record<string, unknown>>;
const EndingView = FormEndingView as unknown as React.ComponentType<Record<string, unknown>>;

type Form = Record<string, unknown>;

export interface FormEditorModalProps {
    pages: FormPageEntry[];
    /** The page whose panel the modal was opened from; also the first one shown. */
    currentId?: string | null;
    onChangePage: (id: string, next: Form) => void;
    onClose: () => void;
    previewSample?: unknown;
    onFocusField?: ((handle: unknown) => void) | null;
    /** Renaming a binding rewrites the graph; offered only for the page it is bound to. */
    onRenameField?: ((from: string, to: string) => number | undefined) | null;
}

export default function FormEditorModal({
    pages, currentId = null, onChangePage, onClose, previewSample = null, onFocusField = null, onRenameField = null,
}: FormEditorModalProps) {
    const { t } = useTranslation();
    const [selectedId, setSelectedId] = useState<string | null>(currentId && pages.some(p => p.id === currentId) ? currentId : (pages[0]?.id ?? null));
    const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
    const [local, setLocal] = useState<Record<string, Form>>({});
    const dialogRef = useRef<HTMLDivElement>(null);
    const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    const latest = useRef<Record<string, Form>>({});
    const onChangePageRef = useRef(onChangePage);
    useEffect(() => { onChangePageRef.current = onChangePage; });

    const flushAll = useCallback(() => {
        for (const [id, timer] of timers.current) {
            clearTimeout(timer);
            if (latest.current[id]) onChangePageRef.current(id, latest.current[id]);
        }
        timers.current.clear();
    }, []);
    // Close within the pause: the edit must still land.
    useEffect(() => flushAll, [flushAll]);

    const close = useCallback(() => { flushAll(); onClose(); }, [flushAll, onClose]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
            if (e.key !== 'Tab' || !dialogRef.current) return;
            // A light focus trap: Tab wraps inside the dialog.
            const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])'))
                .filter(el => !el.hasAttribute('disabled'));
            if (!items.length) return;
            const first = items[0], last = items[items.length - 1];
            const active = document.activeElement;
            if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) { e.preventDefault(); first.focus(); }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [close]);

    useEffect(() => { dialogRef.current?.focus(); }, []);

    const page = pages.find(p => p.id === selectedId) || pages[0] || null;
    const form: Form | null = page ? (local[page.id] || page.form) : null;
    const triggerTheme = useMemo(() => {
        const trig = pages.find(p => p.kind === 'trigger');
        return trig ? ((local[trig.id] || trig.form).theme as unknown) || null : null;
    }, [pages, local]);

    const change = (id: string, next: Form) => {
        latest.current[id] = next;
        setLocal(prev => ({ ...prev, [id]: next }));
        const old = timers.current.get(id);
        if (old) clearTimeout(old);
        timers.current.set(id, setTimeout(() => {
            timers.current.delete(id);
            onChangePageRef.current(id, latest.current[id]);
        }, SAVE_DELAY_MS));
    };

    const previewConfig = useMemo(() => {
        if (!page || !form) return null;
        return buildPreviewConfig({
            form,
            theme: (form.theme as unknown) || triggerTheme || THEME_PRESETS[0].theme,
            isEnding: page.kind === 'ending',
            allowVariables: page.allowVariables,
            previewSample,
            t,
        });
    }, [page, form, triggerTheme, previewSample, t]);

    const kindLabel = (p: FormPageEntry) => p.kind === 'trigger'
        ? t('automations.form_editor.page_start', 'Start')
        : p.kind === 'ending'
            ? t('automations.form_editor.page_ending', 'Closing page')
            : t('automations.form_editor.page_question', 'Page');

    const modal = (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50" data-testid="form-editor-backdrop">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label={t('automations.form_editor.title', 'Form editor')}
                tabIndex={-1}
                className="flex flex-col w-[95vw] h-[92vh] rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-2xl outline-none overflow-hidden"
            >
                <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-[var(--border-default)]">
                    <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t('automations.form_editor.title', 'Form editor')}</h2>
                    <button
                        type="button"
                        onClick={close}
                        aria-label={t('automations.form_editor.close', 'Close form editor')}
                        className="p-1.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className="flex flex-1 min-h-0">
                    <nav aria-label={t('automations.form_editor.pages', 'Form pages')} className="w-56 shrink-0 overflow-y-auto border-r border-[var(--border-default)] p-2 space-y-1">
                        {pages.length === 0 && (
                            <p className="text-[11px] text-[var(--text-tertiary)] italic p-2">{t('automations.form_editor.no_pages', 'This automation has no form pages yet.')}</p>
                        )}
                        {pages.map((p, i) => {
                            const active = p.id === page?.id;
                            const Icon = p.kind === 'trigger' ? Zap : p.kind === 'ending' ? Flag : FileText;
                            const title = (local[p.id]?.title as string) || p.label;
                            return (
                                <button
                                    key={p.id}
                                    type="button"
                                    onClick={() => setSelectedId(p.id)}
                                    aria-current={active ? 'page' : undefined}
                                    data-testid={`form-editor-page-${p.id}`}
                                    className={`w-full text-left flex items-start gap-2 rounded-md px-2 py-1.5 transition ${active ? 'bg-[var(--accent)]/12 text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}
                                >
                                    <Icon size={13} className="mt-0.5 shrink-0" />
                                    <span className="min-w-0">
                                        <span className="block text-xs font-medium truncate">{i + 1}. {title}</span>
                                        <span className="block text-[10px] text-[var(--text-tertiary)]">{kindLabel(p)}</span>
                                    </span>
                                </button>
                            );
                        })}
                    </nav>

                    <div className="flex-1 min-w-0 overflow-y-auto p-4" data-testid="form-editor-middle">
                        {page && form && (
                            <div className="mx-auto max-w-xl">
                                <Fields
                                    key={page.id}
                                    form={form}
                                    onChange={(next: Form) => change(page.id, next)}
                                    bindingBase={page.bindingBase}
                                    variant={page.kind === 'ending' ? 'ending' : 'input'}
                                    allowVariables={page.allowVariables}
                                    onFocusField={page.id === currentId ? onFocusField : null}
                                    previewSample={previewSample}
                                    onRenameField={page.id === currentId ? onRenameField : null}
                                    hidePreview
                                />
                            </div>
                        )}
                    </div>

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
                            {page && previewConfig && (
                                <div
                                    data-testid="form-editor-preview"
                                    data-device={device}
                                    className={`mx-auto w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] p-3 ${device === 'mobile' ? 'max-w-[390px]' : 'max-w-[600px]'}`}
                                >
                                    {page.kind === 'ending'
                                        ? <EndingView form={previewConfig} />
                                        : <Renderer form={previewConfig} preview />}
                                </div>
                            )}
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );

    if (typeof document === 'undefined') return null;
    return createPortal(modal, document.body);
}
