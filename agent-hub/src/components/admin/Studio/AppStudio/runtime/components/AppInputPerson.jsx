import { useMemo } from 'react';
import { Monogram } from './cellValue';
import ComboBox, { BindingLoader, useHasQueryClient } from './comboBox';
import useTranslation from '../../../../../../hooks/useTranslation';
import { useDataContext } from '../DataContext';
import { useFormContext, useFormField } from '../formContext';
import { hoverable } from '../hoverable';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';

/**
 * App Studio runtime — 'input_person'. Spec: server/appStudio/componentSpecs.js.
 *
 * Picks a real member of the organisation and submits their USER ID, so
 * "assigned to me" can be answered against `currentUser.id` rather than against
 * a name someone typed. Until this existed, every template that tracked an
 * owner stored a free-text name and matched it by e-mail, which meant work
 * could be assigned to a person who did not exist and "mine" was a string
 * comparison hoping for the best.
 *
 * The list comes from the reserved platform dataset `sys_org_members`, which
 * the server answers only when the app has declared `directory.orgMembers` and
 * only for people in the app's own organisation. It carries no e-mail
 * addresses — a picker needs a label, not a way to contact everyone.
 *
 * ALSO PUBLISHES `<name>_label`. The platform has no joins, so a row that wants
 * to show who owns it has to store the name beside the id; the server has no
 * directory to look it up from at write time. Actions therefore read
 * `form.assignee_id` and `form.assignee_id_label` together. This is the one
 * piece of the contract an author has to know, so it is in the spec text too.
 */

export const ORG_MEMBERS_DATASET = 'sys_org_members';

const MEMBERS_BINDING = Object.freeze({ kind: 'dataset', datasetId: ORG_MEMBERS_DATASET });

function PersonOption({ label }) {
    return (
        <span className="inline-flex items-center gap-2 min-w-0">
            <Monogram name={label} />
            <span className="truncate" {...hoverable(label)}>{label}</span>
        </span>
    );
}

export default function AppInputPerson({ node }) {
    const { t } = useTranslation();
    const { mode, actionState, dataState, scope } = useRuntime();
    const { appId, dataState: scopedDataState } = useDataContext();
    const form = useFormContext();
    const hasQueryClient = useHasQueryClient();
    const {
        name, label = t('studio_apps_runtime.inputs.person', 'Person'), multiple = false, required = false, allowMe = true,
    } = node.props || {};
    const { value, setValue, error } = useFormField({
        name, defaultValue: multiple ? [] : null, required, label,
    });
    const id = `${node.id}-input`;

    const mergedDataState = { ...scopedDataState, ...dataState };
    const { value: rows, isLoading, error: loadError } = resolveBinding(MEMBERS_BINDING, { actionState, dataState: mergedDataState, scope });
    // Without a query client there is no fetch — the screenshot renderer mounts
    // the runtime with no provider, and a picker that threw there would take
    // every template screenshot down with it.
    const canFetch = !!appId && hasQueryClient;

    const options = useMemo(() => (Array.isArray(rows) ? rows : [])
        .filter((r) => r && r.id)
        .map((r) => ({ id: r.id, label: r.name || r.username || r.id })), [rows]);

    // "Me" is the answer often enough to be worth one guaranteed click, and it
    // works before the directory has loaded — the viewer's own identity is
    // already in scope.
    const me = scope?.currentUser;
    const pinned = allowMe && me?.id ? { id: me.id, label: me.name || me.id, pinned: true } : null;

    const selectedIds = multiple ? (Array.isArray(value) ? value : []) : (value != null ? [value] : []);
    const labelOf = (cid) => {
        if (pinned && cid === pinned.id) return pinned.label;
        return options.find((o) => o.id === cid)?.label ?? String(cid);
    };

    // The denormalised name travels beside the id so an action can write both.
    const publishLabel = (cid) => {
        if (!form || !name) return;
        form.setValue(`${name}_label`, cid == null ? null : labelOf(cid));
    };

    return (
        <>
            {canFetch ? <BindingLoader binding={MEMBERS_BINDING} sample={mode !== 'run'} /> : null}
            <ComboBox
                id={id}
                label={label}
                required={required}
                error={error}
                options={options}
                pinned={pinned}
                selectedIds={selectedIds}
                multiple={multiple}
                placeholder={t('studio_apps_runtime.inputs.search_people', 'Search people…')}
                isLoading={isLoading}
                loadError={loadError}
                emptyText={t('studio_apps_runtime.inputs.no_people', 'No matching people.')}
                renderOption={(o) => <PersonOption label={o.pinned ? `${o.label} (me)` : o.label} />}
                renderChip={(o) => (
                    <span className="inline-flex items-center gap-1">
                        <Monogram name={o.label} size={16} />
                        {o.label}
                    </span>
                )}
                onPick={(cid) => {
                    if (multiple) {
                        if (!selectedIds.includes(cid)) setValue([...selectedIds, cid]);
                    } else {
                        setValue(cid);
                        publishLabel(cid);
                    }
                }}
                onRemove={(cid) => {
                    if (multiple) setValue(selectedIds.filter((x) => x !== cid));
                    else { setValue(null); publishLabel(null); }
                }}
            />
        </>
    );
}
