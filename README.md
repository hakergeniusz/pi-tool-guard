# pi-tool-guard

Rewrites `find`, `grep` and bare `python`/`pip` into their sanctioned replacements inside pi's `bash` tool, instead of refusing the call.

`AGENTS.md` requires `fd`, `rg` and `uv`, but telling a model the rule does not work: nemotron-3-ultra promised to follow `AGENTS.md` and emitted `find ... -exec grep ...` in the same turn, then wrote a four-paragraph essay about *why* it had done so; qwen3.5-9b looped on `find | grep` until every attempt was refused and the turn died. A model knows the rule and still picks `find` because `find` is the statistically likelier token — its own words, in session.

So the guard no longer argues. It rewrites the command in place and lets it run. The model gets a correct result in one turn, and sees the `fd`/`rg` form in its own transcript, which is the only thing that actually moves the next token.

| Blocked binary | Rewritten to |
| --- | --- |
| `find` | `fd -HI -s -g GLOB [PATH]`, with `-tf`/`-td`, `-d N`, `--min-depth N`, `-p`, `-x`/`-X` |
| `grep`, `egrep`, `fgrep`, `rgrep` | `rg`, with `-u` added when the original was recursive |
| `python`, `python3`, `pypy3` | `uv run python`, and `uv pip` for `-m pip` |
| `pip`, `pip3` | `uv pip` |

## What is rewritten

Detection is quote-aware and covers the ways a binary appears in real commands:

- direct: `find . -name '*.ts'`, `grep -rn 'foo' src`, `python3 -m pip install x`
- pipelines and lists: `cat f | grep foo`, `echo hi && grep foo f`, `if true; then find . -name x; fi`
- wrappers: `sudo find`, `timeout 60 grep -r`, `env F=1 python3`, `nohup python3 w.py &`, `xargs grep -l`
- shell indirection: `bash -c 'find . -name x'`, `bash -lc "grep -r foo src"`, `sh -c 'python3 -V'`
- substitution and backticks: `ls $(find . -name '*.ts')`, `cat \`grep -l foo *.txt\``
- paths and `.exe`: `/usr/bin/find`, `find.exe`

The rest of the command is preserved byte for byte: redirects, pipes, `&&`, quoting, and whitespace around separators all stay where the model put them.

## What is deliberately left alone

- pi's built-in `grep` and `find` tools. They already spawn `rg` and `fd`.
- Searches that only *mention* a binary: `rg -n 'grep|find' src`, `rg -c 'python' README.md`.
- Probes that never execute it: `which find`, `command -v grep`, `type python3`.
- Heredoc bodies, so `cat > s.sh <<'EOF'` does not read its own content as commands.

## What is still blocked

Rewriting must never change meaning, so a construct with no faithful translation is refused with the equivalent flags spelled out:

| Blocked | Why |
| --- | --- |
| `find -mtime`, `-size`, `-newer`, `-o`, `-user`, `-perm` | fd has no equivalent expression language |
| `grep -P`, `grep -f file` | rg's PCRE2 build and pattern files differ per machine |
| `pip download`, `pip wheel` | no `uv pip` equivalent |
| `--break-system-packages`, anywhere | banned outright by `AGENTS.md`, never laundered into a uv command |
| `powershell` tool using those binaries | no `fd`/`rg` on this Windows path by default |

## Install and use

Wired into `~/.pi/agent/settings.json`. To load for a single run:

```bash
pi --extension ~/projects/pi-tool-guard/index.ts
```

Disable for one run (human escape hatch, the model cannot reach it):

```bash
PI_TOOL_GUARD=off pi
```

`/tool-guard` reports how many calls were rewritten and blocked.

## Tests

```bash
cd ~/projects/pi-tool-guard && bun test          # 72 cases: rewrites, blocks, leaves alone
bash /tmp/ai-agent/guard-check/verify.sh          # 10 shell equivalence checks: fd/rg vs find/grep output
```

## Known limits

- Rewriting is lexical, not a shell emulator. `PATH=/tmp:$PATH /tmp/find` and similar tricks bypass it.
- A script written with `write` and then run with `bash script.sh` is not inspected line by line; only the `bash` call itself is checked.
- `fd -x` runs one command per result in parallel, where `find -exec … \;` runs them sequentially. Output content is the same, ordering is not guaranteed.
- `fd` and `rg` respect `.gitignore` by default, so `-HI` and `-u` are emitted to match `find`/`grep -r` semantics. Results therefore include ignored files, exactly as the original would have.
- MCP tools, extension tools that spawn their own shells, and `!`-prefixed user commands are outside `tool_call` and therefore outside this guard.

## License

[MIT](LICENSE)
