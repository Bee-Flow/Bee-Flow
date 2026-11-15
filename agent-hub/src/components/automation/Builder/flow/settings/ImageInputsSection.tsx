// `images` of an AI step or a data extraction: the pictures the step may show
// its model, each a binding to the `sourceHandle` that "read file" returns for
// an image. Whether a picture really goes is decided per run (the
// organisation's "images to AI" switch, the Privacy Shield, the model); when
// it does not, the step gets the text read from the image and says so.
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import BindingField from '@/components/automation/Builder/mapping/BindingField';
import type { OnFocusField } from '@/components/automation/Builder/mapping/focusField.types';
import AccordionSection from '../AccordionSection';
import { MAX_IMAGE_BINDINGS, emptyImageBinding } from './formState/imageBindings';
import { hintTextClass } from './formPrimitives';

interface ImageInputsSectionProps {
    stepType: 'ai_step' | 'data_extraction';
    images: unknown[];
    onChange: (next: unknown[]) => void;
    onFocusField?: OnFocusField | null;
    previewSample?: unknown;
    forceOpen?: boolean;
}

export default function ImageInputsSection({ stepType, images, onChange, onFocusField, previewSample, forceOpen = false }: ImageInputsSectionProps) {
    const { t } = useTranslation();
    const rows = Array.isArray(images) ? images : [];
    const update = (i: number, next: unknown) => onChange(rows.map((r, idx) => (idx === i ? next : r)));
    const remove = (i: number) => onChange(rows.filter((_, idx) => idx !== i));
    const add = () => { if (rows.length < MAX_IMAGE_BINDINGS) onChange([...rows, emptyImageBinding()]); };
    return (
        <AccordionSection stepType={stepType} sectionKey="images" title={t('automation_image_ai.section_title', 'Images')} forceOpen={forceOpen} hasContent={rows.length > 0}>
            <p className={`${hintTextClass()} mb-2`}>
                {t('automation_image_ai.section_hint', 'Pictures to show the AI model: drag in the image handle (sourceHandle) of a "read file" step that read an image. It is only sent when your organisation allows images to AI, the Privacy Shield does not apply and the model reads images; otherwise the step uses the text read from the image.')}
            </p>
            <div className="space-y-2">
                {rows.map((b, i) => (
                    <div key={i} className="flex items-start gap-1.5" data-testid="image-input-row">
                        <div className="min-w-0 flex-1">
                            <BindingField
                                value={b as never}
                                onChange={(next) => update(i, next)}
                                placeholder={t('automation_image_ai.row_placeholder', 'steps.<read>.output.sourceHandle')}
                                onFocusField={onFocusField}
                                previewSample={previewSample}
                                showExpressionHelp={false}
                            />
                        </div>
                        <button type="button" onClick={() => remove(i)} className="mt-1.5 rounded p-1 text-[var(--text-muted)] hover:text-[var(--error-ink)]"
                            aria-label={t('automation_image_ai.row_remove', 'Remove this image')}>
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                    </div>
                ))}
            </div>
            {rows.length < MAX_IMAGE_BINDINGS && (
                <button type="button" onClick={add} className="mt-2 inline-flex items-center gap-1 text-sm text-[var(--accent-ink)] hover:underline">
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />{t('automation_image_ai.row_add', 'Add an image')}
                </button>
            )}
        </AccordionSection>
    );
}
