import React, { Suspense, useMemo, useState } from 'react';
import { lazyWithI18n } from '../../../../../utils/lazyWithReload';
import FormBuilderFields from './FormBuilderFields';
import type { FormPageEntry } from './formPages';

// The full-screen editor carries the live form preview; load it when it is opened.
const FormEditorModal = lazyWithI18n(() => import('./FormEditorModal'));

/**
 * What the node drawer hands down so a form page can open the full-screen
 * editor: every form page of the automation, and a way to save ANOTHER page.
 * Null where the whole automation is not in scope (the standalone Forms editor,
 * tests) — the "Open form editor" button is then simply not offered.
 */
export interface FormEditorContext {
    pages: FormPageEntry[];
    savePage: (id: string, form: Record<string, unknown>) => unknown;
    /** Trigger only: open the form over the canvas and run it. */
    onTestForm?: (() => void) | null;
}

type Form = Record<string, unknown>;

// The editor is JavaScript whose props TypeScript infers from its defaults.
const Fields = FormBuilderFields as unknown as React.ComponentType<Record<string, unknown>>;

/**
 * FormBuilderFields plus the modal that goes with it. Edits made in the modal
 * to THIS step's page go through `onChange` (the drawer's own draft and
 * autosave); edits to any other page go through `formEditor.savePage`.
 */
export default function FormPageEditor({ form, onChange, stepId = null, formEditor = null, ...rest }: {
    form: Form;
    onChange: (next: Form) => void;
    stepId?: string | null;
    formEditor?: FormEditorContext | null;
    [key: string]: unknown;
}) {
    const [open, setOpen] = useState(false);
    const canOpen = !!formEditor && formEditor.pages.length > 0 && !!stepId;
    // The side panel's draft is newer than the saved definition: show it.
    const pages = useMemo(
        () => (formEditor?.pages || []).map(p => (p.id === stepId ? { ...p, form } : p)),
        [formEditor, stepId, form],
    );
    return (
        <>
            <Fields
                form={form}
                onChange={onChange}
                onOpenEditor={canOpen ? () => setOpen(true) : null}
                onTestForm={formEditor?.onTestForm || null}
                {...rest}
            />
            {open && formEditor && (
                <Suspense fallback={null}>
                <FormEditorModal
                    pages={pages}
                    currentId={stepId}
                    onChangePage={(id, next) => { if (id === stepId) onChange(next); else formEditor.savePage(id, next); }}
                    onClose={() => setOpen(false)}
                    previewSample={rest.previewSample}
                    onFocusField={rest.onFocusField as ((h: unknown) => void) | null | undefined}
                    onRenameField={rest.onRenameField as ((a: string, b: string) => number | undefined) | null | undefined}
                />
                </Suspense>
            )}
        </>
    );
}
