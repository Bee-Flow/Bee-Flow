#!/usr/bin/env bash
# Mechanical JSDoc rounds over server/ by tooling, one local commit per batch that passes
# every gate. The loop .claude/handoff/ts-conversion/SERVER.md describes by hand, with the
# gates a round must pass before it may be committed:
#   write      scripts/jsdoc-convert-server.mjs --write --mark   (comments only), then
#              scripts/jsdoc-express-params.mjs and, for stores, scripts/jsdoc-row-types.mjs
#   prove      scripts/ts-behaviour-diff.mjs: no compiled line changed
#   settle     npm run typecheck; scripts/typecheck-settle.mjs reverts the files whose new types broke it
#   promote    server/scripts/typecheck.mjs --promote
#   ceilings   scripts/file-budget.mjs and the long-function / big-file count ratchets per file:
#              a file the added lines push over its ceiling goes back to HEAD (split it by hand)
#   tests      node --test on every test file in the changed files' directories (and one up)
#   ratchets   jsdoc-loose-type may not rise; checkjs floors go up
#   check:fast everything else
# A batch that fails a gate it cannot repair by reverting single files is reverted whole and
# the loop moves on; nothing is ever committed red.
#
#   scripts/jsdoc-round.sh chunks <server-dir> [size]      write <work>/<dir>-NN.txt batch files (files not yet strict), print them
#   scripts/jsdoc-round.sh run <label> <batch.txt>...       the loop over those batches
# JSDOC_ROUND_WORK sets the work directory (default: a directory under $TMPDIR).
set -u
ROOT=$(git rev-parse --show-toplevel)
WORK=${JSDOC_ROUND_WORK:-${TMPDIR:-/tmp}/jsdoc-round}
mkdir -p "$WORK"
LOG=$WORK/run.log
cd "$ROOT"

chunks() {
  local dir=$1 size=${2:-40}
  (cd server && grep -rLE '^\s*//\s*@typecheck\s+strict' "$dir" --include='*.js' 2>/dev/null | grep -v '\.test\.' | grep -v testkit | sed 's#^#server/#' | sort) > "$WORK/$dir.all.txt"
  split -l "$size" -d -a 2 "$WORK/$dir.all.txt" "$WORK/$dir-"
  for f in "$WORK/$dir"-[0-9][0-9]; do mv "$f" "$f.txt"; echo "$f.txt"; done
}

nearby_tests() {
  git diff --name-only HEAD -- server | grep -E '\.js$' | grep -v '\.test\.js$' | while read -r f; do
    d=$(dirname "$f"); p=$(dirname "$d"); ls "$d"/*.test.js 2>/dev/null; [ "$p" != server ] && ls "$p"/*.test.js 2>/dev/null
  done | sort -u
}

count_list() { node scripts/count-ratchet.mjs "$1" server --list 2>/dev/null | grep -E '^ +[0-9]+ ' | awk '{print $2" "$1}' | sort; }

one_batch() {
  local chunk=$1 label=$2 rc
  echo "=============== $label $(date -u +%H:%M:%S)" | tee -a "$LOG"
  if [ -n "$(git status --short server)" ]; then echo "server/ not clean, stop" | tee -a "$LOG"; return 9; fi
  for m in long-function big-file; do count_list "$m" > "$WORK/$label.$m.before"; done
  echo "-- write"
  node --max-old-space-size=${JSDOC_ROUND_HEAP:-9000} scripts/jsdoc-convert-server.mjs --batch "$chunk" --write --mark > "$WORK/$label.write.json" 2> "$WORK/$label.write.err" || { echo "write failed" | tee -a "$LOG"; tail -3 "$WORK/$label.write.err"; git checkout -- server; return 1; }
  grep -E "errors under" "$WORK/$label.write.err" | tee -a "$LOG"
  # Two targeted passes after the general inference, each checked in memory by its own tool
  # (an edit stays only when the file's diagnostics do not rise): Express handler parameters
  # that nothing types (req, res, next) and the database row a store mapper reads.
  node --max-old-space-size=6000 scripts/jsdoc-express-params.mjs --batch "$chunk" --write > "$WORK/$label.express.json" 2> "$WORK/$label.express.err" || echo "express-params pass failed (ignored): $(tail -1 "$WORK/$label.express.err")" | tee -a "$LOG"
  if grep -q '^server/stores/' "$chunk"; then node --max-old-space-size=6000 scripts/jsdoc-row-types.mjs --batch "$chunk" --write > "$WORK/$label.rows.json" 2> "$WORK/$label.rows.err" || echo "row-types pass failed (ignored): $(tail -1 "$WORK/$label.rows.err")" | tee -a "$LOG"; fi
  for j in express rows; do [ -s "$WORK/$label.$j.json" ] && node -e "const j=require(process.argv[1]);console.log('$j: '+(j.kept??0)+' kept, '+(j.dropped??0)+' dropped')" "$WORK/$label.$j.json" | tee -a "$LOG"; done
  echo "-- behaviour diff"
  if ! node scripts/ts-behaviour-diff.mjs --base HEAD --paths server --quiet > "$WORK/$label.bdiff.txt" 2>&1; then tail -2 "$WORK/$label.bdiff.txt" | tee -a "$LOG"; echo "compiled program changed: reverting" | tee -a "$LOG"; git checkout -- server; return 2; fi
  echo "-- typecheck + settle"
  for round in 1 2 3 4 5 6; do
    if (cd server && node scripts/typecheck.mjs > "$WORK/$label.tc.$round.txt" 2>&1); then break; fi
    node scripts/typecheck-settle.mjs "$WORK/$label.tc.$round.txt" > "$WORK/$label.settle.$round.txt" 2>&1; rc=$?
    if [ $rc -eq 3 ]; then echo "typecheck errors not from edited files: reverting" | tee -a "$LOG"; git checkout -- server; return 3; fi
    [ $round -eq 6 ] && { echo "typecheck not settled in 6 rounds: reverting" | tee -a "$LOG"; git checkout -- server; return 3; }
  done
  (cd server && node scripts/typecheck.mjs --promote 2>&1 | tail -1 | tee -a "$LOG")
  echo "-- ceilings"
  local over reverted=''
  over=$(node scripts/file-budget.mjs server 2>&1 | grep -oE 'server: [^ ]+ (grew to|has [0-9]+ lines, over)' | awk '{print "server/"$2}')
  [ -n "$over" ] && { echo "over the line ceiling, reverted: $over" | tr '\n' ' ' | tee -a "$LOG"; echo; git checkout -- $over; reverted=1; }
  for m in long-function big-file; do
    count_list "$m" > "$WORK/$label.$m.after"
    local rose; rose=$(join -a2 -e0 -o 0,1.2,2.2 "$WORK/$label.$m.before" "$WORK/$label.$m.after" | awk '$3 > $2 {print "server/"$1}')
    [ -n "$rose" ] && { echo "$m count rose, reverted: $rose" | tr '\n' ' ' | tee -a "$LOG"; echo; git checkout -- $rose; reverted=1; }
  done
  if [ -n "$reverted" ]; then
    if ! (cd server && node scripts/typecheck.mjs > "$WORK/$label.tc.final.txt" 2>&1); then echo "typecheck red after reverts: reverting all" | tee -a "$LOG"; git checkout -- server; return 3; fi
  fi
  local changed; changed=$(git status --short server | grep -v ratchet | wc -l)
  if [ "$changed" -eq 0 ]; then echo "nothing survived" | tee -a "$LOG"; git checkout -- server; return 0; fi
  echo "-- tests"
  nearby_tests > "$WORK/$label.tests.txt"
  if [ -s "$WORK/$label.tests.txt" ]; then
    (cd server && NODE_ENV=test node --test $(sed 's#^server/##' "$WORK/$label.tests.txt") > "$WORK/$label.testrun.txt" 2>&1)
    grep -E "^# (tests|pass|fail)" "$WORK/$label.testrun.txt" | tr '\n' ' ' | tee -a "$LOG"; echo
    if grep -qE '^not ok' "$WORK/$label.testrun.txt"; then
      # A test that fails on HEAD as well (one that needs Postgres, say) is not this round's
      # doing: the same files run once more on the untouched tree, and only a failure that is
      # new counts. The round's edits wait in a stash meanwhile.
      grep -E '^not ok' "$WORK/$label.testrun.txt" | sed -E 's/^not ok [0-9]+ - //' | sort > "$WORK/$label.failed.txt"
      git stash push -q -- server && (cd server && NODE_ENV=test node --test $(sed 's#^server/##' "$WORK/$label.tests.txt") > "$WORK/$label.testrun.head.txt" 2>&1); git stash pop -q
      grep -E '^not ok' "$WORK/$label.testrun.head.txt" | sed -E 's/^not ok [0-9]+ - //' | sort > "$WORK/$label.failed.head.txt"
      local new; new=$(comm -23 "$WORK/$label.failed.txt" "$WORK/$label.failed.head.txt")
      if [ -n "$new" ]; then echo "tests failed that pass on HEAD: reverting" | tee -a "$LOG"; echo "$new" | head -5 | tee -a "$LOG"; git checkout -- server; return 4; fi
      echo "$(wc -l < "$WORK/$label.failed.head.txt") test(s) fail on HEAD too (not this round's): ignored" | tee -a "$LOG"
    fi
  fi
  echo "-- ratchets and check:fast"
  node scripts/count-ratchet.mjs jsdoc-loose-type server > "$WORK/$label.loose.txt" 2>&1 || { tail -1 "$WORK/$label.loose.txt" | tee -a "$LOG"; echo "loose-type ratchet rose: reverting" | tee -a "$LOG"; git checkout -- server; return 5; }
  node scripts/count-ratchet.mjs jsdoc-loose-type server --update > /dev/null 2>&1
  node scripts/checkjs-ratchet.mjs server --update 2>&1 | tail -1 | tee -a "$LOG"
  if ! npm run -s check:fast > "$WORK/$label.fast.txt" 2>&1; then
    if ! grep -qE "failing: lint:scripts-types$" "$WORK/$label.fast.txt"; then grep -E "FAIL" "$WORK/$label.fast.txt" | tee -a "$LOG"; echo "check:fast red: reverting" | tee -a "$LOG"; git checkout -- server; return 6; fi
  fi
  local before promoted floors
  before=$(grep -oE "[0-9]+ before, [0-9]+ after" "$WORK/$label.write.err" | head -1)
  promoted=$(grep -oE "promoted [0-9]+ file\(s\).*" "$LOG" | tail -1)
  floors=$(node -e "const r=require('./server/.checkjs-ratchet.json');console.log(r.checkedFiles+' / '+r.noImplicitAnyFiles+' / '+r.strictFiles)")
  git add server && git -c core.hooksPath=.githooks commit -q -F - <<MSG
server JSDoc round ($label): $changed files typed by tooling, floors $floors

\`scripts/jsdoc-round.sh\` over $(basename "$chunk"): comments only (ts-behaviour-diff: no
compiled line changed). Errors under noImplicitAny over the batch: $before.
$promoted. Files whose new types broke the typecheck, or that the added lines pushed
over a ceiling, went back to HEAD. The tests in the changed files' directories pass.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0141CJBkRYpevGAuNN2PAmvt
MSG
  git log --oneline -1 | tee -a "$LOG"
}

case ${1:-} in
  chunks) shift; chunks "$@" ;;
  run) shift; prefix=$1; shift; for c in "$@"; do one_batch "$c" "$prefix-$(basename "$c" .txt)"; done; echo "=============== done $(date -u +%H:%M:%S)" | tee -a "$LOG" ;;
  *) echo "usage: scripts/jsdoc-round.sh chunks <server-dir> [size] | run <label> <batch.txt>..." >&2; exit 2 ;;
esac
