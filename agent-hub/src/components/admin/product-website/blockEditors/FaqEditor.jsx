import React from 'react';
import { TextField, RepeatableList } from '../fields';
import { InlineHint, BackgroundCard } from '../primitives';
import { set, SectionHeaderFields } from './shared';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── FAQ ───────────────────────────────────────────────────────────────
//
// Controlled accordion (one open at a time; the first item starts open in
// the preview so editors always see an answer). Single layout, no variants.

export function FaqEditor({ data = {}, onChange }) {
    const { t } = useTranslation();
    return (
        <>
            <InlineHint>{t('cms_site.blocks.faq.questions_and_answers_are_editable_in', 'Questions and answers are editable in the preview — open a row to edit its answer inline.')}</InlineHint>
            <SectionHeaderFields data={data} onChange={onChange} persistScope="faq" />
            <RepeatableList
                label={t('cms_site.blocks.faq.questions', 'Questions')}
                items={data.items || []}
                onChange={v => onChange(set(data, 'items', v))}
                makeNew={() => ({ question: 'New question?', answer: '' })}
                itemLabel={(item) => item.question || t('cms_site.blocks.faq.no_question', '(no question)')}
                renderItem={(item, update) => (
                    <>
                        <TextField
                            label={t('cms_site.blocks.faq.question', 'Question')}
                            value={item.question || ''}
                            onChange={v => update({ ...item, question: v })}
                            placeholder={t('cms_site.blocks.faq.what_do_visitors_ask', 'What do visitors ask?')}
                        />
                        <TextField
                            label={t('cms_site.blocks.faq.answer', 'Answer')}
                            value={item.answer || ''}
                            onChange={v => update({ ...item, answer: v })}
                            placeholder={t('cms_site.blocks.faq.answer_it_in_two_or_three', 'Answer it in two or three plain sentences.')}
                        />
                    </>
                )}
                addLabel={t('cms_site.blocks.faq.add_question', 'Add question')}
            />
            <BackgroundCard data={data} onChange={onChange} persistKey="blk.faq.background" />
        </>
    );
}
