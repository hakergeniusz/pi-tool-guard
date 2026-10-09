import { describe, expect, it } from "bun:test";
import { transform } from "./index";

/** [command, expected rewritten command, blocked reason substring or null]. */
const cases: [string, string | null, string | null][] = [
	// --- find -> fd ---
	[
		"find /tmp/ai-agent -type f -name 'scan*.py' -exec grep -l 'HARD' {} \\; 2>/dev/null",
		"fd -HI -tf -s -g 'scan*.py' /tmp/ai-agent 2>/dev/null -x rg -l 'HARD' {}",
		null,
	],
	["find . -name '*.ts'", "fd -HI -s -g '*.ts' .", null],
	[
		"find /home/hakergeniusz -maxdepth 6 -name \"*.sh\" -type f 2>/dev/null | wc -l",
		"fd -HI -d 6 -tf -s -g \"*.sh\" /home/hakergeniusz 2>/dev/null | wc -l",
		null,
	],
	["find . -iname 'README*'", "fd -HI -i -g 'README*' .", null],
	["find /src -path '*/features/*.ts'", "fd -HI -s -p -g '*/features/*.ts' /src", null],
	["find /data -mindepth 2 -maxdepth 4 -type d", "fd -HI --min-depth 2 -d 4 -td . /data", null],
	["find /tmp/ai-agent -maxdepth 1 -type d", "fd -HI -d 1 -td . /tmp/ai-agent", null],
	["find /data -type f", "fd -HI -tf . /data", null],
	["find . -maxdepth 2", "fd -HI -d 2 . .", null],
	["find /src -type f -name '*.ts' -exec wc -l {} +", "fd -HI -tf -s -g '*.ts' /src -X wc -l {}", null],
	["/usr/bin/find /tmp -name x", "fd -HI -s -g x /tmp", null],
	["sudo find / -name '*.ts'", "sudo fd -HI -s -g '*.ts' /", null],

	// --- grep -> rg ---
	["grep -rn 'foo' src", "rg -n -u 'foo' src", null],
	["grep -r 'foo' .", "rg -u 'foo' .", null],
	["grep -rl 'llama.cpp' .", "rg -l -u 'llama.cpp' .", null],
	["fd -e py -e scan /tmp/ai-agent | grep HARD", "fd -e py -e scan /tmp/ai-agent | rg HARD", null],
	["cat file | grep foo", "cat file | rg foo", null],
	["echo hi && grep foo f", "echo hi && rg foo f", null],
	["grep -oiE 'ch=[0-9]+|ch:[0-9]+' file.html", "rg -o -i 'ch=[0-9]+|ch:[0-9]+' file.html", null],
	["grep -c '' file", "rg -c '' file", null],
	["grep -L 'foo' *.txt", "rg --files-without-match 'foo' *.txt", null],
	["grep --include='*.py' -rn 'import' .", "rg -n -u -g '*.py' 'import' .", null],
	["grep --exclude-dir=node_modules -r 'x' .", "rg -u -g '!node_modules/' 'x' .", null],
	["grep -m 5 'x' f", "rg -m 5 'x' f", null],
	["fgrep 'literal' file", "rg -F 'literal' file", null],
	["egrep -i 'a|b' file", "rg -i 'a|b' file", null],
	["grep -A3 -B1 'err' log", "rg -A 3 -B 1 'err' log", null],

	// --- python / pip -> uv ---
	["python3 script.py", "uv run python script.py", null],
	["python3 - <<'PY'\nprint(1)\nPY", "uv run python - <<'PY'\nprint(1)\nPY", null],
	["python3 -c 'print(1)'", "uv run python -c 'print(1)'", null],
	["python3 --version", "uv run python --version", null],
	["python3 -m pip install fasttext", "uv pip install fasttext", null],
	["python3 -m pytest -q tests/", "uv run python -m pytest -q tests/", null],
	["pip install fasttext", "uv pip install fasttext", null],
	["pip3 install -r requirements.txt", "uv pip install -r requirements.txt", null],
	["pip list", "uv pip list", null],

	// --- indirection ---
	["bash -c 'grep -r foo .'", "bash -c 'rg -u foo .'", null],
	["bash -lc \"grep -r foo src\"", "bash -lc \"rg -u foo src\"", null],
	["sh -c 'python3 -V'", "sh -c 'uv run python -V'", null],
	["ls $(find . -name '*.ts')", "ls $(fd -HI -s -g '*.ts' .)", null],
	["cat `grep -l foo *.txt`", "cat `rg -l foo *.txt`", null],
	["for f in $(find . -name '*.ts'); do echo $f; done", "for f in $(fd -HI -s -g '*.ts' .); do echo $f; done", null],
	["xargs grep foo", "xargs rg foo", null],
	["cat files.txt | xargs grep -l foo", "cat files.txt | xargs rg -l foo", null],
	["env PYTHONPATH=. python3 x.py", "env PYTHONPATH=. uv run python x.py", null],
	["timeout 60 grep -r foo src", "timeout 60 rg -u foo src", null],
	["nohup python3 worker.py &", "nohup uv run python worker.py &", null],
	["eval \"grep -r foo .\"", "eval \"rg -u foo .\"", null],
	["if true; then find . -name x; fi", "if true; then fd -HI -s -g x .; fi", null],
	["command grep foo file", "rg foo file", null],

	// --- data, not execution ---
	["which find", null, null],
	["command -v grep", null, null],
	["type python3", null, null],
	["rg -n 'grep|find' src", null, null],
	["rg -n 'python3' README.md", null, null],
	["rg --files | rg -v node_modules", null, null],
	["fd -e ts src", null, null],
	["trash -rf /tmp/ai-agent/x", null, null],
	["uv run python -c 'print(1)'", null, null],
	["uv pip install fasttext", null, null],
	["uv add fasttext", null, null],
	["echo 'grep -r foo' > /tmp/cmd.txt", null, null],
	["cat > /tmp/script.sh <<'EOF'\ngrep foo file\nEOF\nbash /tmp/script.sh", null, null],
	["rg -c 'python' /tmp/agents.txt", null, null],
	["ls \"$(which grep)\"", null, null],

	// --- blocked: no faithful rewrite ---
	["find . -mtime -7 -name '*.log'", null, "-mtime"],
	["find . -size +1M", null, "-size"],
	["find . -name '*.ts' -o -name '*.tsx'", null, "-o"],
	["find . -newer /tmp/ref", null, "-newer"],
	["grep -P '\\d+' f", null, "-P"],
	["grep -f patterns.txt f", null, "-f"],
	["pip download x", null, "no uv equivalent"],
	["pip install --break-system-packages x", null, "--break-system-packages"],
];

describe("tool-guard transform", () => {
	for (const [command, expected, blocked] of cases) {
		const label = JSON.stringify(command.length > 58 ? command.slice(0, 55) + "..." : command);
		const verb = blocked ? "blocks" : expected ? "rewrites" : "leaves";
		it(`${verb} ${label}`, () => {
			const outcome = transform(command);
			if (blocked) {
				expect(outcome.ok).toBe(false);
				if (!outcome.ok) expect(outcome.reason).toContain(blocked);
				return;
			}
			expect(outcome.ok).toBe(true);
			if (outcome.ok) expect(outcome.command).toBe(expected ?? command);
		});
	}

	it("records which binary it rewrote", () => {
		const outcome = transform("find . -name '*.py' | grep foo");
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.rewrites).toEqual([
				{ binary: "find", to: "fd" },
				{ binary: "grep", to: "rg" },
			]);
		}
	});

	it("keeps parsing bounded and never throws", () => {
		const deep = "sudo ".repeat(20) + "grep -r foo .";
		const outcome = transform(deep);
		expect(outcome.ok).toBe(true);
		for (const bad of ["grep -r 'foo", "ls $(find .", "bash -c `grep", "echo 'unterminated", "find . -name", ""]) {
			expect(() => transform(bad)).not.toThrow();
		}
	});
});
