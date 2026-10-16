import React from 'react';
import type { ComponentType } from 'react';
import ExperimentMark from './ExperimentMark';
import { experimentAttrs, resolveBlock } from './experiment';

export { experimentAttrs };

interface ExperimentSectionProps {
    Comp: ComponentType<{ data: Record<string, unknown> }>;
    block: { type?: string; enabled?: boolean; content?: object };
    preview: boolean;
}

/**
 * Renders one block's section. When the block carries a live A/B test it
 * draws the variant (experiment.ts) and renders that variant's content, plus
 * a marker that reports the view and listens for the goal. It adds NO wrapper
 * element: the experiment's data attributes sit on the block wrapper itself
 * (experimentAttrs, in ProductWebsite), so the `.cms-block-wrap > *` layout
 * rules keep applying to the section.
 */
export default function ExperimentSection({ Comp, block, preview }: ExperimentSectionProps) {
    const { content, experiment } = resolveBlock(block.content as Record<string, unknown> | undefined, { preview, type: block.type });
    const section = <Comp data={{ enabled: block.enabled !== false, ...content }} />;
    if (!experiment) return section;
    return (
        <>
            {section}
            <ExperimentMark experiment={experiment.key} variant={experiment.variant} />
        </>
    );
}
