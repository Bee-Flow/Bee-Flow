// Class strings the Spend tables share (Tailwind on theme variables).

export const CARD = 'rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)]';
export const TABLE = 'w-full border-collapse text-[13px]';
export const TH = 'px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-muted)] whitespace-nowrap';
export const TH_R = `${TH} !text-right`;
export const TD = 'px-3 py-2.5 align-middle text-[var(--text-primary)] border-t border-[var(--border-subtle)]';
export const TD_R = `${TD} text-right tabular-nums whitespace-nowrap`;
export const TD_MUTED = `${TD_R} !text-[var(--text-muted)]`;
export const TFOOT = 'border-t-2 border-[var(--border-subtle)] px-3 py-2.5 font-semibold text-[var(--text-primary)]';
export const ROW_BTN = 'inline-flex min-w-0 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left text-[13px] text-[var(--text-primary)]';
export const BADGE = 'inline-block rounded-md bg-[var(--bg-tertiary)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]';
export const BADGE_WARN = 'inline-block rounded-md bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[var(--warning)]';
export const GHOST_BTN = 'inline-flex w-fit cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]';
export const PANEL_CARD = 'flex flex-col gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4';
