import { ArchitectureEditor } from './ArchitectureEditor';
import { ContentEditor } from './ContentEditor';
import { CtaBannerEditor } from './CtaBannerEditor';
import { CTAEditor } from './CTAEditor';
import { CustomerSupportEditor } from './CustomerSupportEditor';
import { FeaturesEditor } from './FeaturesEditor';
import { HeroEditor } from './HeroEditor';
import { IntegrationsEditor } from './IntegrationsEditor';
import { LatestPostsEditor } from './LatestPostsEditor';
import { LiveComponentEditor } from './LiveComponentEditor';
import { MediaTextEditor } from './MediaTextEditor';
import { PricingEditor } from './PricingEditor';
import { SecurityEditor } from './SecurityEditor';
import { SocialProofEditor } from './SocialProofEditor';
import { StepsEditor } from './StepsEditor';
import { TechStatsEditor } from './TechStatsEditor';
import { TestimonialsEditor } from './TestimonialsEditor';
import { FaqEditor } from './FaqEditor';
import { TrustBandEditor } from './TrustBandEditor';
import { ShowcaseEditor } from './ShowcaseEditor';
import { FeatureDemoEditor } from './FeatureDemoEditor';
import { RoadmapEditor } from './RoadmapEditor';
import { CompareTableEditor } from './CompareTableEditor';
import { GitHubStatsEditor } from './GitHubStatsEditor';
import { ReleaseNotesEditor } from './ReleaseNotesEditor';

// ── Catalogue + registries ────────────────────────────────────────────
//
// BLOCK_CATALOGUE   used by BlockList (add picker) and BlockRow (labels/icons)
// BLOCK_EDITORS     used by ProductWebsitePanel to render the active editor
// BLOCK_DEFAULTS    used by the panel when creating a new block
// BLOCK_VARIANTS    per-type layout variants (VariantPicker, AddBlockDialog)
//
// BLOCK_DEFAULTS and BLOCK_VARIANTS are GENERATED from the schema of record,
// server/i18n/defaults/cmsDefaults.js, into blockData.generated.mjs
// (`npm run gen:shared`; blockData.lockstep.test.ts holds the copy to its
// source), so a block created in the panel matches one created server-side.
// They are re-exported here for the existing importers.

export { BLOCK_DEFAULTS, BLOCK_VARIANTS } from './blockData.generated.mjs';

export const BLOCK_CATALOGUE = {
    hero:         { type: 'hero',         label: 'Hero',           icon: 'Megaphone',   category: 'Above the fold' },
    socialProof:  { type: 'socialProof',  label: 'Social proof',   icon: 'Users',       category: 'Above the fold' },
    content:      { type: 'content',      label: 'Content',        icon: 'Type',             category: 'Content' },
    'media-text': { type: 'media-text',   label: 'Media + Text',   icon: 'LayoutPanelLeft',  category: 'Content' },
    features:     { type: 'features',     label: 'Features',       icon: 'Sparkles',         category: 'Content' },
    steps:        { type: 'steps',        label: 'How it works',   icon: 'ListOrdered', category: 'Content' },
    security:     { type: 'security',     label: 'Security',       icon: 'ShieldCheck', category: 'Content' },
    integrations: { type: 'integrations', label: 'Integrations',   icon: 'Plug',        category: 'Content' },
    architecture: { type: 'architecture', label: 'Architecture',   icon: 'Boxes',       category: 'Content' },
    techStats:    { type: 'techStats',    label: 'Stats',          icon: 'BarChart3',   category: 'Content' },
    cta:          { type: 'cta',          label: 'Call to action', icon: 'Target',           category: 'Conversion' },
    'cta-banner': { type: 'cta-banner',   label: 'CTA Banner',     icon: 'Rocket',           category: 'Conversion' },
    'live-component': { type: 'live-component', label: 'Live Component', icon: 'Code',         category: 'Content' },
    pricing:      { type: 'pricing',      label: 'Pricing',        icon: 'CreditCard',       category: 'Conversion' },
    'customer-support': { type: 'customer-support', label: 'Customer Support', icon: 'LifeBuoy', category: 'Conversion' },
    // ROLLBACK CAVEAT: exports containing the four types below, imported
    // into an OLDER deployment, silently drop those blocks (unknown-type in
    // normalizeBlockRecord) — land schema + renderer as one deploy unit.
    testimonials: { type: 'testimonials', label: 'Testimonials', icon: 'Quote',                 category: 'Trust' },
    faq:          { type: 'faq',          label: 'FAQ',          icon: 'MessageCircleQuestion', category: 'Content' },
    'trust-band': { type: 'trust-band',   label: 'Trust band',   icon: 'ShieldCheck',           category: 'Trust' },
    showcase:     { type: 'showcase',     label: 'Showcase',     icon: 'MonitorPlay',           category: 'Content' },
    'feature-demo': { type: 'feature-demo', label: 'Live feature demo', icon: 'MousePointerClick', category: 'Content' },
    roadmap:        { type: 'roadmap',      label: 'Roadmap',           icon: 'Milestone',          category: 'Trust' },
    'compare-table': { type: 'compare-table', label: 'Comparison table', icon: 'Table',            category: 'Trust' },
    'github-stats':  { type: 'github-stats',  label: 'GitHub stats',     icon: 'Github',           category: 'Trust' },
    'release-notes': { type: 'release-notes', label: 'Release notes',    icon: 'ScrollText',       category: 'Trust' },
    'blog-latest':   { type: 'blog-latest',   label: 'Latest posts',     icon: 'Newspaper',        category: 'Content' },
};

export const BLOCK_EDITORS = {
    hero:         { component: HeroEditor,         label: 'Hero',           icon: 'Megaphone'   },
    socialProof:  { component: SocialProofEditor,  label: 'Social proof',   icon: 'Users'       },
    content:      { component: ContentEditor,      label: 'Content',        icon: 'Type'             },
    'media-text': { component: MediaTextEditor,    label: 'Media + Text',   icon: 'LayoutPanelLeft'  },
    features:     { component: FeaturesEditor,     label: 'Features',       icon: 'Sparkles'         },
    steps:        { component: StepsEditor,        label: 'How it works',   icon: 'ListOrdered' },
    security:     { component: SecurityEditor,     label: 'Security',       icon: 'ShieldCheck' },
    integrations: { component: IntegrationsEditor, label: 'Integrations',   icon: 'Plug'        },
    architecture: { component: ArchitectureEditor, label: 'Architecture',   icon: 'Boxes'       },
    techStats:    { component: TechStatsEditor,    label: 'Stats',          icon: 'BarChart3'   },
    cta:          { component: CTAEditor,          label: 'Call to action', icon: 'Target'           },
    'cta-banner': { component: CtaBannerEditor,    label: 'CTA Banner',     icon: 'Rocket'           },
    'live-component': { component: LiveComponentEditor, label: 'Live Component', icon: 'Code'        },
    pricing:      { component: PricingEditor,      label: 'Pricing',        icon: 'CreditCard'        },
    'customer-support': { component: CustomerSupportEditor, label: 'Customer Support', icon: 'LifeBuoy' },
    testimonials: { component: TestimonialsEditor, label: 'Testimonials', icon: 'Quote'                 },
    faq:          { component: FaqEditor,          label: 'FAQ',          icon: 'MessageCircleQuestion' },
    'trust-band': { component: TrustBandEditor,    label: 'Trust band',   icon: 'ShieldCheck'           },
    showcase:     { component: ShowcaseEditor,     label: 'Showcase',     icon: 'MonitorPlay'           },
    'feature-demo': { component: FeatureDemoEditor, label: 'Live feature demo', icon: 'MousePointerClick' },
    roadmap:        { component: RoadmapEditor,     label: 'Roadmap',           icon: 'Milestone' },
    'compare-table': { component: CompareTableEditor, label: 'Comparison table', icon: 'Table' },
    'github-stats':  { component: GitHubStatsEditor,  label: 'GitHub stats',     icon: 'Github' },
    'release-notes': { component: ReleaseNotesEditor, label: 'Release notes',    icon: 'ScrollText' },
    'blog-latest':   { component: LatestPostsEditor,  label: 'Latest posts',     icon: 'Newspaper' },
};
