import {
    Accessibility, Bot, Bug, Database, Factory, Gavel, Landmark, Network, Scale, ShieldCheck, FileBadge, PenLine,
} from 'lucide-react';

/**
 * frameworkIcons — one lucide glyph per compliance framework (frame 1e of the
 * Compliance artboard). Growing-set frameworks are keyed by their catalogue id
 * (`server/compliance/frameworks.js`); the three core frameworks and the
 * "own framework" card have entries too so a rail or card never renders an
 * empty icon slot.
 */
export const FRAMEWORK_ICONS = Object.freeze({
    gdpr: ShieldCheck,
    aia: Bot,
    iso27001: FileBadge,
    nis2: Network,
    cra: Bug,
    data_act: Database,
    pld: Gavel,
    eaa: Accessibility,
    dora: Landmark,
    machinery: Factory,
    custom: PenLine,
});

/** Aliases the API or the sections table may use for the same framework. */
const ALIASES = Object.freeze({
    iso: 'iso27001',
    ai_act: 'aia',
    'data-act': 'data_act',
    dataact: 'data_act',
});

/** Glyph for a framework id (case-insensitive, alias-tolerant); `Scale` when unknown. */
export function frameworkIcon(id) {
    if (typeof id !== 'string' || !id) return Scale;
    const key = id.toLowerCase();
    return FRAMEWORK_ICONS[ALIASES[key] || key] || Scale;
}

export default frameworkIcon;
