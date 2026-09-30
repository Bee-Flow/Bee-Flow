/**
 * A spec's sections as the step's accordion bands (nodeEditor Section — Simple
 * mode, forced-open errors, the "set" badge), each field through
 * FieldRenderer: the declarative editor's body, and a bespoke editor's plain
 * bands. A section with nothing to show for this draft is left out, as the
 * web's editors leave out the rows a mode does not use.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Section } from '@/features/flow-editor/components/nodeEditor/Section';
import { Text } from '@/shared/ui';

import type { StepEditorProps } from '../types';
import { FieldRenderer } from './FieldRenderer';
import { fieldId, isVisible, say } from './runtime';
import type { SectionSpec, SpecContext } from './spec';

function opens(section: SectionSpec, draft: StepEditorProps['draft'], ctx: SpecContext): boolean {
    const d = section.defaultOpen;
    return typeof d === 'function' ? d(draft, ctx) : d === true;
}

/** A spec's sections as the step's bands — the declarative editor's body, and a bespoke editor's plain bands. */
export function SpecSections({ sections, step, draft, setMany, ctx: editorCtx }: StepEditorProps & { sections: readonly SectionSpec[] }) {
    const t = useTranslation();
    const ctx: SpecContext = { ...editorCtx, step };
    return (
        <>
            {sections.map((section) => {
                const fields = section.fields.filter((f) => isVisible(f, draft, ctx));
                if (!fields.length) return null;
                return (
                    <Section
                        key={section.key}
                        stepType={String(step.type)}
                        sectionKey={section.key}
                        title={say(t, section.title)}
                        ctx={ctx}
                        defaultOpen={opens(section, draft, ctx)}
                        hasContent={section.hasContent?.(draft, ctx) ?? false}
                    >
                        {section.intro ? (
                            <Text variant="caption" tone="tertiary">
                                {say(t, section.intro)}
                            </Text>
                        ) : null}
                        {fields.map((f) => (
                            <FieldRenderer key={fieldId(f)} field={f} draft={draft} ctx={ctx} onDraft={setMany} />
                        ))}
                    </Section>
                );
            })}
        </>
    );
}
