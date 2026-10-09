import { describe, expect, it } from "bun:test";
import { scanCommand } from "./index";

/** Execute-or-not cases: [command, blocked binary or null]. */
const cases: [string, string | null][] = [
	// --- blocked: direct calls ---
	["find . -name '*.ts'", "find"],
	["find /home/hakergeniusz -name '*.skill*' | head -50", "find"],
	["/usr/bin/find /tmp -type f", "find"],
	["grep -rn 'foo' src", "grep"],
	["rg -n 'x' src | grep -v test", "grep"],
	["cat file | grep foo", "grep"],
	["egrep -i 'a|b' file", "egrep"],
	["fgrep 'literal' file", "fgrep"],
	["python3 script.py", "python3"],
	["python3 - <<'PY'\nprint(1)\nPY", "python3"],
	["python -m pip install x", "python"],
	["pip install fasttext", "pip"],
	["pip3 --version", "pip3"],
	["uv run python -c 'print(1)'", null],

	// --- blocked through wrappers ---
	["sudo find / -name '*.ts'", "find"],
	["timeout 60 grep -r foo src", "grep"],
	["env PYTHONPATH=. python3 x.py", "python3"],
	["nohup python3 worker.py &", "python3"],
	["nice -n 10 find . -name x", "find"],
	["flock /tmp/lock python3 x.py", "python3"],
	["cat files.txt | xargs grep foo", "grep"],
	["xargs -I{} python3 {}", "python3"],
	["command grep foo file", "grep"],
	["bash -c 'find . -name x'", "find"],
	["bash -lc \"grep -r foo src\"", "grep"],
	["sh -c 'python3 -V'", "python3"],
	["busybox find . -name x", "find"],
	["eval \"grep -r foo .\"", "grep"],
	["echo hi && grep foo f", "grep"],
	["if true; then find . -name x; fi", "find"],

	// --- blocked inside substitutions ---
	["ls $(find . -name '*.ts')", "find"],
	["cat `grep -l foo *.txt`", "grep"],
	["for f in $(find . -name '*.ts'); do echo $f; done", "find"],

	// --- allowed: probes and searches that only mention the binary ---
	["which find", null],
	["command -v python3", null],
	["type grep", null],
	["whereis rg", null],
	["rg -n 'grep|find' src", null],
	["rg -n 'python3' README.md", null],
	["rg --files | rg -v node_modules", null],
	["fd -e ts src", null],
	["fd -H -e ts . | head", null],
	["trash -rf /tmp/ai-agent/x", null],
	["trash list", null],
	["uv pip install fasttext", null],
	["uv tool run ruff check .", null],
	["uv run python - <<'PY'\nprint(1)\nPY", null],
	["uv add fasttext", null],

	// --- allowed: the binary appears only as data ---
	["echo 'grep -r foo' > /tmp/cmd.txt", null],
	["cat > /tmp/script.sh <<'EOF'\ngrep foo file\nEOF\nbash /tmp/script.sh", null],
	["rg -c 'python' /tmp/agents.txt", null],
	["ls \"$(which grep)\"", null],
	["find . -name x | wc -l", "find"],
	["py -m pip install x", "py"],
	["findstr /s foo *.txt", "findstr"],
];

describe("tool-guard scanCommand", () => {
	for (const [command, expected] of cases) {
		const label = JSON.stringify(command.length > 60 ? command.slice(0, 57) + "..." : command);
		it(`${expected ? "blocks" : "allows"} ${label}`, () => {
			const hit = scanCommand(command);
			if (expected === null) {
				expect(hit).toBeNull();
			} else {
				expect(hit?.binary).toBe(expected);
			}
		});
	}

	it("keeps parsing bounded on deeply nested wrappers", () => {
		const deep = "sudo ".repeat(20) + "grep -r foo .";
		expect(scanCommand(deep)?.binary).toBe("grep");
	});

	it("does not crash on unterminated quotes or substitutions", () => {
		for (const bad of ["grep -r 'foo", "ls $(find .", "bash -c `grep", "echo 'unterminated"]) {
			expect(() => scanCommand(bad)).not.toThrow();
		}
	});
});
