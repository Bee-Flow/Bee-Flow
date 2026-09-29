// Reading a Bash or PowerShell command line well enough to tell whether it
// makes a git commit, and where.
//
// The hooks used to regex the whole string: /\bgit\b[\s\S]*\bcommit\b/ fired
// on a PR body or a commit message that mentioned "git commit", and a
// `--dry-run` ANYWHERE in the string (inside a message, or in a later
// `echo`) switched the secret scan off for a real commit. So: split the line
// into its simple commands on the separators outside quotes, split each into
// words the way the shell would, and read git's own argument grammar.
//
// Not a shell parser. It understands '…', "…", backslash escapes (PowerShell:
// backtick), $(…) and `…` substitutions, heredocs (<<EOF, <<'EOF', <<-EOF),
// PowerShell here-strings (@"…"@) and # comments. Anything stranger ends up
// as an unrecognised command, and the callers decide how to treat that.
//
// The reading has to be at least as wide as the regex it replaced: a commit
// it does not see is a commit the secret scan skips. So it also looks past
// the words in front of a command (`if`, `then`, `do`, `timeout 60`,
// `$out =`, PowerShell's `try {`), into every $(…) and `…`, and into the
// scripts that `bash -c`, `pwsh -Command` and `cmd /c` run. What it still
// cannot read, pre-commit-secret-scan.mjs catches with the old regex.

import os from 'node:os';
import path from 'node:path';

/** How deep $( … ) may nest before the rest of the line is left unparsed. */
const MAX_NESTING = 64;

/**
 * Split a command line into its simple commands.
 *
 * Separators, outside quotes and substitutions: && || ; | |& & ( ) and
 * newlines; in PowerShell also { and }, which open and close its script
 * blocks (`if ($?) {git commit}`, `try { … } finally { … }`). A heredoc body
 * belongs to no segment: it is the input of the command before it, not a
 * command.
 *
 * Each segment also carries `subs`, the bodies of the outermost $(…) and
 * `…` in it (in quotes or not), which run as commands of their own; and
 * `scope`, the ( … ) groups it sits in, outermost first, each by an id of
 * its own, so a caller can tell where a bash subshell ends.
 *
 * @param {string} command
 * @param {{ powershell?: boolean }} [opts]
 * @returns {{ text: string, words: string[], subs: string[], scope: number[] }[]}
 */
export function parseSegments(command, { powershell = false } = {}) {
    // Semgrep's regex_dos rule flags the regexes below because they read this
    // string. Each is linear (no nested quantifiers) and the string is a
    // command line the session itself wrote; see MAX_NESTING for the one
    // input shape that did cost something.
    const s = String(command ?? ''); // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos
    const esc = powershell ? '`' : '\\';
    const segments = [];
    const heredocs = [];
    let i = 0;
    let segStart = 0;
    let words = [];
    let word = null;
    let commentAt = -1;
    let subs = [];
    let nesting = 0;
    const open = [];
    let groups = 0;

    const endWord = () => {
        if (word !== null) words.push(word);
        word = null;
    };
    const endSegment = (end) => {
        endWord();
        const text = s.slice(segStart, commentAt >= segStart ? Math.min(end, commentAt) : end).trim();
        if (text && words.length) segments.push({ text, words, subs, scope: open.slice() });
        words = [];
        subs = [];
        commentAt = -1;
    };

    // Each reader starts at its opening character, leaves `i` just past the
    // construct, and returns the value it contributes to the current word.
    function single() {
        const close = s.indexOf("'", i + 1);
        const end = close < 0 ? s.length : close;
        const value = s.slice(i + 1, end);
        i = Math.min(end + 1, s.length);
        return value;
    }

    function double() {
        let value = '';
        i++;
        while (i < s.length && s[i] !== '"') {
            const c = s[i];
            if (c === esc && i + 1 < s.length) {
                const n = s[i + 1];
                // An escaped newline joins the lines; bash keeps the backslash
                // before anything it does not escape inside double quotes.
                if (n !== '\n') value += powershell || '"\\$`'.includes(n) ? n : c + n;
                i += 2;
                continue;
            }
            if (c === '$' && s[i + 1] === '(') {
                value += substitution();
                continue;
            }
            if (c === '`' && !powershell) {
                value += backtick();
                continue;
            }
            value += c;
            i++;
        }
        if (i < s.length) i++;
        return value;
    }

    // Only the outermost substitution is kept as a body: a caller parses
    // that body again and finds the ones inside it then.
    function backtick() {
        const start = i;
        i++;
        while (i < s.length && s[i] !== '`') i += s[i] === '\\' ? 2 : 1;
        const closed = i < s.length;
        i = Math.min(i + 1, s.length);
        if (nesting === 0) subs.push(s.slice(start + 1, closed ? i - 1 : i).replace(/\\([\\`$])/g, '$1'));
        return s.slice(start, i);
    }

    // PowerShell here-string: @" or @' at the end of a line, closed by "@ or
    // '@ at the start of one. The quotes inside do not end it.
    function hereString() {
        const quote = s[i + 1];
        const bodyStart = s.indexOf('\n', i) + 1;
        const close = s.indexOf(`\n${quote}@`, bodyStart - 1);
        const end = close < 0 ? s.length : close;
        const value = s.slice(bodyStart, end).replace(/\r$/, '');
        i = close < 0 ? s.length : close + 3;
        return value;
    }

    function substitution() {
        const start = i;
        i += 2;
        // Deeper than any real command line: 20,000 nested $( overflowed the
        // stack, and a hook that throws lets the commit through unscanned.
        // The rest is kept as opaque text; the commit hook's backstop scans
        // any command that mentions git … commit and yields no commit here.
        if (nesting >= MAX_NESTING) {
            i = s.length;
            return s.slice(start);
        }
        nesting++;
        const closed = scan(true);
        nesting--;
        if (nesting === 0) subs.push(s.slice(start + 2, closed ? i - 1 : i));
        return s.slice(start, i);
    }

    // <<WORD, <<-WORD, <<'WORD', <<"WORD": remember the delimiter, and skip
    // the body at the next newline. `<<<` (a here-string) and `1 << 2` are
    // not heredocs.
    function heredoc() {
        let j = i + 2;
        let strip = false;
        if (s[j] === '-') {
            strip = true;
            j++;
        }
        while (s[j] === ' ' || s[j] === '\t') j++;
        const m = /^(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z_][\w.-]*))/.exec(s.slice(j));
        if (!m) return false;
        heredocs.push({ delim: m[1] ?? m[2] ?? m[3], strip });
        i = j + m[0].length;
        return true;
    }

    function skipHeredocBodies() {
        while (heredocs.length) {
            const { delim, strip } = heredocs.shift();
            while (i < s.length) {
                let nl = s.indexOf('\n', i);
                if (nl < 0) nl = s.length;
                let line = s.slice(i, nl).replace(/\r$/, '');
                i = Math.min(nl + 1, s.length);
                if (strip) line = line.replace(/^\t+/, '');
                if (line === delim) break;
            }
        }
    }

    const atWordStart = () => i === 0 || /[\s;&|()]/.test(s[i - 1]);

    // The unquoted grammar, shared by the top level (which builds segments and
    // words) and the inside of $( … ) (which only has to find its `)`, and
    // says whether it did).
    function scan(nested) {
        const add = (value) => {
            if (!nested) word = (word ?? '') + value;
        };
        let depth = 0;
        while (i < s.length) {
            const c = s[i];
            const n = s[i + 1];
            if (c === "'") { add(single()); continue; }
            if (c === '"') { add(double()); continue; }
            if (powershell && c === '@' && (n === '"' || n === "'") && /^[ \t]*\r?\n/.test(s.slice(i + 2))) {
                add(hereString());
                continue;
            }
            if (c === '`' && !powershell) { add(backtick()); continue; }
            if (c === esc) {
                if (n === '\n') { i += 2; continue; }
                add(n ?? '');
                i += 2;
                continue;
            }
            if (c === '$' && n === '(') { add(substitution()); continue; }
            if (c === '#' && atWordStart()) {
                if (!nested && commentAt < 0) commentAt = i;
                while (i < s.length && s[i] !== '\n') i++;
                continue;
            }
            if (c === '<' && n === '<' && s[i + 2] === '<') {
                add('<<<');
                i += 3;
                continue;
            }
            if (c === '<' && n === '<' && heredoc()) {
                if (!nested) endWord();
                continue;
            }
            if (c === '\n') {
                if (nested) i++;
                else {
                    endSegment(i);
                    i++;
                }
                skipHeredocBodies();
                if (!nested) segStart = i;
                continue;
            }
            if (nested) {
                if (c === '(') depth++;
                else if (c === ')') {
                    if (depth === 0) { i++; return true; }
                    depth--;
                }
                i++;
                continue;
            }
            if (/\s/.test(c)) { endWord(); i++; continue; }
            const two = c + (n ?? '');
            const sep = two === '&&' || two === '||' || two === '|&' ? 2
                : c === ';' || c === '|' || c === '(' || c === ')' ? 1
                    : powershell && (c === '{' || c === '}') ? 1
                        // `&` alone runs in the background; in 2>&1, >&2 or &> it is a redirection.
                        : c === '&' && !/[<>]$/.test(word ?? '') && n !== '>' ? 1
                            : 0;
            if (sep) {
                endSegment(i);
                if (c === '(') open.push(++groups);
                else if (c === ')') open.pop();
                i += sep;
                segStart = i;
                continue;
            }
            add(c);
            i++;
        }
        return false;
    }

    scan(false);
    endSegment(s.length);
    return segments;
}

/** The segments as text. */
export function splitSegments(command, opts) {
    return parseSegments(command, opts).map((seg) => seg.text);
}

const toWords = (segment, opts) =>
    Array.isArray(segment) ? segment
        : typeof segment === 'object' && segment ? segment.words
            : parseSegments(segment, opts)[0]?.words ?? [];

// Words that come before the command itself: `{ git …`, `! git …`, bash's
// reserved words (`if git commit …; then git push; fi`, `do git commit`),
// PowerShell's (`try`, `else`). Only a leading run is skipped, so a `do` in
// a commit message stays a word.
const PREFIX_WORDS = new Set(['{', '}', '!', 'if', 'then', 'elif', 'else', 'do', 'while', 'until', 'fi', 'done',
    'try', 'catch', 'finally', 'elseif']);

// Commands that run the rest of their words as a command: the options they
// take a value for, and how many plain words come before that command
// (timeout's duration). `timeout -s KILL 60 git commit` is a commit.
const WRAPPERS = new Map([
    ['time', {}],
    ['nohup', {}],
    ['command', {}],
    ['exec', { value: ['-a'] }],
    ['env', { value: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'] }],
    ['sudo', { value: ['-u', '--user', '-g', '--group', '-C', '--close-from', '-D', '--chdir', '-p', '--prompt',
        '-r', '--role', '-t', '--type', '-U', '--other-user', '-T', '--command-timeout'] }],
    ['timeout', { value: ['-s', '--signal', '-k', '--kill-after'], positional: 1 }],
    ['nice', { value: ['-n', '--adjustment'] }],
    ['xargs', { value: ['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '-n', '--max-args', '-P',
        '--max-procs', '-s', '--max-chars', '--process-slot-var'] }],
    ['stdbuf', { value: ['-i', '--input', '-o', '--output', '-e', '--error'] }],
]);

// `FOO=1 git …`, `X+=1 git …`; PowerShell's `$out = git …`, `$out=git …`.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const PS_VARIABLE = /^\$[\w:]+$/;
const PS_ASSIGN_OP = /^[-+*/%]?=$/;
const PS_GLUED_ASSIGNMENT = /^\$[\w:]+[-+*/%]?=/;

function commandWords(words) {
    const w = words.slice();
    let k = 0;
    while (k < w.length) {
        const word = w[k];
        if (ASSIGNMENT.test(word) || PREFIX_WORDS.has(word.toLowerCase()) || /^[{}]+$/.test(word)) { k++; continue; }
        if (PS_VARIABLE.test(word) && PS_ASSIGN_OP.test(w[k + 1] ?? '')) { k += 2; continue; }
        if (PS_GLUED_ASSIGNMENT.test(word)) {
            w[k] = word.replace(PS_GLUED_ASSIGNMENT, '');
            if (!w[k]) k++;
            continue;
        }
        // `{git commit}`: a brace glued to the command. Not bash, but a
        // commit either way.
        if (/^[{}]/.test(word)) { w[k] = word.replace(/^[{}]+/, ''); continue; }
        const wrapper = WRAPPERS.get(word);
        if (wrapper) {
            const { value = [], positional = 0 } = wrapper;
            k++;
            while (k < w.length && w[k].length > 1 && w[k].startsWith('-')) {
                if (w[k] === '--') { k++; break; }
                k += value.includes(w[k]) ? 2 : 1;
            }
            k += positional;
            continue;
        }
        break;
    }
    return w.slice(k);
}

const baseName = (w) => String(w).split(/[\\/]/).pop();

// git's own options before the subcommand that take the next word as their value.
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source']);

/**
 * `git [global options] <subcommand> [args]`, or null when the segment is
 * not a git command. `dirs` are the -C directories in order, `configs` the
 * -c key=value pairs.
 */
export function gitInvocation(segment, opts) {
    const w = commandWords(toWords(segment, opts));
    if (!w.length || !/^git(\.exe)?$/i.test(baseName(w[0]))) return null;
    const dirs = [];
    const configs = [];
    let k = 1;
    while (k < w.length && w[k].startsWith('-')) {
        const o = w[k];
        if (o === '-C' && k + 1 < w.length) dirs.push(w[k + 1]);
        if (o === '-c' && k + 1 < w.length) configs.push(w[k + 1]);
        k += GIT_VALUE_OPTS.has(o) ? 2 : 1;
    }
    if (k >= w.length) return null;
    // `{git commit}` leaves the brace on the subcommand.
    return { subcommand: w[k].replace(/\}+$/, ''), dirs, configs, args: w.slice(k + 1) };
}

// git commit's options that take a value: short ones take the rest of their
// bundle or the next word (-m msg, -mmsg, -am msg), long ones `=value` or the
// next word. -S and -u take an optional value, attached only.
const COMMIT_VALUE_SHORT = new Set(['m', 'F', 'c', 'C', 't']);
const COMMIT_VALUE_LONG = ['--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author',
    '--date', '--cleanup', '--fixup', '--squash', '--trailer', '--pathspec-from-file'];

// git accepts any unambiguous prefix of a long option, so `--dry` is --dry-run.
const isPrefixOf = (full, name, min) => name.length >= min && full.startsWith(name);

/**
 * The flags of a `git commit` that matter to the hooks, from its arguments.
 * `all` is -a/--all: the commit stages every tracked file's working-tree
 * copy itself, so what the index held before does not get recorded.
 */
export function commitFlags(args) {
    let dryRun = false;
    let noVerify = false;
    let all = false;
    for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (a === '--') break;
        if (a.startsWith('--')) {
            const [name] = a.split('=');
            if (isPrefixOf('--dry-run', name, 4)) dryRun = true;
            else if (isPrefixOf('--no-verify', name, 6)) noVerify = true;
            else if (name === '--verify') noVerify = false;
            // Exactly: `--al` could as well be --allow-empty.
            else if (name === '--all') all = true;
            else if (!a.includes('=') && COMMIT_VALUE_LONG.some((o) => isPrefixOf(o, name, 4))) k++;
            continue;
        }
        if (a.length < 2 || !a.startsWith('-')) continue;
        for (let j = 1; j < a.length; j++) {
            const f = a[j];
            if (f === 'n') noVerify = true;
            if (f === 'a') all = true;
            if (COMMIT_VALUE_SHORT.has(f)) {
                if (j === a.length - 1) k++;
                break;
            }
            if (f === 'S' || f === 'u') break;
        }
    }
    return { dryRun, noVerify, all };
}

/** True for `git commit …`, `git -C dir commit …`, `git -c k=v commit …`. */
export function isGitCommit(segment, opts) {
    return gitInvocation(segment, opts)?.subcommand === 'commit';
}

/** True when --dry-run is a real option of this commit, not text in its message. */
export function isDryRun(segment, opts) {
    const git = gitInvocation(segment, opts);
    return git?.subcommand === 'commit' && commitFlags(git.args).dryRun;
}

// Git Bash on Windows spells C:\x as /c/x; node's path module does not.
function nativePath(p) {
    if (process.platform === 'win32') {
        const m = /^\/([A-Za-z])(\/.*)?$/.exec(p);
        if (m) return `${m[1]}:${m[2] || '/'}`;
    }
    return p;
}

/** Where `cd <target>` from `from` lands, or null when that is not knowable here. */
function changeDir(from, target) {
    if (target === undefined || target === '~') return os.homedir();
    if (/[$`*?]/.test(target) || target === '-' || /^[+-]\d+$/.test(target)) return null;
    if (target.startsWith('~/') || target.startsWith('~\\')) return path.join(os.homedir(), target.slice(2));
    if (target.startsWith('~')) return null;
    const t = nativePath(target);
    if (path.isAbsolute(t)) return path.resolve(t);
    return from ? path.resolve(from, t) : null;
}

/** The directory a cd/pushd/Set-Location names: -Path/-LiteralPath's value, else its first plain word. */
function dirTarget(args) {
    const at = args.findIndex((a) => /^-(path|literalpath)$/i.test(a));
    return at >= 0 ? args[at + 1] : args.find((a) => !a.startsWith('-') || a === '-');
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'bash.exe', 'sh.exe']);
const POWERSHELLS = new Set(['pwsh', 'pwsh.exe', 'powershell', 'powershell.exe']);
const CMD = new Set(['cmd', 'cmd.exe']);
const EVAL = new Set(['eval', 'invoke-expression', 'iex']);
const CD = new Set(['cd', 'chdir', 'set-location', 'sl']);
const PUSHD = new Set(['pushd', 'push-location']);
const POPD = new Set(['popd', 'pop-location']);

/**
 * The script a `bash -c`, `pwsh -Command`, `cmd /c` or `eval` segment runs,
 * and whether that script is PowerShell. Null for any other command.
 */
function innerScript(name, args, powershell) {
    let script;
    let ps = false;
    if (SHELLS.has(name)) {
        // bash [options] -c <script>: the script is the first word after the
        // options, and any bundle of short options can hold the c (-lc, -ec).
        let c = false;
        for (let k = 0; k < args.length && script === undefined; k++) {
            const a = args[k];
            if (a === '--' || !/^[-+]./.test(a)) {
                if (!c) return null;
                script = a === '--' ? args[k + 1] : a;
            } else if (/^[-+][oO]$/.test(a) || a === '--rcfile' || a === '--init-file') k++;
            else if (/^-[^-]*c/.test(a)) c = true;
        }
    } else if (POWERSHELLS.has(name)) {
        // -Command (or any prefix of it) takes the rest of the line.
        const at = args.findIndex((a) => /^[-/]c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(a));
        if (at >= 0) script = args.slice(at + 1).join(' ');
        ps = true;
    } else if (CMD.has(name)) {
        // Git Bash rewrites /c into a path, so there it is spelled //c.
        const at = args.findIndex((a) => /^(\/\/?|-)[ck]$/i.test(a));
        if (at >= 0) script = args.slice(at + 1).join(' ');
    } else if (EVAL.has(name)) {
        script = args.filter((a) => !/^-command$/i.test(a)).join(' ');
        ps = powershell;
    } else return null;
    return script === undefined ? null : { script, powershell: ps };
}

/**
 * Every `git commit` the command line runs, with the directory it runs in:
 * the caller's cwd, moved by any cd/pushd/popd before it and by git's -C.
 * `cwd` is null when a `cd` went somewhere this cannot know ($VAR, `cd -`,
 * a popd past what this line pushed). A bash ( … ) subshell's cd ends at its
 * `)`. Looks inside $(…) and `…`, `bash -c '…'`, `pwsh -Command '…'`,
 * `cmd /c …` and `eval '…'` too.
 *
 * @returns {{ text: string, cwd: string|null, dryRun: boolean, noVerify: boolean, all: boolean, hooksPathOverride: boolean }[]}
 */
export function findCommits(command, { cwd = null, powershell = false, depth = 0 } = {}) {
    const found = [];
    // Each $( … ), bash -c and eval body is parsed again one level down; past
    // MAX_NESTING levels the line is left unread (the commit hook's backstop
    // then scans it) rather than recursed into until the stack runs out.
    if (depth > MAX_NESTING) return found;
    let dir = cwd ? path.resolve(nativePath(cwd)) : null;
    let stack = [];
    // What dir and the pushd stack were on entering each ( … ) the current
    // segment sits in. PowerShell's ( … ) only groups: a cd in it stays.
    const saved = [];
    let scope = [];
    for (const seg of parseSegments(command, { powershell })) {
        if (!powershell) {
            let same = 0;
            while (same < scope.length && same < seg.scope.length && scope[same] === seg.scope[same]) same++;
            while (saved.length > same) ({ dir, stack } = saved.pop());
            while (saved.length < seg.scope.length) saved.push({ dir, stack: stack.slice() });
            scope = seg.scope;
        }
        // A substitution runs before the command it is part of, in a
        // subshell of its own.
        for (const sub of seg.subs) found.push(...findCommits(sub, { cwd: dir, powershell, depth: depth + 1 }));

        const w = commandWords(seg.words);
        if (!w.length) continue;
        const name = baseName(w[0]).toLowerCase();
        const args = w.slice(1);
        if (CD.has(name)) {
            dir = changeDir(dir, dirTarget(args));
            continue;
        }
        if (PUSHD.has(name)) {
            const target = dirTarget(args);
            // A bare pushd in bash swaps the top two; Push-Location stays put.
            if (target === undefined && !powershell) {
                if (stack.length) [dir, stack[stack.length - 1]] = [stack[stack.length - 1], dir];
            } else {
                stack.push(dir);
                if (target !== undefined) dir = changeDir(dir, target);
            }
            continue;
        }
        if (POPD.has(name)) {
            // popd +N, Pop-Location -StackName: not followed, so unknown.
            dir = stack.length && !args.some((a) => !/^-passthru$/i.test(a)) ? stack.pop() : null;
            continue;
        }
        const inner = innerScript(name, args, powershell);
        if (inner) {
            found.push(...findCommits(inner.script, { cwd: dir, powershell: inner.powershell, depth: depth + 1 }));
            continue;
        }
        const git = gitInvocation(w);
        if (!git || git.subcommand !== 'commit') continue;
        const flags = commitFlags(git.args);
        found.push({
            text: seg.text,
            cwd: git.dirs.reduce((d, x) => changeDir(d, x), dir),
            dryRun: flags.dryRun,
            noVerify: flags.noVerify,
            all: flags.all,
            hooksPathOverride: git.configs.some((c) => /^core\.hookspath=/i.test(c)),
        });
    }
    return found;
}
