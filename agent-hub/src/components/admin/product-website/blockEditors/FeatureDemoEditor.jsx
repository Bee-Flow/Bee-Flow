import React from 'react';
import { DEMO_FEATURES, DEMO_FEATURE_IDS } from '../../../../demo/registry';
import { useTranslation } from '../../../../hooks/useTranslation';
import { TextField, TextArea, FieldRow } from '../fields';
import { CollapsibleCard, InlineHint, FieldSelect, SegmentedControl } from '../primitives';

/**
 * Editor for the Live feature demo block.
 *
 * The feature is a SELECT over the demo registry, never a URL field. That is
 * the whole security posture of this block in one control: an editor can
 * choose which of our demos to show, and cannot point the frame anywhere
 * else. Adding an option means registering a demo in code.
 */
export function FeatureDemoEditor({ data, onChange }) {
    const { t } = useTranslation();
    const set = (key, value) => onChange({ ...data, [key]: value });
    const feature = DEMO_FEATURES[data.feature];
    const height = Number.isFinite(data.height) ? data.height : 720;

    return (
        <div className="space-y-4">
            <CollapsibleCard title={t('cms_site.blocks.feature_demo.which_demo', 'Which demo')} persistKey="blk.featureDemo.which" defaultOpen>
                <InlineHint>
                    {t('cms_site.blocks.feature_demo.the_frame_runs_the_real_product_interface', 'The frame runs the real product interface on sample data. It cannot reach the network, so nothing a visitor types is sent anywhere or stored.')}
                </InlineHint>
                <FieldSelect
                    label={t('cms_site.blocks.feature_demo.feature', 'Feature')}
                    value={data.feature || ''}
                    onChange={v => set('feature', v)}
                    options={[
                        { value: '', label: t('cms_site.blocks.feature_demo.pick_a_feature', '— pick a feature —') },
                        ...DEMO_FEATURE_IDS.map(id => ({ value: id, label: DEMO_FEATURES[id].label })),
                    ]}
                    hint={feature ? feature.blurb : t('cms_site.blocks.feature_demo.the_block_renders_a_placeholder_until', 'The block renders a placeholder until a feature is picked.')}
                />
            </CollapsibleCard>

            <CollapsibleCard title={t('cms_site.blocks.feature_demo.heading', 'Heading')} persistKey="blk.featureDemo.head" defaultOpen>
                <TextField label={t('cms_site.blocks.feature_demo.eyebrow', 'Eyebrow')} value={data.eyebrow || ''} onChange={v => set('eyebrow', v)} placeholder={t('cms_site.blocks.feature_demo.live_demo', 'Live demo')} />
                <TextField label={t('cms_site.blocks.feature_demo.title', 'Title')} value={data.title || ''} onChange={v => set('title', v)} placeholder={t('cms_site.blocks.feature_demo.try_it_right_here', 'Try it right here')} />
                <TextArea label={t('cms_site.blocks.feature_demo.lead', 'Lead')} value={data.lead || ''} onChange={v => set('lead', v)} rows={2} />
            </CollapsibleCard>

            <CollapsibleCard title={t('cms_site.blocks.feature_demo.frame', 'Frame')} persistKey="blk.featureDemo.frame">
                <FieldRow label={t('cms_site.blocks.feature_demo.height', 'Height')} hint={t('cms_site.blocks.feature_demo.320_1200px_tall_enough_that_the', '320–1200px. Tall enough that the app is not squeezed into a letterbox.')}>
                    <input
                        type="number"
                        min={320}
                        max={1200}
                        step={20}
                        value={height}
                        onChange={(e) => {
                            const n = parseInt(e.target.value, 10);
                            set('height', Number.isFinite(n) ? Math.min(Math.max(n, 320), 1200) : 720);
                        }}
                        className="w-full px-2 py-1.5 text-sm rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[var(--text-primary)]"
                    />
                </FieldRow>
                <FieldRow label={t('cms_site.blocks.feature_demo.demo_theme', 'Demo theme')} hint={t('cms_site.blocks.feature_demo.matches_the_frame_to_the_band', 'Matches the frame to the band it sits on.')}>
                    <SegmentedControl
                        value={data.theme === 'dark' ? 'dark' : 'light'}
                        onChange={v => set('theme', v)}
                        options={[{ value: 'light', label: t('cms_site.blocks.feature_demo.theme_light', 'Light') }, { value: 'dark', label: t('cms_site.blocks.feature_demo.theme_dark', 'Dark') }]}
                    />
                </FieldRow>
                <TextArea
                    label={t('cms_site.blocks.feature_demo.note_under_the_frame', 'Note under the frame')}
                    value={data.note || ''}
                    onChange={v => set('note', v)}
                    rows={2}
                    hint={t('cms_site.blocks.feature_demo.keep_this_honest_about_the_demo', 'Keep this honest about the demo being sample data — a visitor should never wonder whether what they typed was saved.')}
                />
            </CollapsibleCard>
        </div>
    );
}

export default FeatureDemoEditor;
