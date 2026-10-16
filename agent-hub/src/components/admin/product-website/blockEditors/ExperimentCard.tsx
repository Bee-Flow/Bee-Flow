import React from 'react';
import type { ComponentType } from 'react';
import { TextField } from '../fields';
import { CollapsibleCard, InlineHint, SegmentedControl, mintId } from '../primitives';
import { Toggle } from '../fields';
import type { BlockEditorWithPagesProps } from './editorProps';
import type { BlockData } from './shared';
import { AB_KEYS, DEFAULT_GOAL, diffAlternative, stripExperiment } from '../../../../marketing/experiments/experiment';
import { useTranslation } from '../../../../hooks/useTranslation';

type EditorProps = BlockEditorWithPagesProps;
type Side = 'original' | 'alternative';

const asObject = (v: unknown): BlockData => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as BlockData : {});

/** The A/B test settings of one block, plus the block's own editor pointed at the alternative. */
function ExperimentCard({ Inner, props }: { Inner: ComponentType<EditorProps>; props: EditorProps }) {
    const { t } = useTranslation();
    const [side, setSide] = React.useState<Side>('original');
    const data: BlockData = props.data || {};
    const on = typeof data.abKey === 'string' && data.abKey !== '';
    const alt = asObject(data.abAlt);
    const patch = (next: BlockData) => props.onChange({ ...data, ...next });

    const toggle = (enable: boolean) => {
        if (enable) {
            patch({ abKey: mintId('ab'), abAlt: {}, abShare: 50 });
        } else {
            const rest: BlockData = { ...data };
            for (const k of AB_KEYS) delete rest[k];
            props.onChange(rest);
            setSide('original');
        }
    };

    return (
        <CollapsibleCard title={t('cms_site.blocks.experiment.title', 'A/B test')} persistKey="blk.experiment">
            <InlineHint>{t('cms_site.blocks.experiment.hint', 'Show a share of the page views an alternative version of this block and compare how often visitors click through. Nothing is stored in the visitor\'s browser, no cookies and no identifier; results count page views, not people.')}</InlineHint>
            <Toggle label={t('cms_site.blocks.experiment.enable', 'Test an alternative for this block')} value={on} onChange={toggle} />
            {on ? (
                <>
                    <TextField
                        label={t('cms_site.blocks.experiment.name', 'Test name')}
                        value={String(data.abKey)}
                        onChange={v => patch({ abKey: v.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40) })}
                        hint={t('cms_site.blocks.experiment.name_hint', 'Shown in the analytics report. Letters, digits, - and _.')}
                    />
                    <TextField
                        label={t('cms_site.blocks.experiment.share', 'Share that sees the alternative (%)')}
                        value={String(typeof data.abShare === 'number' ? data.abShare : 50)}
                        onChange={v => patch({ abShare: Math.min(99, Math.max(1, Math.round(Number(v)) || 50)) })}
                    />
                    <TextField
                        label={t('cms_site.blocks.experiment.goal', 'Goal event name')}
                        value={typeof data.abGoal === 'string' ? data.abGoal : ''}
                        onChange={v => patch({ abGoal: v.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40) })}
                        placeholder={DEFAULT_GOAL}
                        hint={t('cms_site.blocks.experiment.goal_hint', 'Counted when a visitor clicks a button or link in this block, or submits a form in it.')}
                    />
                    <SegmentedControl<Side>
                        value={side}
                        onChange={setSide}
                        options={[
                            { value: 'original', label: t('cms_site.blocks.experiment.original', 'Original') },
                            { value: 'alternative', label: t('cms_site.blocks.experiment.alternative', 'Alternative') },
                        ]}
                    />
                    {side === 'alternative' ? (
                        <>
                            <InlineHint>{t('cms_site.blocks.experiment.alt_hint', 'Change what should differ. Fields you leave as they are follow the original.')}</InlineHint>
                            <Inner
                                {...props}
                                data={{ ...stripExperiment(data), ...alt }}
                                onChange={next => patch({ abAlt: diffAlternative(data, next) })}
                            />
                        </>
                    ) : null}
                </>
            ) : null}
        </CollapsibleCard>
    );
}

/** A block editor with the A/B test card underneath. */
export function withExperiment(Editor: ComponentType<never>): ComponentType<EditorProps> {
    const Inner = Editor as ComponentType<EditorProps>;
    return function EditorWithExperiment(props: EditorProps) {
        return (
            <>
                <Inner {...props} />
                <div className="mt-4"><ExperimentCard Inner={Inner} props={props} /></div>
            </>
        );
    };
}
