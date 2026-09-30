/**
 * One of a step's accordion sections (nodeEditor Section) with the step type
 * and the editor context already wired — the band every bespoke step editor
 * is built from, so each one reads like the web editor it ports and none
 * repeats the node editor's plumbing. Its siblings: SpecFields (plain fields
 * as declarative specs), Note (a standing sentence) and Warn (a caution).
 */

import React, { type ReactNode } from 'react';

import { Section } from '@/features/flow-editor/components/nodeEditor/Section';

import type { StepEditorProps } from '../types';

export function Band({
    editor,
    sectionKey,
    title,
    defaultOpen = false,
    hasContent = false,
    children,
}: {
    editor: StepEditorProps;
    sectionKey: string;
    title: string;
    defaultOpen?: boolean;
    hasContent?: boolean;
    children: ReactNode;
}) {
    return (
        <Section
            stepType={String(editor.step.type)}
            sectionKey={sectionKey}
            title={title}
            ctx={editor.ctx}
            defaultOpen={defaultOpen}
            hasContent={hasContent}
        >
            {children}
        </Section>
    );
}
