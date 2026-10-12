// Class recipes for the MCP library, taken from the Studio surfaces
// (TemplateTile, TemplateGallery, OverviewToolbar) so the library reads as
// part of the same product. Literal strings only: Tailwind emits what it can
// find in the source, never a class assembled at runtime.

export const PRIMARY_BTN = 'inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed';

export const SECONDARY_BTN = 'inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition disabled:opacity-50 disabled:cursor-not-allowed';

export const QUIET_BTN = 'inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition disabled:opacity-50 disabled:cursor-not-allowed';

export const DANGER_BTN = 'inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium border border-[color-mix(in_srgb,var(--error)_40%,transparent)] text-[var(--error-ink)] hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] transition disabled:opacity-50 disabled:cursor-not-allowed';

export const INPUT = 'w-full px-3 py-2 text-[13px] rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--accent-primary)] disabled:opacity-60';

export const LABEL = 'block text-[12px] font-medium text-[var(--text-secondary)] mb-1';

export const HINT = 'mt-1 text-[11.5px] leading-snug text-[var(--text-tertiary)]';

export const CARD = 'flex flex-col gap-3 p-3.5 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)]';

export const CARD_BUTTON = 'group flex flex-col gap-3 p-3.5 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-left transition hover:shadow-md hover:border-[var(--text-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]';

export const DASHED = 'flex items-start gap-3 px-3.5 py-3 rounded-[10px] border border-dashed border-[var(--border-default)]';

export const EYEBROW = 'm-0 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]';

export const SECTION_TITLE = 'm-0 flex items-baseline gap-2 text-[13px] font-semibold text-[var(--text-primary)]';

export const CHIP = 'inline-flex items-center gap-1 px-2 py-[3px] rounded-full border border-[var(--border-default)] text-[11px] text-[var(--text-secondary)] whitespace-nowrap';

export const CHIP_SUCCESS = 'inline-flex items-center gap-1 px-2 py-[3px] rounded-full text-[11px] font-medium whitespace-nowrap bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success-ink)]';

export const CHIP_WARNING = 'inline-flex items-center gap-1 px-2 py-[3px] rounded-full text-[11px] font-medium whitespace-nowrap bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning-ink)]';

export const CHIP_ERROR = 'inline-flex items-center gap-1 px-2 py-[3px] rounded-full text-[11px] font-medium whitespace-nowrap bg-[color-mix(in_srgb,var(--error)_14%,transparent)] text-[var(--error-ink)]';

export const CHIP_INFO = 'inline-flex items-center gap-1 px-2 py-[3px] rounded-full text-[11px] font-medium whitespace-nowrap bg-[color-mix(in_srgb,var(--info)_14%,transparent)] text-[var(--info-ink)]';

export const ALERT_ERROR = 'flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] leading-snug border-[color-mix(in_srgb,var(--error)_40%,transparent)] bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[var(--error-ink)]';

export const ALERT_WARNING = 'flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] leading-snug border-[color-mix(in_srgb,var(--warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[var(--warning-ink)]';

export const ALERT_INFO = 'flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] leading-snug border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]';

export const ALERT_SUCCESS = 'flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] leading-snug border-[color-mix(in_srgb,var(--success)_40%,transparent)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success-ink)]';

export const FILTER_CHIP_ON = 'inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] transition border-[var(--text-tertiary)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] font-medium';

export const FILTER_CHIP_OFF = 'inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] transition border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]';

export const DOT_LIVE = 'h-1.5 w-1.5 rounded-full bg-[var(--success)] shrink-0';
export const DOT_OFF = 'h-1.5 w-1.5 rounded-full bg-[var(--text-tertiary)] shrink-0';
export const DOT_WARN = 'h-1.5 w-1.5 rounded-full bg-[var(--warning)] shrink-0';
export const DOT_ERROR = 'h-1.5 w-1.5 rounded-full bg-[var(--error)] shrink-0';
