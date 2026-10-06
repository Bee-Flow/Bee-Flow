/**
 * The amber notices of the Condition editor about the list it works through:
 *   - StaleSuccessorsNotice (W7): a next step still reads the list this
 *     Condition filters, so what it drops still reaches that step.
 *   - UnfitRulesNotice (R11): after the list changed, some rules read fields
 *     the new item does not have.
 *   - WholeListNotice (BFSF-485 F3/F4): a whole-run Condition reads a list as
 *     a whole, so it does not filter it (and a loop after it still sees every item).
 * Each one carries the one-click fix next to the sentence that explains it.
 * A fix removes its own notice, so it hands focus to NoticeFixAnchor, which
 * stays mounted and says what was done (never focus dropped on <body>).
 */
import { useCallback, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { INLINE_LINK } from './formStyles';

export interface RouteFollow {
    stale: Array<{ stepId: string; stepLabel: string; readsLabel: string }>;
    follow: (stepIds: string[]) => void;
}

export interface WholeRun {
    lists: Array<{ path: string; label: string; convertible?: boolean }>;
    loops: Array<{ stepId: string; stepLabel: string }>;
}

const quoted = (names: string[]) => names.map((n) => `“${n}”`).join(', ');

/** Where focus goes after a notice's fix, and the sentence that says what it did. */
export interface NoticeFix {
    ref: RefObject<HTMLDivElement | null>;
    message: string;
    done: (message: string) => void;
}

export function useNoticeFix(): NoticeFix {
    const ref = useRef<HTMLDivElement | null>(null);
    const [message, setMessage] = useState('');
    const done = useCallback((next: string) => {
        setMessage(next);
        ref.current?.focus();
    }, []);
    return { ref, message, done };
}

/** Always mounted next to the notices: takes focus after a fix and announces it. */
export function NoticeFixAnchor({ fix }: { fix: NoticeFix }) {
    return <div ref={fix.ref} tabIndex={-1} role="status" className="sr-only">{fix.message}</div>;
}

type OnFixed = ((message: string) => void) | null | undefined;

interface NoticeProps {
    children: ReactNode;
    action?: string | null;
    /** Returns false when nothing was changed. */
    onAction?: () => void | boolean;
    doneText?: string;
    onFixed?: OnFixed;
}

// --accent is a light grey in the light theme (defect 6): the fix reads as an inline link instead.
const ACTION_CLASS = `text-[11px] font-medium ${INLINE_LINK}`;

function Notice({ children, action = null, onAction, doneText = '', onFixed }: NoticeProps) {
    const run = () => {
        if (onAction?.() === false) return;
        onFixed?.(doneText);
    };
    return (
        <div className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 space-y-1.5" role="status">
            <div className="text-[11px] text-[var(--text-primary)]">{children}</div>
            {action && onAction && (
                <button type="button" onClick={run} className={ACTION_CLASS}>
                    {action}
                </button>
            )}
        </div>
    );
}

export function StaleSuccessorsNotice({ routeFollow, listName = null, onFixed }: { routeFollow?: RouteFollow | null; listName?: string | null; onFixed?: OnFixed }) {
    const { t } = useTranslation();
    const stale = routeFollow?.stale || [];
    if (!routeFollow || !stale.length) return null;
    const list = listName || stale[0].readsLabel;
    const text = stale.length === 1
        ? t('condition_node.stale.one', '“{step}” still reads {list}, so what this Condition drops still reaches it.', { step: stale[0].stepLabel, list })
        : t('condition_node.stale.many', '{steps} still read {list}, so what this Condition drops still reaches them.', { steps: quoted(stale.map((s) => s.stepLabel)), list });
    return (
        <Notice
            action={t('condition_node.stale.follow', 'Use what this Condition keeps')}
            onAction={() => routeFollow.follow(stale.map((s) => s.stepId))}
            doneText={t('condition_node.fix.followed', 'Done: the next steps now read what this Condition keeps.')}
            onFixed={onFixed}
        >
            {text}
        </Notice>
    );
}

export function UnfitRulesNotice({ unfit, itemName, onRemove, onFixed }: { unfit: string[]; itemName: string; onRemove: () => void; onFixed?: OnFixed }) {
    const { t } = useTranslation();
    if (!unfit.length) return null;
    return (
        <Notice
            action={t('condition_node.rules_remove_unfit', 'Remove those rules')}
            onAction={onRemove}
            doneText={t('condition_node.fix.removed', 'Done: those rules are removed.')}
            onFixed={onFixed}
        >
            {t('condition_node.rules_dont_fit', 'These rules read {fields}, which each {name} doesn’t have.', { fields: unfit.join(', '), name: itemName })}
        </Notice>
    );
}

interface WholeListNoticeProps {
    wholeRun?: WholeRun | null;
    /** Returns false when the list could not be worked through. */
    onConvert: (listPath: string) => void | boolean;
    onFixed?: OnFixed;
}

export function WholeListNotice({ wholeRun, onConvert, onFixed }: WholeListNoticeProps) {
    const { t } = useTranslation();
    const lists = wholeRun?.lists || [];
    // The fix is offered only for a list a rule reads the items of; one read
    // whole would become a rule that never reads the item.
    const target = lists.find((l) => l.convertible !== false) || null;
    const list = target || lists[0];
    if (!list) return null;
    const loops = wholeRun?.loops || [];
    let loopText = '';
    if (loops.length === 1) {
        loopText = t('condition_node.loop_after.one', '“{step}” still runs once for every item of that list.', { step: loops[0].stepLabel });
    } else if (loops.length > 1) {
        loopText = t('condition_node.loop_after.many', '{steps} still run once for every item of that list.', { steps: quoted(loops.map((l) => l.stepLabel)) });
    }
    return (
        <Notice
            action={target ? t('condition_node.whole_list.use_filter', 'Check each item instead') : null}
            onAction={target ? () => onConvert(target.path) : undefined}
            doneText={t('condition_node.fix.each_item', 'Done: this Condition now checks each item.')}
            onFixed={onFixed}
        >
            {t('condition_node.whole_list.note', 'This checks the whole list {list} once: the run goes one way for all its items. It does not filter them.', { list: list.label })}
            {loopText && <> {loopText}</>}
        </Notice>
    );
}
