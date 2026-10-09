# pi-tool-guard

Hard-blocks `find`, `grep` and bare `python`/`pip` inside pi's shell tools, because `AGENTS.md` requires `fd`, `rg` and `uv` and the instruction was being ignored in roughly half of all agent shell calls.

An instruction is a suggestion the model can talk itself out of. This extension makes the choice structural: the call never reaches a shell.

| Blocked binary | Replacement |
| --- | --- |
| `find` | `fd PATTERN [PATH]`, e.g. `fd -e ts src` |
| `grep`, `egrep`, `fgrep`, `rgrep`, PowerShell `findstr` | `rg PATTERN [PATH]`, e.g. `rg -n 'foo' src` |
| `python`, `python2`, `python3`, `pypy3`, PowerShell `py` | `uv run python SCRIPT`, `uv run --with pkg python -` |
| `pip`, `pip2`, `pip3`, `pipx` | `uv add PKG`, `uv pip install PKG`, `uv tool run PKG` |

## What is checked

Every command passed to the `bash` and `powershell` tools is parsed quote-aware and refused when the *executed* command word is blocked. Detection covers the ways a binary sneaks past a naive check:

- pipelines and lists: `echo hi && grep foo f`, `cat f | grep foo`, `if true; then find .; fi`
- argument position, not just position 0 in wrappers: `sudo find`, `timeout 60 grep -r`, `env F=1 python3 x.py`, `nohup python3 w.py &`, `nice -n 10 find .`, `flock /tmp/l python3 x.py`, `xargs grep foo`, `eval "grep -r foo ."`
- shell indirection: `bash -c 'find . -name x'`, `bash -lc "grep -r foo src"`, `busybox find .`
- command substitution and backticks: `ls $(find . -name '*.ts')`, `cat `grep -l foo *.txt``
- paths and Windows spellings: `/usr/bin/find`, `find.exe`

## What is deliberately not blocked

- pi's built-in `grep` and `find` tools. They already spawn `rg` and `fd`.
- Searches that only *mention* a binary: `rg -n 'grep|find' src`, `rg -c 'python' README.md`.
- Probes that never execute it: `which find`, `command -v grep`, `type grep`.
- File contents. `cat > script.sh <<'EOF'` with `grep` inside writes text; running that script through the bash tool is still checked, and blocked at that point.
- Heredoc bodies, so `cat > s.sh <<'EOF'` does not read its own content as commands.

The guard errs toward blocking wrapper operands, so an exotic pattern such as `xargs echo "grep foo"` is refused rather than analysed. Rewrite it as `xargs echo` with a different word.

## Install and use

Already wired into this machine's `~/.pi/agent/settings.json`. To load it for a single run:

```bash
pi --extension ~/projects/pi-tool-guard/index.ts
```

Disable for one run (human escape hatch, the model cannot reach it):

```bash
PI_TOOL_GUARD=off pi
```

`/tool-guard` reports whether the guard is active and how many shell calls it refused.

## Tests

```bash
cd ~/projects/pi-tool-guard && bun test
```

## Known limits

- A script written with `write` and then executed with `bash script.sh` is not inspected line by line; the call itself is still checked, and the script's own `grep` lines run. Blocking that would require tracing the whole file.
- MCP tools, extension tools that spawn their own shells, and `!`-prefixed user commands are outside `tool_call` and therefore outside this guard.
- Detection is lexical, not a shell emulator. `PATH=/tmp:$PATH /tmp/find` and similar tricks bypass it.

## License

[MIT](LICENSE)
