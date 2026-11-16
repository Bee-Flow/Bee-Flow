// The config the Agent Hub designer panel sends on a save. The server stores
// the `config` of PUT /agents/:id whole, and the panel's copy is the one it
// loaded (the hub's list row, possibly the published copy). Agent Studio may
// have changed the DRAFT since, so a save starts from the draft as stored now
// and lays only the keys the panel edited over it.

type Config = Record<string, unknown>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `draft` with the panel's edits applied: a key whose value in `edited`
 * differs from `loaded` takes the edited value, a key the panel removed is
 * removed, every other key keeps the draft's value.
 */
export function panelConfigForSave(draft: Config, loaded: Config, edited: Config): Config {
    const out: Config = { ...draft };
    for (const key of Object.keys(edited)) {
        if (!same(edited[key], loaded[key])) out[key] = edited[key];
    }
    for (const key of Object.keys(loaded)) {
        if (!(key in edited)) delete out[key];
    }
    return out;
}
