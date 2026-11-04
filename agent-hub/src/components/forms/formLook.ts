import { createContext, useContext, useId, useMemo, type CSSProperties } from 'react';
import themeVars from '../admin/Studio/AppStudio/runtime/themeVars';
import { formStyleClasses, formStyleVars, readFormStyle, scopedFormCss, type FormStyle } from './formStyleVars';

/**
 * What every screen of a hosted form (the form, the waiting screen, the
 * closing page) needs to look like the same product: the theme and the style
 * as one variable map, the root classes, and the author's custom CSS scoped to
 * this one root.
 */
export interface FormLook {
    style: FormStyle;
    /** themeVars + formStyleVars: the ONLY thing the root's `style` prop carries. */
    rootStyle: CSSProperties;
    /** `bf-form bf-form-scope` + the class modifiers + the width/font hooks. */
    rootClass: string;
    /** Ties the scoped `<style>` to this root (`data-bf-scope`). */
    scopeId: string;
    /** The scoped sheet, or '' when there is no custom CSS. */
    css: string;
}

/** The card every screen sits on; `--bf-card-bg` is the author's card colour. */
export const CARD_CLASS = 'border [border-color:var(--border-default)] [border-radius:var(--app-radius)] [background:var(--bf-card-bg,var(--bg-card,var(--bg-secondary)))]';

const ROOT_CLASS = 'bf-form bf-form-scope mx-auto w-full max-w-[var(--bf-form-width,none)] [font-family:var(--bf-font,inherit)]';

export function useFormLook(theme: unknown, rawStyle: unknown): FormLook {
    const scopeId = useId();
    return useMemo(() => {
        const style = readFormStyle(rawStyle);
        const modifiers = formStyleClasses(style);
        return {
            style,
            rootStyle: { ...themeVars(theme || {}), ...formStyleVars(style) } as CSSProperties,
            rootClass: modifiers ? `${ROOT_CLASS} ${modifiers}` : ROOT_CLASS,
            scopeId,
            css: scopedFormCss(style, scopeId),
        };
    }, [theme, rawStyle, scopeId]);
}

/** The form's style, for the fields that change shape with it (a label inside the box). */
export const FormStyleContext = createContext<FormStyle>({});

export const useFormStyle = (): FormStyle => useContext(FormStyleContext);
