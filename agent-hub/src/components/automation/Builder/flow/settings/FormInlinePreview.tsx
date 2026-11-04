import React from 'react';
import type { ComponentProps } from 'react';
import PublicFormRenderer, { FormEndingView } from '@/components/forms/PublicFormRenderer';

type RendererProps = ComponentProps<typeof PublicFormRenderer>;

/**
 * The fields editor's inline preview: the same renderer the visitor gets.
 * Its own module, loaded when the author opens the preview, so the canvas
 * (and the public demo page) does not carry the renderer and its form state.
 * Inert unless the host handed a way to run the trigger with what is typed
 * into it; `showSuccess` stays off for a test run, because swapping the form
 * for its thank-you page would take away the thing being tested.
 */
export default function FormInlinePreview({ form, isEnding, onTestSubmit }: {
    form: RendererProps['form'];
    isEnding: boolean;
    onTestSubmit: RendererProps['onSubmit'] | null | undefined;
}) {
    if (isEnding) return <FormEndingView form={form} />;
    return <PublicFormRenderer form={form} preview={!onTestSubmit} onSubmit={onTestSubmit ?? undefined} showSuccess={false} />;
}
