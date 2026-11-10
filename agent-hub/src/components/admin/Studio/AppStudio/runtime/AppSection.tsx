import { resolveSectionStyle } from './styleResolver';
import type { ReactNode } from 'react';
import type { AppSection as AppSectionModel } from '../inspector/appDefinition';

/**
 * One section of a screen: the `.app-grid` its nodes are placed in.
 *
 * The renderer passes the section's nodes, already rendered, as children, so this
 * component decides only what the section element itself looks like.
 */
export default function AppSection({ section, children }: { section: AppSectionModel; children?: ReactNode }) {
    const { className, style } = resolveSectionStyle(section);
    return (
        <section data-section-id={section.id} className={className} style={style}>
            {children}
        </section>
    );
}
