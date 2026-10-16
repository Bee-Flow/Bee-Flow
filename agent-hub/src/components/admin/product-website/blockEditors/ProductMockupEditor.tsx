import { RepeatableList, TextArea, TextField, Toggle } from '../fields';
import { BackgroundCard, FieldSelect, InlineHint } from '../primitives';
import type { BlockEditorProps } from './editorProps';
import { set, SectionHeaderFields } from './shared';
import type { SectionHeaderData } from './shared';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── Product mockup ────────────────────────────────────────────────────
//
// The app drawn as a tilted panel in which `prompt` types itself and `steps`
// appear one by one. Everything is text, so it translates and needs no video.

type MockupStep = { role?: string; title?: string; text?: string };
type ProductMockupData = SectionHeaderData & {
    tilt?: string;
    scrollTilt?: boolean;
    windowTitle?: string;
    prompt?: string;
    steps?: MockupStep[];
};

export function ProductMockupEditor({ data = {}, onChange }: BlockEditorProps<ProductMockupData>) {
    const { t } = useTranslation();
    return (
        <>
            <InlineHint>{t('cms_site.blocks.product_mockup.hint', 'A tilted app panel where the prompt types itself and the answer builds up step by step. Visitors who prefer reduced motion see the finished state at once.')}</InlineHint>
            <SectionHeaderFields data={data} onChange={onChange} persistScope="product-mockup" />
            <TextField
                label={t('cms_site.blocks.product_mockup.window_title', 'Window title')}
                value={data.windowTitle || ''}
                onChange={(v: string) => onChange(set(data, 'windowTitle', v))}
            />
            <TextArea
                label={t('cms_site.blocks.product_mockup.prompt', 'Prompt that types itself')}
                value={data.prompt || ''}
                onChange={(v: string) => onChange(set(data, 'prompt', v))}
                rows={2}
            />
            <FieldSelect
                label={t('cms_site.blocks.product_mockup.tilt', 'Tilt')}
                value={data.tilt || 'right'}
                options={[
                    { value: 'right', label: t('cms_site.blocks.product_mockup.tilt_right', 'Tilted to the right') },
                    { value: 'left', label: t('cms_site.blocks.product_mockup.tilt_left', 'Tilted to the left') },
                    { value: 'none', label: t('cms_site.blocks.product_mockup.tilt_none', 'Flat') },
                ]}
                onChange={(v: string) => onChange(set(data, 'tilt', v))}
            />
            <Toggle
                label={t('cms_site.blocks.product_mockup.scroll_tilt', 'Flatten while scrolling')}
                value={data.scrollTilt === true}
                onChange={(v: boolean) => onChange(set(data, 'scrollTilt', v))}
            />
            <RepeatableList
                label={t('cms_site.blocks.product_mockup.steps', 'Steps after the prompt')}
                items={data.steps || []}
                onChange={(v: MockupStep[]) => onChange(set(data, 'steps', v))}
                makeNew={(): MockupStep => ({ role: 'assistant', title: '', text: '' })}
                itemLabel={(s: MockupStep) => s.title || s.text || t('cms_site.blocks.product_mockup.empty_step', '(empty step)')}
                collapsible
                renderItem={(item: MockupStep, update: (next: MockupStep) => void) => (
                    <>
                        <FieldSelect
                            label={t('cms_site.blocks.product_mockup.step_kind', 'Looks like')}
                            value={item.role || 'assistant'}
                            options={[
                                { value: 'user', label: t('cms_site.blocks.product_mockup.step_user', 'Visitor message') },
                                { value: 'assistant', label: t('cms_site.blocks.product_mockup.step_assistant', 'Assistant message') },
                                { value: 'card', label: t('cms_site.blocks.product_mockup.step_card', 'Result card') },
                            ]}
                            onChange={(v: string) => update({ ...item, role: v })}
                        />
                        {item.role === 'card' ? (
                            <TextField
                                label={t('cms_site.blocks.product_mockup.step_title', 'Card title')}
                                value={item.title || ''}
                                onChange={(v: string) => update({ ...item, title: v })}
                            />
                        ) : null}
                        <TextArea
                            label={t('cms_site.blocks.product_mockup.step_text', 'Text')}
                            value={item.text || ''}
                            onChange={(v: string) => update({ ...item, text: v })}
                            rows={2}
                        />
                    </>
                )}
                addLabel={t('cms_site.blocks.product_mockup.add_step', 'Add step')}
            />
            <BackgroundCard data={data} onChange={onChange} persistKey="blk.product-mockup.background" />
        </>
    );
}
