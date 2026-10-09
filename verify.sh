#!/usr/bin/env bash
# Verify rewritten commands produce the same answers as their originals.
# Fixture lives in /tmp/ai-agent/guard-check. This harness lives in the project, so
# the fixture reset cannot delete it.
# Only fd/rg are used, so nothing here is itself rewritten.
set -u
FIX=/tmp/ai-agent/guard-check
mkdir -p "$FIX" && cd "$FIX" || exit 1
rm -rf "$FIX"/* 2>/dev/null
printf 'alpha\nHARD one\n' > scan_a.py
printf 'beta\n' > scan_b.py
printf 'gamma\n' > scan_c.py
mkdir -p subdir

pass=0; fail=0
check() {
  local desc="$1" expected="$2"; shift 2
  local got
  got="$("$@" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//;s/  */ /g')"
  if [ "$got" = "$expected" ]; then
    pass=$((pass+1)); echo "PASS  $desc"
  else
    fail=$((fail+1)); echo "FAIL  $desc"; echo "        cmd:      $*"; echo "        expected: [$expected]"; echo "        got:      [$got]"
  fi
}

# find -name 'scan*.py' -> fd -HI -tf -s -g 'scan*.py' .
check "fd -g replaces find -name" \
  "./scan_a.py ./scan_b.py ./scan_c.py" \
  fd -HI -tf -s -g 'scan*.py' .

# find -maxdepth 1 -> fd -d 1
check "fd -d replaces find -maxdepth" \
  "./scan_a.py ./scan_b.py ./scan_c.py" \
  fd -HI -d 1 -s -g '*.py' .

# find with no -name predicate: pattern must precede the path
check "fd . replaces find with no predicate" \
  "./subdir/" \
  fd -HI -td -d 1 . .

# grep -rn 'HARD' . -> rg -n -u 'HARD' .
check "rg -n -u replaces grep -rn" \
  "./scan_a.py:2:HARD one" \
  rg -n -u 'HARD' .

# grep -l 'HARD' * -> rg -l -u 'HARD' *
check "rg -l replaces grep -l" \
  "./scan_a.py" \
  rg -l -u 'HARD' .

# grep -n on one file prints no filename; rg matches that behaviour
check "rg -n on one file matches grep -n" \
  "2:HARD one" \
  rg -n 'HARD' scan_a.py

# grep -L (files without match) -> rg --files-without-match
check "rg --files-without-match replaces grep -L" \
  "scan_b.py scan_c.py" \
  rg --files-without-match 'HARD' -g '*.py'

# fgrep -> rg -F
check "rg -F replaces fgrep" \
  "HARD one" \
  rg -F 'HARD' scan_a.py

# egrep -> rg (ERE by default)
check "rg replaces egrep" \
  "2:HARD one" \
  rg -n 'H[A-Z]RD' scan_a.py

# find ... -exec wc -l {} + -> fd ... -X wc -l {} (batch, one invocation)
check "fd -X replaces find -exec +" \
  "1 ./scan_b.py 1 ./scan_c.py 2 ./scan_a.py 4 total" \
  bash -c "fd -HI -tf -s -g '*.py' . -X wc -l {} | awk '{print \$1, \$2}' | sort | tr '\n' ' ' | sed 's/ *$//'"

# find ... -exec grep -l 'HARD' {} \; -> fd ... -x rg -l 'HARD' {} (per result)
check "fd -x replaces find -exec ;" \
  "./scan_a.py" \
  bash -c "fd -HI -tf -s -g '*.py' . -x rg -l 'HARD' | sort | tr '\n' ' ' | sed 's/ *$//'"

echo
echo "passed=$pass failed=$fail"
