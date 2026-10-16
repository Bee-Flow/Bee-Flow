import React from 'react';
import SectionHeader from '../components/SectionHeader';
import IconGlyph from '../components/IconGlyph';
import EditableText from '../components/EditableText';
import SectionFrame from '../components/SectionFrame';
import { resolveAssetUrl } from '../assetUrl';
import { sectionBgClass } from './sectionBg';
import { inlineTextStyle } from './textStyle';
import { getIntegrationLogo } from '../../utils/integrationLogos';
import { resolveIntegrationLogoId } from './integrationLogoId';
import type { SectionDataBase } from './sectionData.types';

interface IntegrationItem {
    label?: string;
    icon?: string;
    logoId?: string;
    logoSrc?: string;
}

interface IntegrationCategory {
    heading?: string;
    headingAlign?: string;
    items?: IntegrationItem[];
}

interface IntegrationsData extends SectionDataBase {
    categories?: IntegrationCategory[];
}

/* The product already ships official brand SVGs for every integration it can
   talk to (`utils/integrationLogos`). The marketing wall drew Lucide glyphs
   instead, so Gmail, Outlook and Jira all rendered as the same generic
   envelope/ticket outline in the same accent colour — the page said "44
   integrations" while looking like one. Reusing the product's registry keeps
   the two surfaces honest: if the app grows a mark, the website gets it. */
const brandLogo = (id: string | undefined) => (id ? getIntegrationLogo(id) : null);

function IntegrationTile({ item, path }: { item: IntegrationItem; path: string }) {
    const logoId = resolveIntegrationLogoId(item);
    return (
        <span className="integration-item">
            {/* Real logo (grayscale, color on hover — the social-proof wall
                recipe) beats the Lucide icon; both absent ⇒ label-only chip.
                An empty logoId is matched on the label, then the icon. */}
            {item.logoSrc ? (
                <img className="integration-logo" src={resolveAssetUrl(item.logoSrc)} alt="" loading="lazy" />
            ) : brandLogo(logoId) ? (
                <BrandMark id={logoId} />
            ) : item.icon ? (
                <span className="icon-tile icon-tile--neutral"><IconGlyph icon={item.icon} className="w-4 h-4" /></span>
            ) : null}
            <EditableText path={path} placeholder="Tool name">
                {item.label || ''}
            </EditableText>
        </span>
    );
}

function BrandMark({ id }: { id: string | undefined }) {
    const Logo = brandLogo(id);
    if (!Logo) return null;
    return (
        <span className="integration-logo-mark" aria-hidden="true">
            <Logo size={20} />
        </span>
    );
}

export default function Integrations({ data }: { data?: IntegrationsData | null }) {
    if (!data?.enabled) return null;
    return (
        <SectionFrame id="integrations" name="Integrations" enabled={data.enabled}>
            <section id="integrations" className={sectionBgClass(data, 'alt-bg')}>
                <div className="container">
                    <SectionHeader
                        pathPrefix="integrations"
                        eyebrow={data.eyebrow} title={data.title} lead={data.lead}
                        eyebrowStyle={data.eyebrowStyle} titleStyle={data.titleStyle} leadStyle={data.leadStyle}
                        eyebrowAlign={data.eyebrowAlign} titleAlign={data.titleAlign} leadAlign={data.leadAlign} align={data.align}
                    />
                    <div className="integrations-categories">
                        {(data.categories || []).map((cat, i) => (
                            <div key={i} className="integration-category reveal">
                                {/* Heading, count and the rule that closes the row.
                                    The count is derived, never stored — an editor
                                    adding a tool should not have to remember to
                                    bump a number in the heading text. */}
                                <div className="integration-category-head">
                                    <EditableText
                                        as="h3"
                                        path={`integrations.categories.${i}.heading`}
                                        multiline
                                        placeholder="Category heading"
                                        style={inlineTextStyle(undefined, cat.headingAlign)}
                                    >
                                        {cat.heading || ''}
                                    </EditableText>
                                    {(cat.items || []).length > 0 ? (
                                        <span className="integration-count">{(cat.items || []).length}</span>
                                    ) : null}
                                </div>
                                <div className="integration-logos">
                                    {(cat.items || []).map((item, j) => (
                                        <IntegrationTile key={j} item={item} path={`integrations.categories.${i}.items.${j}.label`} />
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>
        </SectionFrame>
    );
}
