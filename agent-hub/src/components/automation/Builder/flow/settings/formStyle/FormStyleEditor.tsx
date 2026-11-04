import React, { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import type { StyleAssist } from '@/api/formStyleAssist';
import { subLabelClass } from '../formPrimitives';
import { StyleGroup } from './controls';
import LookGroup from './LookGroup';
import LayoutGroup from './LayoutGroup';
import { ButtonGroup, ButtonTextRow, FieldsGroup } from './FieldsButtonGroups';
import BrandGroup from './BrandGroup';
import CustomCssEditor from './CustomCssEditor';
import DescribeLookPanel from './DescribeLookPanel';
import { withStyleValue, type Style, type Theme } from './stylePresets';
import type { StyleChange } from './formStyleTypes';

export interface FormStyleEditorProps {
    /** The theme to edit against (the Clean preset when the page inherits). */
    theme: Theme;
    /** The page's own `form.style`, as stored. */
    formStyle?: unknown;
    /** The page shows the first page's look (theme null). */
    inherits?: boolean;
    /** A later page: it may inherit the first page's look. */
    canInherit?: boolean;
    /** A closing page: no questions and no button, so no Fields and Button groups. */
    isEnding?: boolean;
    /** One edit of the look; the host merges it into the form. */
    onChange: StyleChange;
    /** The button-text slot (the form's submitLabel), rendered by the host. */
    buttonText?: React.ReactNode;
    onStyleAssist?: StyleAssist | null;
}

type GroupId = 'look' | 'layout' | 'fields' | 'button' | 'brand' | 'advanced';

const asStyle = (v: unknown): Style | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Style : undefined);

/**
 * The form's look, in groups: Look, Layout, Fields, Button, Brand, Advanced.
 * Every control writes through `onChange` at once, so the preview next to it
 * follows every click. Theme keys go to `form.theme` (App Studio's shared
 * vocabulary); form-only knobs to `form.style`.
 */
export default function FormStyleEditor({ theme, formStyle, inherits = false, canInherit = false, isEnding = false, onChange, buttonText, onStyleAssist }: FormStyleEditorProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState<Set<GroupId>>(() => new Set<GroupId>(['look']));
    const style = asStyle(formStyle);
    const toggle = (id: GroupId) => setOpen(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });
    const group = (id: GroupId, title: string, body: React.ReactNode) => (
        <StyleGroup id={id} title={title} open={open.has(id)} onToggle={() => toggle(id)}>{body}</StyleGroup>
    );
    const customCss = typeof style?.customCss === 'string' ? style.customCss : '';
    const setCss = (css: string) => onChange({ style: withStyleValue(style, 'customCss', css || undefined) });
    const shown = !(canInherit && inherits);

    return (
        <div className="space-y-2" data-testid="form-style-editor">
            <div className={subLabelClass()}>{t('forms.style.heading', 'Design')}</div>
            {canInherit && (
                // A later page defaults to the first page's look so a form does
                // not change appearance halfway through. Overriding is one
                // click, and going back is the same click.
                <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={inherits}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.checked ? { theme: null, style: undefined } : { theme: { ...theme } })}
                    />
                    {t('automations.form_builder_fields.match_the_first_page', 'Match the first page')}
                </label>
            )}
            {/* The button's text is content, not look: it stays editable while the look is inherited. */}
            {!shown && !isEnding && buttonText ? <ButtonTextRow>{buttonText}</ButtonTextRow> : null}
            {shown && (
                <>
                    {group('look', t('forms.style.group_look', 'Look'), <LookGroup theme={theme} style={style} onChange={onChange} />)}
                    {group('layout', t('forms.style.group_layout', 'Layout'), <LayoutGroup theme={theme} style={style} onChange={onChange} />)}
                    {!isEnding && group('fields', t('forms.style.group_fields', 'Fields'), <FieldsGroup style={style} onChange={onChange} />)}
                    {!isEnding && group('button', t('forms.style.group_button', 'Button'), <ButtonGroup style={style} onChange={onChange} buttonText={buttonText} />)}
                    {group('brand', t('forms.style.group_brand', 'Brand'), <BrandGroup style={style} onChange={onChange} />)}
                    {group('advanced', t('forms.style.group_advanced', 'Advanced'), (
                        <>
                            <DescribeLookPanel assist={onStyleAssist} theme={theme} style={style} customCss={customCss} onCss={setCss} />
                            <CustomCssEditor value={customCss} onChange={setCss} />
                        </>
                    ))}
                </>
            )}
        </div>
    );
}
