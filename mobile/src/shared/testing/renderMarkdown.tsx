/**
 * Render a Markdown answer the way a screen does — inside the providers and
 * the toast host — for the Markdown module's own tests. Test-only; nothing in
 * the app imports this.
 */

import React from 'react';

import { Markdown } from '@/shared/markdown';
import { ToastProvider } from '@/shared/ui';

import { renderWithProviders } from './renderWithProviders';

export async function renderMarkdown(value: string, options: { streaming?: boolean } = {}): Promise<void> {
    await renderWithProviders(
        <ToastProvider>
            <Markdown value={value} streaming={options.streaming} />
        </ToastProvider>,
    );
}

/** A fenced block, as a model writes one. */
export function fence(language: string, body: string, closed = true): string {
    return `\`\`\`${language}\n${body}${closed ? '\n```' : ''}`;
}
