/**
 * The Condition node's model fallback, as a request — kept out of the
 * component so the one thing that matters about it can be tested without
 * rendering anything.
 *
 * WHAT MATTERS is that field NAMES go and rows do not. A Condition node in
 * this product routinely sits over customer records, and personal data does
 * not leave Bee Flow (CLAUDE.md, BFSF-441). The editor's own field options
 * carry a `sample` value each — a real cell from the data — so passing them
 * through would put customer data in the request, and a property added to
 * that object next year would start travelling by itself. The payload is
 * therefore built from three NAMED keys rather than by deleting the ones we
 * do not want: an allow-list cannot leak a field nobody has thought of yet.
 * The server applies the same rule again on arrival.
 *
 * Nothing here is React and nothing here holds state; the component owns
 * both.
 */

/**
 * Ask the model — with the field NAMES, never the rows.
 *
 * The payload is assembled from three NAMED keys instead of passing the
 * editor's `fields` through, because each of those options carries a `sample`
 * value: handing them over wholesale would put real customer data in the
 * request, and a property added to that object next year would start
 * travelling by itself. Building it positively means only what is listed
 * goes. Same rule the server applies again on arrival, and the same rule
 * CLAUDE.md states for every outbound payload in this product.
 */
export async function askModelForRules(api, { description, fields, itemVar, perItem }) {
    const res = await api.suggestRouteRules({
        description: String(description || '').trim(),
        fields: (fields || []).map(f => ({ key: f.path, name: f.label, type: f.type || '' })),
        itemVar,
        perItem,
    });
    return {
        rules: Array.isArray(res?.rules) ? res.rules : [],
        problem: typeof res?.problem === 'string' ? res.problem : '',
        understood: 'Written by the AI from your description',
    };
}

/**
 * What to say when the ask did not happen. A box with no model behind it is
 * the NORMAL state on a self-hosted install — which is what this product is
 * — so the refusal is plain rather than hidden, and it says that the offline
 * half still works, because it does.
 */
export function askFailureMessage(e) {
    return e?.status === 403
        ? 'The AI builder is not switched on for your organisation, so this box can only answer what it knows offline.'
        : 'Could not reach the AI just now. The offline suggestions above still work.';
}
