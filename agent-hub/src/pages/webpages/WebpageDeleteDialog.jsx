import React, { useCallback, useMemo, useState } from 'react';
import { DELETE_BLOCK_KINDS, readDeleteBlock } from './webpageDeleteBlock';
import { deleteWebpage } from './webpagesApi';
import DangerZone from '../../components/shared/DangerZone';
import Modal from '../../components/shared/Modal';
import { kindLabelFor } from '../../components/shared/UsedByTab';
import useTranslation from '../../hooks/useTranslation';
import useUsage from '../../hooks/useUsage';

/**
 * Deleting a webpage — the dialog behind the card's trash icon (W5 deel C).
 *
 * It replaces a `confirm('Delete this webpage? This cannot be undone.')` that
 * asked a question the person had no way to answer. A page is not a local
 * object: a Solution has taken it into a screen, a build conversation hangs
 * off it, an agent may be allowed to open it. So the dialog answers the
 * question FIRST — with the same list `GET /api/webpages/:id/usage` feeds the
 * Used-by tab, so the tab and this dialog can never disagree about what
 * breaks — and only then asks for the name.
 *
 * ── WHAT IT SAYS OUT LOUD ───────────────────────────────────────────
 *
 * That deleting does NOT stop any of it. Nothing below is told; what points
 * at this page keeps pointing at a page that is gone, and what lives on the
 * page goes with it. The same sentence the agent delete owes its reader
 * (`components/agents/AgentStudio/DeleteBlockedNotice.jsx`), for the same
 * reason: somebody about to press a red button is owed it.
 *
 * ── "IN USE" AND "COULD NOT CHECK" ARE DIFFERENT ANSWERS ────────────
 *
 * Both refuse, and both come back as one 409. Only the first is a list. The
 * server's `unchecked` names the kinds whose scan did not answer, and it must
 * survive the whole way to the screen: an empty list presented as a complete
 * one is exactly the sentence somebody presses through. Three places keep
 * that distinction alive here:
 *
 *   - `uncheckedKinds` falls back to EVERY kind when the usage read itself
 *     failed. `useUsage` turns a failed read into `[]` with an error set —
 *     honest for a tab, fatal for a delete gate, because `[]` renders as
 *     "nothing uses this". Unknown narrows.
 *   - it is passed to `DangerZone` as `unchecked`, which then withholds the
 *     "nothing uses this" claim instead of making it;
 *   - and the notice above the name field names the kinds, so the person is
 *     shown what could not be checked before they type.
 *
 * ── THE SECOND PRESS IS WHAT CONFIRMS, NOT THE FIRST ────────────────
 *
 * `?confirm=1` tells the server to SKIP its check. So the first press must go
 * out without it, whatever the screen already believes: between the moment the
 * list was fetched and the moment the button is pressed a colleague can take
 * the page into a Solution, and the 409 is the only thing that catches that.
 * `unchecked` being non-empty is not consent — it is permanently non-empty
 * here, because two of the server's kinds can never be answered, so OR-ing it
 * into the flag would send every first press pre-confirmed and retire the guard
 * for this product entirely.
 *
 * What makes the second press safe is that the server has ALREADY spoken:
 * `block` holds its refusal, the list on screen is the server's own fresher
 * one, and `DangerZone` has cleared the typed name and asked for it again. Only
 * then does the confirmed request go out. (Counting rows the way `DangerZone`
 * does is not enough on its own: a refusal with an empty `usage` — the ordinary
 * case here — would press into the same 409 for ever.)
 *
 * A 409 is read by `readDeleteBlock` for its `unchecked` half — `DangerZone`
 * only reads `usage` — and then RE-THROWN, so the danger zone still re-shows
 * the server's fresher list and asks for the name again.
 */
export default function WebpageDeleteDialog({
    webpage,
    currentUserId = null,
    onClose,
    onDeleted,
    onNavigate = null,
}) {
    const { t } = useTranslation();
    const id = webpage?.id || null;
    const { usage, unchecked, error: usageError } = useUsage('webpage', id);

    // What the server said when it refused. Fresher than the list we fetched,
    // so it wins from the moment it exists.
    const [block, setBlock] = useState(null);

    const uncheckedKinds = useMemo(() => {
        if (block) return block.unchecked;
        // A read that failed is itself a "could not check" — every kind of it.
        if (usageError) return [...DELETE_BLOCK_KINDS];
        return unchecked || [];
    }, [block, usageError, unchecked]);

    const rows = block ? block.usage : (usage || []);
    const hasFindings = rows.length > 0;
    // The list could not be read at all: neither the fetch nor a refusal
    // produced one. Louder than "some kinds are missing".
    const unreadable = block ? !block.readable : !!usageError;

    const handleDelete = useCallback(async (confirmedBreaking) => {
        if (!id) return undefined;
        try {
            const result = await deleteWebpage(id, {
                // `block` is the server's own refusal to THIS dialog: it has
                // done its check, the person has seen the answer and typed the
                // name against it. That — not the shape of the list — is what
                // the confirmed request stands for.
                confirmedBreaking: confirmedBreaking || block !== null,
            });
            onDeleted?.(id);
            return result;
        } catch (e) {
            const refused = readDeleteBlock(e);
            if (refused.blocked) setBlock(refused);
            // Re-thrown on purpose: DangerZone turns the same 409 into the
            // fresh list plus a second request for the name. Swallowing it
            // here would leave the card spinning on a refusal.
            throw e;
        }
    }, [id, block, onDeleted]);

    if (!webpage) return null;

    return (
        <Modal
            open
            onClose={onClose}
            size="lg"
            disableBackdropClose
            title={t('webpages.delete.title', 'Delete webpage')}
            description={webpage.name || undefined}
        >
            <DangerZone
                className="mt-0 pt-0 border-t-0"
                entityName={webpage.name || ''}
                usage={usage}
                unchecked={uncheckedKinds}
                onDelete={handleDelete}
                onCancel={onClose}
                defaultArmed
                requireName={uncheckedKinds.length > 0}
                kindLabel={t('usage.kind_webpage', 'webpage')}
                currentUserId={currentUserId}
                onNavigate={onNavigate}
                notice={<DeleteNotice t={t} hasFindings={hasFindings} unchecked={uncheckedKinds} unreadable={unreadable} />}
            />
        </Modal>
    );
}

/**
 * What deleting does not stop, what could not be checked, and whether the
 * check answered at all — three sentences, kept apart. Its own component for
 * the reason `AgentStudio/DeleteBlockedNotice.jsx` is one: the halves must not
 * blur into each other anywhere, and only one of them is ever a list.
 */
function DeleteNotice({ t, hasFindings, unchecked, unreadable }) {
    return (
        <div className="space-y-2" data-testid="webpage-delete-notice">
            {hasFindings ? (
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }} data-testid="webpage-delete-does-not-stop">
                    {t('webpages.delete.does_not_stop',
                        'Deleting is not announced and not undone. What points at this page keeps pointing at a page that is gone; what lives on the page goes with it.')}
                </p>
            ) : (
                // Nothing was FOUND — which is not the same as nothing being
                // there. Claiming "these things use it" over an empty list
                // would claim a scan succeeded that did not.
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }} data-testid="webpage-delete-unknown">
                    {t('webpages.delete.unknown_intro',
                        'The check did not finish, so what still uses this page is unknown. Deleting now is a decision made without that answer.')}
                </p>
            )}
            {unchecked.length > 0 && (
                <p className="text-xs" style={{ color: 'var(--warning)' }} data-testid="webpage-delete-unchecked">
                    {t('webpages.delete.unchecked',
                        'Could not be checked: {kinds}. Treat this list as incomplete, not as “nothing uses this page”.',
                        { kinds: unchecked.map((k) => kindLabelFor(t, k, 2)).join(', ') })}
                </p>
            )}
            {unreadable && (
                <p className="text-xs" style={{ color: 'var(--warning)' }} data-testid="webpage-delete-unreadable">
                    {t('webpages.delete.unreadable',
                        'The check did not answer at all, so nothing below is a complete list.')}
                </p>
            )}
        </div>
    );
}
