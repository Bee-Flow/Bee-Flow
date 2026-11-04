import React from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { FORM_BUTTON_SHAPES, FORM_BUTTON_WIDTHS, FORM_INPUT_STYLES, FORM_LABEL_STYLES } from '@/components/forms/formStyleVars';
import { ColorRow, OptionRow, ROW_LABEL } from './controls';
import { optionsOf } from './styleOptions';
import { withButtonValue, withStyleValue, type Style } from './stylePresets';
import type { StyleChange } from './formStyleTypes';

/** Fields: where the label sits, how an input is drawn, and the label colour. */
export function FieldsGroup({ style, onChange }: { style: Style | undefined; onChange: StyleChange }) {
    const { t } = useTranslation();
    const setStyle = (key: string, value: unknown) => onChange({ style: withStyleValue(style, key, value) });
    return (
        <>
            <OptionRow label={t('forms.style.label_style', 'Labels')} value={style?.labelStyle} onPick={v => setStyle('labelStyle', v)} withDefault options={optionsOf(t, 'label', FORM_LABEL_STYLES)} />
            <OptionRow label={t('forms.style.input_style', 'Input style')} value={style?.inputStyle} onPick={v => setStyle('inputStyle', v)} withDefault options={optionsOf(t, 'input', FORM_INPUT_STYLES)} />
            <ColorRow label={t('forms.style.label_color', 'Label colour')} value={style?.labelColor} fallback="#111827" onChange={v => setStyle('labelColor', v)} />
        </>
    );
}

/** The button's text (the form's submitLabel slot, rendered by the host). */
export function ButtonTextRow({ children }: { children: React.ReactNode }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-2">
            <span className={ROW_LABEL}>{t('forms.style.button_text', 'Button text')}</span>
            <div className="flex-1 min-w-0">{children}</div>
        </div>
    );
}

/** Button: its text (the form's submitLabel), width, shape and text colour. */
export function ButtonGroup({ style, onChange, buttonText = null }: { style: Style | undefined; onChange: StyleChange; buttonText?: React.ReactNode }) {
    const { t } = useTranslation();
    const button = (style?.button && typeof style.button === 'object' ? style.button : {}) as Style;
    const setButton = (key: string, value: unknown) => onChange({ style: withButtonValue(style, key, value) });
    return (
        <>
            {buttonText ? <ButtonTextRow>{buttonText}</ButtonTextRow> : null}
            <OptionRow label={t('forms.style.button_width', 'Width')} value={button.width} onPick={v => setButton('width', v)} withDefault options={optionsOf(t, 'button_width', FORM_BUTTON_WIDTHS)} />
            <OptionRow label={t('forms.style.button_shape', 'Shape')} value={button.shape} onPick={v => setButton('shape', v)} withDefault options={optionsOf(t, 'shape', FORM_BUTTON_SHAPES)} />
            <ColorRow label={t('forms.style.button_text_color', 'Button text colour')} value={button.textColor} fallback="#ffffff" onChange={v => setButton('textColor', v)} />
        </>
    );
}
