import React, { useContext, useId } from 'react';
import { BlockIdContext } from '../components/EditableText';
import SectionFrame from '../components/SectionFrame';
import SectionHeader from '../components/SectionHeader';
import { sectionBgClass } from './sectionBg';
import type { SectionDataBase } from './sectionData.types';
import { usableFields } from './formBlockModel';
import FormBody from './FormBody';
import { useFormSubmission } from './useFormSubmission';

/**
 * Form — a lead-capture form (demo request, newsletter, gated download) that
 * posts to a Bee Flow automation on the SAME install, so what a visitor types
 * never goes to a third party. The server decides which automation runs and
 * what is accepted (server/routes/cmsForms.js); this block only names itself
 * (its block id) and sends the answers.
 *
 * Flow: GET /api/cms/forms/:blockId gives a signed token → the visitor fills
 * the form → POST the answers with the token, a one-off nonce and the
 * honeypot value. The analytics `form_submit` event is raised by the site-wide
 * submit listener (components/analyticsEvents.js), with the block attributed.
 * Inside the editor's preview nothing is fetched or sent.
 *
 * Inline-editable paths: form.eyebrow, form.title, form.lead
 */

interface FormBlockData extends SectionDataBase {
    fields?: unknown;
    consent?: { enabled?: boolean; text?: string };
    submitLabel?: string;
    successTitle?: string;
    successBody?: string;
    errorText?: string;
}

const isPreviewMode = () =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('preview');

const DEFAULT_ERROR = 'Something went wrong. Please try again.';
const UNAVAILABLE_TEXT = 'This form is not available right now.';

export default function FormBlock({ data }: { data?: FormBlockData }) {
    const blockId = useContext(BlockIdContext);
    const uid = useId();
    const preview = isPreviewMode();
    const fields = usableFields(data?.fields);
    const consentText = data?.consent?.enabled === true ? (data.consent.text || '').trim() : '';
    const form = useFormSubmission({
        blockId, active: !!data?.enabled, preview, fields, consentText, errorText: data?.errorText || DEFAULT_ERROR,
    });

    if (!data?.enabled) return null;

    return (
        <SectionFrame id="form" name="Form" enabled={data.enabled}>
            <section className={['cms-form-block', sectionBgClass(data, 'alt-bg')].filter(Boolean).join(' ')}>
                <div className="container">
                    <SectionHeader
                        pathPrefix="form"
                        eyebrow={data.eyebrow} title={data.title} lead={data.lead}
                        eyebrowStyle={data.eyebrowStyle} titleStyle={data.titleStyle} leadStyle={data.leadStyle}
                        eyebrowAlign={data.eyebrowAlign} titleAlign={data.titleAlign} leadAlign={data.leadAlign} align={data.align}
                    />
                    {form.phase === 'done' ? (
                        <div className="cms-form-card cms-form-success" role="status">
                            {data.successTitle ? <h3>{data.successTitle}</h3> : null}
                            {data.successBody ? <p>{data.successBody}</p> : null}
                        </div>
                    ) : form.phase === 'unavailable' ? (
                        <p className="cms-form-card cms-form-note" role="status">{UNAVAILABLE_TEXT}</p>
                    ) : (
                        <FormBody uid={uid} title={data.title} submitLabel={data.submitLabel} fields={fields}
                            consentText={consentText} preview={preview} form={form} />
                    )}
                </div>
            </section>
        </SectionFrame>
    );
}
