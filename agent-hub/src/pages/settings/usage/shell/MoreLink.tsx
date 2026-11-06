export interface MoreLinkProps {
    label: string;
    onClick: () => void;
}

/** A button styled as a link: moving between tabs is state, not a URL. */
export function MoreLink({ label, onClick }: MoreLinkProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="inline-flex min-h-[44px] cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[13px] font-medium text-[var(--accent-primary)] hover:underline"
        >
            {label} <span aria-hidden="true">→</span>
        </button>
    );
}
