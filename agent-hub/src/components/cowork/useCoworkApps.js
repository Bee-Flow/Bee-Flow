/**
 * The Apps picker's state for ONE cowork item.
 *
 * A cowork item may carry its own list of apps — "this digest may read my
 * mail, that reminder may not" — because it runs unattended, hours after you
 * decided, against whatever credentials you have. That is a narrower question
 * than the chat composer's picker, which edits the workspace-wide preference.
 *
 * Until the user touches the picker the item has no list of its own (`value`
 * is null) and inherits the workspace default, which is exactly how every
 * cowork behaved before this existed. The first toggle *materialises* that
 * inherited set and edits it from there, so switching one app off doesn't
 * silently switch every other app off with it.
 *
 * UNKNOWN NARROWS. `useAppsCatalog` answers "is this app on?" with `true`
 * whenever it holds no stored list — a sane default for chat, where you are
 * sitting in front of the answer. Here it is not: the workspace read can be
 * still in flight or have failed outright, and in both cases the hook has no
 * list at all, which reads as "everything on". This screen answers "what may
 * this unattended run touch with my credentials", so a missing answer must be
 * NO, never "yes, all of it". Only once the workspace read has actually
 * answered do we let the catalogue's default through.
 *
 * The same rule governs the LIST, not just the switches: with no readable
 * workspace read there is no org allow-list to apply, so the catalogue offers
 * apps the organisation has switched off — and one toggle stores them on the
 * item. Unknown offers nothing.
 *
 * EMPTY IS NOT UNREADABLE. A user with nothing connected and a user whose
 * list we could not fetch both end up with zero apps, and the screen has to be
 * able to tell them apart — hence `appsKnown` / `appsUnavailable` alongside
 * the list itself. `useIntegrationStatus` already separates the three cases
 * (not read yet / read failed / payload); this hook just carries that through
 * instead of flattening it into an empty array.
 */
import { useCallback } from 'react';
import useAppsCatalog from '../../hooks/useAppsCatalog';
import { useIntegrationStatus } from '../../hooks/useIntegrationStatus';

/** One frozen empty list, so "we don't know" is a stable identity. */
const EMPTY_APPS = [];

export default function useCoworkApps({ agentIntegrations = null, value = null, onChange } = {}) {
    const {
        availableApps: catalogueApps,
        isAppEnabled: isGloballyEnabled,
        toggleApp: toggleGlobally,
    } = useAppsCatalog({ agentIntegrations });

    // Same module-cached read useAppsCatalog does, so this costs no extra
    // request — but read for its THIRD answer, which that hook drops.
    const { integrationStatus, unavailable } = useIntegrationStatus();
    const appsUnavailable = unavailable === true;
    const appsKnown = !appsUnavailable && integrationStatus != null;

    // UNKNOWN NARROWS applies to the LIST as well, not only to the switches.
    // `filterAvailableApps` skips the org allow-list entirely when
    // `orgEnabledIntegrations` is missing — which is exactly what it is while
    // the workspace read is in flight or after it failed. An MCP server the
    // organisation switched off is therefore OFFERED during a failed read, and
    // `toggleApp` writes whatever is offered into the item's own list: the
    // unknown state gets recorded as an explicit, stored permission on a
    // schedule that runs unattended. So while we cannot read the workspace we
    // offer nothing, and the surfaces say so instead (`appsUnavailable`).
    const availableApps = appsKnown ? catalogueApps : EMPTY_APPS;

    const hasOwnList = Array.isArray(value);

    const isAppEnabled = useCallback(
        (appId) => {
            // The item's own list is an answer we have, whatever the network
            // did afterwards: it was stored on purpose and it only ever
            // narrows. Keep answering from it.
            if (hasOwnList) return value.includes(appId);
            // No list of its own, and no readable workspace list either — we
            // do not know what this run may touch, so we claim nothing.
            if (!appsKnown) return false;
            return isGloballyEnabled(appId);
        },
        [hasOwnList, value, appsKnown, isGloballyEnabled],
    );

    const toggleApp = useCallback((appId) => {
        // No onChange means nobody is holding a per-item list — fall back to
        // editing the workspace preference, which is what the chat does.
        if (typeof onChange !== 'function') {
            toggleGlobally(appId);
            return;
        }
        // Steps are always on and are never part of the stored list.
        const base = hasOwnList
            ? value
            : availableApps.filter(a => !a.isStep && isAppEnabled(a.id)).map(a => a.id);
        onChange(base.includes(appId) ? base.filter(id => id !== appId) : [...base, appId]);
    }, [onChange, hasOwnList, value, availableApps, isAppEnabled, toggleGlobally]);

    return { availableApps, isAppEnabled, toggleApp, hasOwnList, appsKnown, appsUnavailable };
}
