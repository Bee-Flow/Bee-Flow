// @typecheck
/**
 * Dependency-free, total semver comparison for module compatibility gates.
 *
 * "Total" means every function is defined for every input and NEVER throws:
 * parse() coerces junk to 0 and strips build metadata, so callers can compare
 * malformed version strings safely. Only the numeric MAJOR.MINOR.PATCH triple
 * plus prerelease precedence matters here — enough for min/max app-version
 * gates on installable modules. This is not a full semver range engine.
 */

/**
 * Parse a version string into its numeric core + prerelease tag.
 * Tolerant: leading `v`/`=`/whitespace is stripped, `+build` metadata is
 * discarded, and any non-numeric core segment coerces to 0.
 * @param {*} v
 * @returns {{major:number, minor:number, patch:number, prerelease:string}}
 */
function parse(v) {
    let s = v == null ? '' : String(v);
    s = s.trim().replace(/^[v=\s]+/, '');

    // Drop build metadata (everything after the first '+').
    const plus = s.indexOf('+');
    if (plus !== -1) s = s.slice(0, plus);

    // Split the prerelease tag (everything after the first '-') from the core.
    let core = s;
    let prerelease = '';
    const dash = s.indexOf('-');
    if (dash !== -1) {
        core = s.slice(0, dash);
        prerelease = s.slice(dash + 1);
    }

    const nums = core.split('.');
    const toInt = (x) => {
        const n = parseInt(x, 10);
        return Number.isFinite(n) && n >= 0 ? n : 0;
    };

    return {
        major: toInt(nums[0]),
        minor: toInt(nums[1]),
        patch: toInt(nums[2]),
        prerelease: prerelease || '',
    };
}

/**
 * Compare two prerelease tags per semver §11: a version WITH a prerelease has
 * LOWER precedence than the same version without one; otherwise identifiers
 * are compared dot-by-dot (numeric < numeric numerically, numeric < alnum,
 * alnum lexically, and a shorter run of identifiers sorts lower).
 * @returns {-1|0|1}
 */
function comparePrerelease(a, b) {
    if (a === b) return 0;
    if (a === '') return 1;  // no prerelease > has prerelease
    if (b === '') return -1;

    const as = a.split('.');
    const bs = b.split('.');
    const len = Math.max(as.length, bs.length);
    for (let i = 0; i < len; i++) {
        const ai = as[i];
        const bi = bs[i];
        if (ai === undefined) return -1;
        if (bi === undefined) return 1;
        if (ai === bi) continue;
        const aNum = /^\d+$/.test(ai);
        const bNum = /^\d+$/.test(bi);
        if (aNum && bNum) {
            const d = parseInt(ai, 10) - parseInt(bi, 10);
            if (d !== 0) return d < 0 ? -1 : 1;
        } else if (aNum) {
            return -1; // numeric identifiers rank lower than alphanumeric
        } else if (bNum) {
            return 1;
        } else {
            return ai < bi ? -1 : 1;
        }
    }
    return 0;
}

/**
 * Compare versions a and b. Returns -1 if a < b, 1 if a > b, 0 if equal.
 * @returns {-1|0|1}
 */
function compare(a, b) {
    const pa = parse(a);
    const pb = parse(b);
    if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
    if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
    if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
    return comparePrerelease(pa.prerelease, pb.prerelease);
}

function gt(a, b) { return compare(a, b) > 0; }
function lt(a, b) { return compare(a, b) < 0; }
function gte(a, b) { return compare(a, b) >= 0; }
function lte(a, b) { return compare(a, b) <= 0; }
function eq(a, b) { return compare(a, b) === 0; }

/**
 * True when `version` satisfies a minimum. A null/undefined/'' minimum means
 * "no lower bound" and always passes.
 */
function satisfiesMin(version, minVersion) {
    if (minVersion == null || minVersion === '') return true;
    return gte(version, minVersion);
}

/**
 * True when `version` satisfies a maximum. A null/undefined/'' maximum means
 * "no upper bound" and always passes.
 */
function satisfiesMax(version, maxVersion) {
    if (maxVersion == null || maxVersion === '') return true;
    return lte(version, maxVersion);
}

/** Same MAJOR? (update-pin 'major' allows 1.2.3 → 1.9.0, not → 2.0.0) */
function sameMajor(a, b) {
    return parse(a).major === parse(b).major;
}

/** Same MAJOR.MINOR? (update-pin 'minor' allows 1.2.3 → 1.2.9, not → 1.3.0) */
function sameMinor(a, b) {
    const pa = parse(a);
    const pb = parse(b);
    return pa.major === pb.major && pa.minor === pb.minor;
}

module.exports = {
    parse,
    compare,
    gt,
    lt,
    gte,
    lte,
    eq,
    satisfiesMin,
    satisfiesMax,
    sameMajor,
    sameMinor,
};
