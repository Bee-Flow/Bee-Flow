import React from 'react';
import { FormRichText } from './fields/FormRichText';
import { safeLogoUrl } from './formStyleVars';

/**
 * The parts of a hosted form that frame its content: the scoped custom CSS,
 * the logo, the title and intro, and the footer line. Shared by the form, the
 * waiting screen and the closing page, so a journey keeps one face.
 */

/** The author's custom CSS, already sanitised and scoped (formLook.css). */
export function FormCustomCss({ css }: { css: string }) {
    return css ? <style data-testid="form-custom-css">{css}</style> : null;
}

/** The logo: only a same-origin path is ever loaded (an outside address would tell that site who opens the form). */
export function FormLogo({ url }: { url?: string | null }) {
    const src = safeLogoUrl(url);
    if (!src) return null;
    return (
        <img
            src={src}
            alt=""
            data-testid="form-logo"
            className="bf-form__logo block max-h-12 max-w-[200px] w-auto object-contain [align-self:var(--bf-align-self,flex-start)]"
        />
    );
}

/** Plain text under the form (a company line, a privacy note); never markdown, never a link. */
export function FormFooter({ text }: { text?: string | null }) {
    if (!text || !text.trim()) return null;
    return <p className="bf-form__footer text-xs whitespace-pre-line text-[var(--text-tertiary)] [text-align:var(--bf-align,left)]">{text}</p>;
}

/** Logo, title and intro, aligned the way the author chose. */
export function FormHeader({ title, description, logoUrl }: { title?: string; description?: string; logoUrl?: string | null }) {
    return (
        <header className="flex flex-col gap-1.5 [text-align:var(--bf-align,left)]">
            <FormLogo url={logoUrl} />
            <h1 className="bf-form__title text-xl font-semibold text-[var(--bf-text,var(--text-primary))]">{title}</h1>
            {description ? (
                <FormRichText className="bf-form__intro text-sm text-[var(--text-secondary)]">{description}</FormRichText>
            ) : null}
        </header>
    );
}
