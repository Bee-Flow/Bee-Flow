import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { resolveSectionStyle } from './styleResolver';
import { useRuntime } from './RuntimeContext';
import {
    sectionCollapsible,
    sectionRoleAllows,
    sectionTitle,
    sectionVisibility,
    sectionWidthClass,
} from './sectionModel';
import { sectionThemeScope } from './themeScope';
import './css/sections.css';
import type { ReactNode } from 'react';
import type { AppSection as AppSectionModel } from '../inspector/appDefinition';
import type { SectionModel } from './sectionModel';

/**
 * One section of a screen: the `.app-grid` its nodes are placed in.
 *
 * The renderer passes the section's nodes, already rendered, as children, so this
 * component decides only what the section element itself looks like, and whether it is
 * drawn at all (sectionModel.ts):
 *
 *   - visibleToRoles closed for the viewer's role: nothing, in every mode (as a node);
 *   - visibleWhen false: nothing in the running app, dimmed in the editor;
 *   - title: a header row inside the grid; with collapsible the viewer folds the section;
 *   - maxWidth: a class that caps and centres it;
 *   - theme (schema 3): the override's theme variables on the section, and with an appearance the
 *     attribute and the ground of that appearance (themeScope.ts).
 *
 * A section without those keys renders exactly the element it always did.
 */
export default function AppSection({ section, theme = null, children }: { section: AppSectionModel; theme?: unknown; children?: ReactNode }) {
    const runtime = useRuntime();
    const [collapsed, setCollapsed] = useState(false);
    const model = section as SectionModel;
    if (!sectionRoleAllows(model, runtime.previewRole as string | null)) return null;
    const editing = runtime.mode === 'edit';
    const { hidden } = sectionVisibility(model, runtime.scope);
    if (hidden && !editing) return null;

    const { className, style } = resolveSectionStyle(section);
    // section.theme (schema 3, themeScope.ts): no style, class or attribute without one.
    const scoped = sectionThemeScope((section as { theme?: unknown }).theme, theme);
    const title = sectionTitle(model);
    const collapsible = sectionCollapsible(model);
    const folded = collapsible && collapsed;
    const classes = className
        + sectionWidthClass(model)
        + (title ? ' app-section--titled' : '')
        + (folded ? ' app-section--collapsed' : '')
        + (hidden ? ' app-section--hidden-edit' : '')
        + scoped.className;
    const sectionStyle = scoped.className || Object.keys(scoped.style).length ? { ...scoped.style, ...style } : style;

    return (
        <section data-section-id={section.id} className={classes} style={sectionStyle} data-app-appearance={scoped.appearance}>
            {title ? (
                <header className="app-section-header">
                    {/* The disclosure pattern: the heading holds the button, never the reverse. */}
                    <h2 className="app-section-title">
                        {collapsible ? (
                            <button
                                type="button"
                                className="app-section-toggle"
                                aria-expanded={!folded}
                                onClick={() => setCollapsed((v) => !v)}
                            >
                                <ChevronDown className="app-section-chevron" aria-hidden="true" />
                                <span>{title}</span>
                            </button>
                        ) : title}
                    </h2>
                </header>
            ) : null}
            {folded ? null : children}
        </section>
    );
}
