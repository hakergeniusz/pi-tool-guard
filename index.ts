/**
 * tool-guard — translate forbidden CLIs into their sanctioned replacements.
 *
 * AGENTS.md requires `fd`, `rg` and `uv`, but models ignore that rule anyway:
 * a model that "knows" the rule still emits `find` because it is the
 * statistically likelier token (its own words, in session). Blocking the call
 * only buys an argument: nemotron wrote an essay about it, qwen3.5-9b looped on
 * `find | grep` until every attempt was refused and the turn died.
 *
 * So the guard no longer lectures. It rewrites the command in place and lets it
 * run, so the model gets a correct result in one turn and sees the `fd`/`rg`
 * form in its own transcript:
 *
 *   find /tmp -name '*.py' -type f   ->  fd -HI -s -g '*.py' -tf /tmp
 *   grep -rn 'foo' src               ->  rg -n -u 'foo' src
 *   python3 script.py                ->  uv run python script.py
 *   pip install fasttext             ->  uv pip install fasttext
 *
 * `event.input` is mutated before execution, which pi documents as the
 * supported way to patch tool arguments. Rewriting is lexical and conservative:
 * anything that cannot be translated faithfully is still blocked, with the
 * equivalent flags spelled out, so an unsupported construct never silently
 * changes meaning.
 */

import type {
	BashToolCallEvent,
	ExtensionAPI,
	PowerShellToolCallEvent,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

type Outcome = { ok: true; command: string; rewrites: Rewrite[] } | { ok: false; reason: string };

type Rewrite = { binary: string; to: string };

/** Guards against self-referential parsing blow-ups. */
const MAX_DEPTH = 6;

/** Binaries that may not be executed as written. */
const RULES: Record<string, string> = {
	find: "fd",
	grep: "rg",
	egrep: "rg",
	fgrep: "rg",
	rgrep: "rg",
	python: "uv run python",
	python3: "uv run python",
	pip: "uv pip",
	pip3: "uv pip",
	python2: "uv run python",
	pypy3: "uv run python",
	findstr: "rg",
	py: "uv run python",
};

/** Commands that run another command; their operands are checked too. */
const WRAPPERS = new Set([
	"sudo", "doas", "env", "nice", "nohup", "timeout", "stdbuf", "setsid", "ionice",
	"chronic", "exec", "eval", "xargs", "flock", "watch", "time", "su", "runuser",
	"script", "unbuffer", "chrt", "taskset", "pkexec",
]);

/** Shells: `sh -c '...'` executes its operand, so rewrite inside it. */
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "fish", "busybox"]);

/** Commands that only *describe* a binary and never run it. */
const PROBES = new Set(["which", "whereis", "type", "hash", "apropos", "whatis", "man"]);

/** Sequencing keywords dropped so the real command word surfaces. */
const KEYWORDS = new Set([
	"then", "else", "elif", "do", "done", "fi", "esac", "in", "time",
	"if", "while", "until", "for", "case", "select",
]);

/** Wrapper options that swallow the following token as their value. */
const WRAPPER_VALUE_OPTS: Record<string, Set<string>> = {
	sudo: new Set(["-u", "-g", "-h", "-p", "-r", "-t", "-U", "-C", "--user", "--group", "--host", "--prompt", "--role", "--type", "--close-from", "--other-user"]),
	doas: new Set(["-u", "-C", "-L", "-n", "-s"]),
	env: new Set(["-u", "-C", "-S", "-U"]),
	timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
	nice: new Set(["-n", "--adjustment"]),
	ionice: new Set(["-c", "-n", "-p"]),
	stdbuf: new Set(["-i", "-o", "-e"]),
	setsid: new Set(["-w"]),
	watch: new Set(["-n", "-d", "-t", "-g", "-e"]),
	script: new Set(["-c", "-t", "-T", "-B", "-q"]),
	chrt: new Set([]),
	taskset: new Set(["-c"]),
	su: new Set(["-s", "-g", "-G", "-u", "-p"]),
	runuser: new Set(["-u", "-g", "-G"]),
	xargs: new Set(["-a", "-d", "-E", "-e", "-I", "-L", "-n", "-P", "-s", "-t", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-chars", "--eof", "--process-slot-var"]),
};

/** Positional operand some wrappers take before the real command. */
const WRAPPER_POSITIONAL: Record<string, (token: string) => boolean> = {
	timeout: (t) => /^[0-9]+(\.[0-9]+)?(ns|us|ms|s|m|h|d)?$/.test(t),
	flock: (t) => t.startsWith("/") || t.startsWith("./") || /^[0-9]+$/.test(t),
	su: (t) => /^[a-z_][a-z0-9_-]*$/i.test(t),
	runuser: (t) => /^[a-z_][a-z0-9_-]*$/i.test(t),
	script: (t) => t.startsWith("/") || t.startsWith("./"),
	watch: (t) => /^[0-9]+$/.test(t),
};

/* ------------------------------------------------------------------ *
 * Shell text parsing. Everything is quote-aware, so a pattern string
 * like rg -n 'grep|find' is never mistaken for a command.
 * ------------------------------------------------------------------ */

type Tok = { raw: string; quoted: boolean };

/** Split a string into tokens, keeping quotes attached and flagging them. */
function tokenize(input: string): Tok[] {
	const toks: Tok[] = [];
	let i = 0;
	while (i < input.length) {
		while (i < input.length && /\s/.test(input[i])) i++;
		if (i >= input.length) break;
		let raw = "";
		let quoted = false;
		let quote: string | null = null;
		while (i < input.length) {
			const c = input[i];
			if (quote) {
				raw += c;
				if (c === quote) quote = null;
				i++;
				continue;
			}
			if (c === "'" || c === '"') {
				quote = c;
				quoted = true;
				raw += c;
				i++;
				continue;
			}
			if (c === "\\" && i + 1 < input.length) {
				raw += input[i] + input[i + 1];
				i += 2;
				continue;
			}
			if (/\s/.test(c)) break;
			raw += c;
			i++;
		}
		toks.push({ raw, quoted });
	}
	return toks;
}

/** Split on `;`, `|`, `&&`, `||`, newline — never inside quotes. */
function splitSegments(command: string): string[] {
	const segs: string[] = [];
	let cur = "";
	let quote: string | null = null;
	let i = 0;
	while (i < command.length) {
		const c = command[i];
		if (quote) {
			cur += c;
			if (c === quote) quote = null;
			i++;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			cur += c;
			i++;
			continue;
		}
		if (c === "\\" && i + 1 < command.length) {
			cur += command.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (command.startsWith("&&", i) || command.startsWith("||", i)) {
			segs.push(cur);
			cur = "";
			i += 2;
			continue;
		}
		if (c === ";" || c === "|" || c === "\n") {
			segs.push(cur);
			cur = "";
			i++;
			continue;
		}
		cur += c;
		i++;
	}
	segs.push(cur);
	return segs.filter((s) => s.trim().length > 0);
}

/** Strip one layer of matching quotes. */
function unquote(token: string): string {
	const t = token.trim();
	if (t.length >= 2) {
		const q = t[0];
		if ((q === "'" || q === '"') && t.endsWith(q)) return t.slice(1, -1);
	}
	return t;
}

/** `./usr/bin/find`, `/usr/bin/find` and `find.exe` all mean `find`. */
function baseName(token: string): string {
	return unquote(token).replace(/^.*\//, "").replace(/\.exe$/i, "");
}

/** Shell redirection tokens, which must survive a rewrite untouched. */
function isRedirect(token: string): boolean {
	return /^(?:\d*[<>]{1,2}&?\d*|\d*>&\d*|&>>?[^ ]*)$/.test(token) || token === "&>" || token.startsWith("&>");
}

/**
 * Byte ranges of heredoc bodies. Their contents are data being written to a
 * file, not commands, so no rewrite may touch them.
 */
function heredocRanges(command: string): [number, number][] {
	const ranges: [number, number][] = [];
	const lines = command.split("\n");
	let offset = 0;
	let delimiter: string | null = null;
	for (const line of lines) {
		const start = offset;
		offset += line.length + 1;
		if (delimiter !== null) {
			if (line.trim() === delimiter) delimiter = null;
			else ranges.push([start, start + line.length]);
			continue;
		}
		const opening = line.match(/<<[-]?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*$/);
		if (opening) delimiter = opening[2];
	}
	return ranges;
}

function insideRanges(start: number, end: number, ranges: [number, number][]): boolean {
	return ranges.some(([from, to]) => start >= from && end <= to);
}

/** Spans of `$(...)`, backticks, `<(...)` and `>(...)` substitutions. */
function substitutionSpans(text: string): [number, number][] {
	const spans: [number, number][] = [];
	let i = 0;
	while (i < text.length) {
		if (text.startsWith("$(", i) || text.startsWith("<(", i) || text.startsWith(">(", i)) {
			const start = i + 2;
			let depth = 1;
			let j = start;
			while (j < text.length && depth > 0) {
				if (text[j] === "(") depth++;
				else if (text[j] === ")") depth--;
				if (depth === 0) break;
				j++;
			}
			spans.push([start, j]);
			i = j + 1;
			continue;
		}
		if (text[i] === "`") {
			const end = text.indexOf("`", i + 1);
			if (end === -1) break;
			spans.push([i + 1, end]);
			i = end + 1;
			continue;
		}
		i++;
	}
	return spans;
}

/** Consume env assignments, leading punctuation and sequencing keywords. */
function stripKeepers(segment: string): number {
	let len = 0;
	let rest = segment;
	for (;;) {
		// Only a leading run of shell punctuation is skipped, and only when the
		// segment actually starts with it: `(find .)`, `! grep foo`, `{ ls; }`.
		const junk = rest.match(/^\s*[!({`]+\s*/);
		if (junk) {
			rest = rest.slice(junk[0].length);
			len += junk[0].length;
			continue;
		}
		const env = rest.match(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+)+/);
		if (env) {
			rest = rest.slice(env[0].length);
			len += env[0].length;
			continue;
		}
		const word = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*/);
		if (word && KEYWORDS.has(word[1])) {
			rest = rest.slice(word[0].length);
			len += word[0].length;
			continue;
		}
		return len;
	}
}

/** Re-wrap a rewritten operand in the quotes it arrived in. */
function requote(originalRaw: string, inner: string): string {
	const q = originalRaw.trim()[0];
	if (q !== "'" && q !== '"') return inner;
	if (q === "'") return `'${inner.replace(/'/g, "'\\''")}'`;
	return `"${inner.replace(/([\\"$`])/g, "\\$1")}"`;
}

/* ------------------------------------------------------------------ *
 * find -> fd
 *
 * fd is case-insensitive by default (smart case) and skips hidden and
 * ignored files, so `-HI -s` is emitted for `-name` to keep results
 * identical to find. Unsupported predicates are refused rather than
 * guessed at.
 * ------------------------------------------------------------------ */

const FIND_TYPES: Record<string, string> = {
	f: "f", file: "f",
	d: "d", dir: "d", directory: "d",
	l: "l", symlink: "l",
	s: "s", socket: "s",
	p: "p", pipe: "p",
	b: "b", "block-device": "b",
	c: "c", "char-device": "c",
	x: "x", executable: "x",
	e: "e", empty: "e",
};

function rewriteFind(toks: Tok[], depth: number): Outcome {
	const flags: string[] = ["-HI"];
	const paths: string[] = [];
	const tail: string[] = [];
	let glob: string | null = null;
	let caseFlag = "-s";
	let fullPath = false;
	let exec: { args: string[]; batch: boolean } | null = null;

	let i = 0;
	while (i < toks.length) {
		const raw = toks[i].raw;
		if (isRedirect(raw)) {
			tail.push(raw);
			i++;
			continue;
		}
		const value = () => {
			const inline = raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : null;
			if (inline !== null) return inline;
			const next = toks[i + 1];
			return next ? next.raw : null;
		};
		const consumedNext = () => {
			if (raw.includes("=")) return 1;
			return 2;
		};

		if (raw === "-name" || raw === "--name" || raw.startsWith("-name=")) {
			glob = value();
			i += consumedNext();
			continue;
		}
		if (raw === "-iname" || raw === "--iname" || raw.startsWith("-iname=")) {
			glob = value();
			caseFlag = "-i";
			i += consumedNext();
			continue;
		}
		if (raw === "-path" || raw === "--path" || raw.startsWith("-path=")) {
			glob = value();
			fullPath = true;
			i += consumedNext();
			continue;
		}
		if (raw === "-ipath" || raw.startsWith("-ipath=")) {
			glob = value();
			fullPath = true;
			caseFlag = "-i";
			i += consumedNext();
			continue;
		}
		if (glob === null && (raw === "-name" || raw === "-iname")) continue;

		if (raw === "-type" || raw.startsWith("-type=")) {
			const t = unquote(value() ?? "");
			const mapped = FIND_TYPES[t];
			if (!mapped) return block(findUnsupported(raw, "-type accepts only f/d/l/s/p/b/c/x/e in fd (-t)"));
			flags.push(`-t${mapped}`);
			i += consumedNext();
			continue;
		}
		if (raw === "-maxdepth" || raw.startsWith("-maxdepth=")) {
			const n = value();
			if (!n || !/^[0-9]+$/.test(n)) return block(findUnsupported(raw, "expected -maxdepth N"));
			flags.push("-d", n);
			i += consumedNext();
			continue;
		}
		if (raw === "-mindepth" || raw.startsWith("-mindepth=")) {
			const n = value();
			if (!n || !/^[0-9]+$/.test(n)) return block(findUnsupported(raw, "expected -mindepth N"));
			flags.push("--min-depth", n);
			i += consumedNext();
			continue;
		}
		if (raw === "-L") {
			flags.push("-L");
			i++;
			continue;
		}
		if (raw === "-H" || raw === "-P" || raw === "-D") {
			i += consumedNext();
			continue;
		}
		if (raw === "-print") {
			i++;
			continue;
		}
		if (raw === "-print0") {
			flags.push("-0");
			i++;
			continue;
		}
		if (raw === "-exec") {
			const args: string[] = [];
			let batch = false;
			let j = i + 1;
			let terminated = false;
			for (; j < toks.length; j++) {
				const t = toks[j].raw;
				if (t === ";" || t === "+" || unquote(t) === ";" || t === "\\;") {
					batch = unquote(t) === "+";
					terminated = true;
					j++;
					break;
				}
				args.push(t);
			}
			if (!terminated || args.length === 0) {
				return block(findUnsupported("-exec", "-exec needs a command and a ';' or '+' terminator"));
			}
			const inner = transform(args.join(" "), depth + 1);
			if (!inner.ok) return inner;
			exec = { args: inner.command.split(/\s+/).filter(Boolean), batch };
			i = j;
			continue;
		}
		if (raw.startsWith("-")) {
			return block(findUnsupported(raw, "no fd equivalent"));
		}
		paths.push(raw);
		i++;
	}

	const args = [...flags];
	if (glob !== null) {
		// fd takes [PATTERN] [PATH...], so the glob always precedes the paths.
		if (caseFlag) args.push(caseFlag);
		if (fullPath) args.push("-p");
		args.push("-g", glob);
	} else {
		// No -name predicate: find lists everything, so fd needs a match-all
		// pattern before the paths, or it would treat the path as the pattern.
		args.push(".");
	}
	args.push(...paths, ...tail);
	if (exec) {
		args.push(exec.batch ? "-X" : "-x", ...exec.args);
	}
	return { ok: true, command: `fd ${args.join(" ")}`, rewrites: [{ binary: "find", to: "fd" }] };
}

function findUnsupported(flag: string, detail: string): string {
	return (
		`tool-guard: \`find ${flag}\` has no faithful fd equivalent (${detail}). ` +
		`Rewrite with fd: fd -HI [-s|-i] [-tf|-td|-tl] [-d N] [--min-depth N] [-p] [-g GLOB] [--exclude GLOB] [PATH] ` +
		`[-x CMD | -X CMD]. fd matches the whole basename with -g, unlike find's -name substring globs.`
	);
}

/* ------------------------------------------------------------------ *
 * grep -> rg
 *
 * rg is recursive by default and ignores .gitignore and hidden files,
 * so a recursive grep gets -u (unrestricted) to match its behaviour.
 * -L in ripgrep means --follow, not files-without-match, so grep's -L
 * maps to the long --files-without-match.
 * ------------------------------------------------------------------ */

const GREP_LONG_WITH_VALUE = new Set(["--max-count", "--after-context", "--before-context", "--context", "--regexp", "--include", "--exclude", "--exclude-dir", "--include-dir", "--file", "--colour", "--color", "--label", "--binary-files"]);

const GREP_SHORT_WITH_VALUE = new Set(["m", "A", "B", "C", "e", "f"]);

const GREP_FLAGS: Record<string, string> = {
	F: "-F", i: "-i", n: "-n", l: "-l", c: "-c", o: "-o", v: "-v",
	w: "-w", x: "-x", q: "-q", a: "-a", E: "", r: "", s: "", H: "--with-filename",
};

function quoteGlob(value: string): string {
	// A generated glob such as !node_modules/ must survive both history expansion
	// and glob expansion in the receiving shell, so it is always re-quoted.
	if (value.startsWith("'") || value.startsWith('"')) return value;
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function rewriteGrep(toks: Tok[]): Outcome {
	const out: string[] = [];
	const globs: string[] = [];
	const paths: string[] = [];
	const tail: string[] = [];
	let pattern: string | null = null;
	let patternIsRegexp = false;
	let recursive = false;
	let follow = false;
	let noFilename = false;

	let i = 0;
	while (i < toks.length) {
		const raw = toks[i].raw;
		if (isRedirect(raw)) {
			tail.push(raw);
			i++;
			continue;
		}

		if (!raw.startsWith("-") || raw === "-") {
			if (pattern === null && !patternIsRegexp) pattern = raw;
			else paths.push(raw);
			i++;
			continue;
		}

		// long flags
		if (raw.startsWith("--")) {
			const eq = raw.indexOf("=");
			const name = eq === -1 ? raw : raw.slice(0, eq);
			const inline = eq === -1 ? null : raw.slice(eq + 1);
			const takeValue = (): string | null => {
				if (inline !== null) return inline;
				const next = toks[i + 1];
				return next ? next.raw : null;
			};
			const step = () => (inline !== null ? 1 : 2);

			switch (name) {
				case "--recursive": recursive = true; break;
				case "--dereference-recursive": recursive = true; follow = true; break;
				case "--extended-regexp": case "--basic-regexp": case "--text": break;
				case "--fixed-strings": out.push("-F"); break;
				case "--ignore-case": out.push("-i"); break;
				case "--line-number": out.push("-n"); break;
				case "--files-with-matches": out.push("-l"); break;
				case "--files-without-match": out.push("--files-without-match"); break;
				case "--count": out.push("-c"); break;
				case "--only-matching": out.push("-o"); break;
				case "--invert-match": out.push("-v"); break;
				case "--word-regexp": out.push("-w"); break;
				case "--line-regexp": out.push("-x"); break;
				case "--no-filename": noFilename = true; break;
				case "--with-filename": case "--quiet": break;
				case "--follow": follow = true; break;
				case "--max-count":
				case "--after-context":
				case "--before-context":
				case "--context": {
					const v = takeValue();
					if (v === null || !/^[0-9]+$/.test(v)) return block(grepUnsupported(name, "expected a number"));
					const flag = name === "--max-count" ? "-m" : name === "--after-context" ? "-A" : name === "--before-context" ? "-B" : "-C";
					out.push(flag, v);
					break;
				}
				case "--regexp": {
					const v = takeValue();
					if (v === null) return block(grepUnsupported("--regexp", "expected a pattern"));
					pattern = v;
					patternIsRegexp = true;
					break;
				}
				case "--include": case "--exclude": case "--exclude-dir": case "--include-dir": {
					const v = takeValue();
					if (v === null) return block(grepUnsupported(name, "expected a glob"));
					const raw = name === "--include" ? v : name === "--include-dir" ? `${v}/` : name === "--exclude-dir" ? `!${v}/` : `!${v}`;
					globs.push(quoteGlob(raw));
					break;
				}
				case "--color": case "--colour": case "--binary-files": case "--label": break;
				default: return block(grepUnsupported(name, "no rg equivalent"));
			}
			i += GREP_LONG_WITH_VALUE.has(name) ? step() : 1;
			continue;
		}

		// short flag clusters, e.g. -rni or -oiE or -m5
		const chars = raw.slice(1);
		let j = 0;
		while (j < chars.length) {
			const c = chars[j];
			if (GREP_SHORT_WITH_VALUE.has(c)) {
				const attached = chars.slice(j + 1);
				const v = attached.length > 0 ? attached : (toks[i + 1] ? toks[i + 1].raw : null);
				if (v === null) return block(grepUnsupported(`-${c}`, "expected a value"));
				if (c === "m") {
					if (!/^[0-9]+$/.test(v)) return block(grepUnsupported("-m", "expected a number"));
					out.push("-m", v);
				} else if (c === "A" || c === "B" || c === "C") {
					if (!/^[0-9]+$/.test(v)) return block(grepUnsupported(`-${c}`, "expected a number"));
					out.push(`-${c}`, v);
				} else if (c === "e") {
					pattern = v;
					patternIsRegexp = true;
					out.push("-e", v);
				} else {
					return block(grepUnsupported(`-${c}`, "no rg equivalent"));
				}
				if (attached.length === 0) i++;
				j = chars.length;
				break;
			}
			if (c === "r") { recursive = true; j++; continue; }
			if (c === "R") { recursive = true; follow = true; j++; continue; }
			if (c === "h") { noFilename = true; j++; continue; }
			if (c === "L") { out.push("--files-without-match"); j++; continue; }
			if (c in GREP_FLAGS) {
				if (GREP_FLAGS[c]) out.push(GREP_FLAGS[c]);
				j++;
				continue;
			}
			return block(grepUnsupported(`-${c}`, "no rg equivalent"));
		}
		i++;
	}

	if (pattern === null) return block("tool-guard: `grep` was called with no pattern, and rg requires one.");

	const args = [...out];
	if (recursive) args.push("-u");
	if (follow) args.push("-L");
	if (noFilename) args.push("-I");
	for (const g of globs) args.push("-g", g);
	if (!patternIsRegexp) args.push(pattern);
	args.push(...paths, ...tail);
	return { ok: true, command: `rg ${args.join(" ")}`, rewrites: [{ binary: "grep", to: "rg" }] };
}

function grepUnsupported(flag: string, detail: string): string {
	return (
		`tool-guard: \`grep ${flag}\` has no faithful rg equivalent (${detail}). ` +
		`Rewrite with rg: rg [-n] [-i] [-l] [-c] [-o] [-v] [-w] [-F] [-m N] [-A/B/C N] [-e PAT] [-g GLOB] [-u] [PAT] [PATH].`
	);
}

/* ------------------------------------------------------------------ *
 * python / pip -> uv
 * ------------------------------------------------------------------ */

function rewritePython(binary: string, toks: Tok[]): Outcome {
	const rest = toks.map((t) => t.raw);
	if (rest[0] === "-m" || rest[0]?.startsWith("-m")) {
		const inline = rest[0].length > 2 ? rest[0].slice(2) : rest[1];
		const after = rest[0].length > 2 ? rest.slice(1) : rest.slice(2);
		if (inline === "pip") {
			if (after.some((t) => t === "--break-system-packages")) return block(pipBreakSystem());
			return { ok: true, command: `uv pip ${after.join(" ")}`, rewrites: [{ binary, to: "uv pip" }] };
		}
		if (inline === "venv") return block(pythonUnsupported("-m venv", "create the environment with `uv venv` instead"));
		if (inline === "ensurepip") return block(pythonUnsupported("-m ensurepip", "uv-managed projects do not need ensurepip"));
		return { ok: true, command: `uv run python -m ${inline} ${after.join(" ")}`.trimEnd(), rewrites: [{ binary, to: "uv run python" }] };
	}
	return { ok: true, command: `uv run python ${rest.join(" ")}`.trimEnd(), rewrites: [{ binary, to: "uv run python" }] };
}

const PIP_SUBCOMMANDS = new Set(["install", "uninstall", "list", "freeze", "show", "check"]);

function rewritePip(binary: string, toks: Tok[]): Outcome {
	const rest = toks.map((t) => t.raw);
	if (rest.some((t) => t === "--break-system-packages")) return block(pipBreakSystem());
	const sub = rest[0];
	if (sub && PIP_SUBCOMMANDS.has(sub)) {
		if (sub === "check") return block(pipUnsupported(sub, "`uv pip check` is not implemented; run `uv run python -m pip check` if needed"));
		return { ok: true, command: `uv pip ${rest.join(" ")}`, rewrites: [{ binary, to: "uv pip" }] };
	}
	if (sub === "venv") return block(pipUnsupported(sub, "use `uv venv`"));
	return block(pipUnsupported(sub ?? "", "supported: install, uninstall, list, freeze, show"));
}

function pipBreakSystem(): string {
	return (
		"tool-guard: `--break-system-packages` is banned outright by AGENTS.md and will not be rewritten. " +
		"Use an isolated environment instead: `uv venv && uv pip install PKG`, or `uv add PKG` inside a project."
	);
}

function pythonUnsupported(flag: string, detail: string): string {
	return `tool-guard: \`python ${flag}\` cannot be rewritten to uv (${detail}).`;
}

function pipUnsupported(sub: string, detail: string): string {
	return (
		`tool-guard: \`pip ${sub}\` has no uv equivalent (${detail}). ` +
		`Use \`uv pip install PKG\`, \`uv pip uninstall PKG\`, \`uv pip list\`, \`uv pip freeze\`, \`uv pip show PKG\`, or \`uv add PKG\` in a project.`
	);
}

function block(reason: string): { ok: false; reason: string } {
	return { ok: false, reason };
}

/* ------------------------------------------------------------------ *
 * Segment rewriter
 * ------------------------------------------------------------------ */

/** Index of the `-c` operand for a shell invocation, if any. */
function dashCOperand(toks: Tok[]): number {
	for (let i = 0; i < toks.length; i++) {
		const raw = unquote(toks[i].raw);
		if (raw === "-c" || /^-[a-z]{0,3}c$/.test(raw)) return i + 1 < toks.length ? i + 1 : -1;
	}
	return -1;
}

function rewriteSegment(segment: string, depth: number): Outcome {
	const prefixLen = stripKeepers(segment);
	const rest = segment.slice(prefixLen);
	if (rest.trim().length === 0) return { ok: true, command: segment, rewrites: [] };

	const toks = tokenize(rest);
	const head = toks[0];
	const headBase = baseName(head.raw);
	const prefix = segment.slice(0, prefixLen);

	// Descriptions, not executions.
	if (PROBES.has(headBase)) return { ok: true, command: segment, rewrites: [] };
	if (headBase === "command") {
		const next = toks[1] ? unquote(toks[1].raw) : "";
		if (next === "-v" || next === "-V") return { ok: true, command: segment, rewrites: [] };
		const inner = rewriteSegment(`${head.raw} ${rest.slice(head.raw.length)}`.replace(head.raw, "").trim(), depth + 1);
		return inner.ok ? { ok: true, command: `${prefix}${inner.command}`, rewrites: inner.rewrites } : inner;
	}

	// A shell executes its -c operand verbatim, so rewrite inside it.
	if (SHELLS.has(headBase)) {
		const operandIdx = dashCOperand(toks);
		if (operandIdx >= 0) {
			const operand = toks[operandIdx];
			const inner = transform(unquote(operand.raw), depth + 1);
			if (!inner.ok) return inner;
			const before = toks.slice(0, operandIdx).map((t) => t.raw).join(" ");
			return {
				ok: true,
				command: `${prefix}${before} ${requote(operand.raw, inner.command)}`.trimEnd(),
				rewrites: inner.rewrites,
			};
		}
		return { ok: true, command: segment, rewrites: [] };
	}

	// A wrapper runs the command after it; keep the wrapper, rewrite past it.
	if (WRAPPERS.has(headBase)) {
		const valueOpts = WRAPPER_VALUE_OPTS[headBase] ?? new Set<string>();
		let idx = 1;
		for (; idx < toks.length; idx++) {
			const raw = toks[idx].raw;
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) continue; // env assignment
			if (raw.startsWith("-")) {
				const bare = raw.split("=")[0];
				if (raw.includes("=")) continue;
				if (valueOpts.has(bare) && idx + 1 < toks.length) idx++;
				continue;
			}
			const positional = WRAPPER_POSITIONAL[headBase];
			if (positional && positional(raw)) continue;
			break;
		}
		const remainder = toks.slice(idx);
		if (remainder.length === 0) return { ok: true, command: segment, rewrites: [] };
		const subBase = baseName(remainder[0].raw);
		if (RULES[subBase]) {
			const translated = translateBinary(subBase, remainder.slice(1), depth);
			if (!translated.ok) return translated;
			const kept = toks.slice(0, idx).map((t) => t.raw).join(" ");
			return {
				ok: true,
				command: `${prefix}${kept} ${translated.command}`.trimEnd(),
				rewrites: translated.rewrites,
			};
		}
		// Not the command head: recurse through nested shells, otherwise scan for
		// a banned word we cannot safely place, and refuse.
		const nested = rewriteSegment(remainder.map((t) => t.raw).join(" "), depth + 1);
		if (nested.ok && !(nested as { rewrites: Rewrite[] }).rewrites.length) {
			for (const t of remainder) {
				if (RULES[baseName(t.raw)]) return block(wrapperUnresolved(headBase, baseName(t.raw)));
				if (t.quoted && /\s/.test(unquote(t.raw))) {
					const inner = transform(unquote(t.raw), depth + 1);
					if (!inner.ok) return inner;
					return {
						ok: true,
						command: `${prefix}${toks.slice(0, idx + remainder.indexOf(t)).map((x) => x.raw).join(" ")} ${requote(t.raw, inner.command)}`,
						rewrites: inner.rewrites,
					};
				}
			}
		}
		return nested.ok
			? { ok: true, command: `${prefix}${toks.slice(0, idx).map((t) => t.raw).join(" ")} ${nested.command}`.trimEnd(), rewrites: nested.rewrites }
			: nested;
	}

	// The direct case: this segment starts with a banned binary.
	if (RULES[headBase]) {
		const translated = translateBinary(headBase, toks.slice(1), depth);
		if (!translated.ok) return translated;
		return { ok: true, command: `${prefix}${translated.command}`, rewrites: translated.rewrites };
	}

	return { ok: true, command: segment, rewrites: [] };
}

function wrapperUnresolved(wrapper: string, binary: string): string {
	return (
		`tool-guard: \`${wrapper} … ${binary}\` cannot be rewritten safely because ${wrapper}'s operands are ambiguous. ` +
		`Run the command directly with ${RULES[binary]} instead of hiding it behind ${wrapper}.`
	);
}

/* ------------------------------------------------------------------ *
 * Dispatch and whole-command rewrite
 * ------------------------------------------------------------------ */

function translateBinary(binary: string, toks: Tok[], depth: number): Outcome {
	if (binary === "find") return rewriteFind(toks, depth);
	if (binary === "grep" || binary === "egrep" || binary === "fgrep" || binary === "rgrep" || binary === "findstr") {
		if (binary === "fgrep") return rewriteGrep([{ raw: "-F", quoted: false }, ...toks]);
		return rewriteGrep(toks);
	}
	if (binary === "python" || binary === "python3" || binary === "python2" || binary === "pypy3") return rewritePython(binary, toks);
	if (binary === "pip" || binary === "pip3") return rewritePip(binary, toks);
	return block(`tool-guard: \`${binary}\` is blocked with no replacement.`);
}

/** Rewrite everything inside substitutions in a segment. */
function rewriteSubstitutions(text: string, depth: number): Outcome {
	const spans = substitutionSpans(text);
	if (spans.length === 0) return { ok: true, command: text, rewrites: [] };
	let result = "";
	let cursor = 0;
	const rewrites: Rewrite[] = [];
	for (const [from, to] of spans) {
		const inner = transform(text.slice(from, to), depth + 1);
		if (!inner.ok) return inner;
		result += text.slice(cursor, from) + inner.command;
		cursor = to;
		rewrites.push(...inner.rewrites);
	}
	result += text.slice(cursor);
	return { ok: true, command: result, rewrites };
}

/** Rewrite a whole command: segment by segment, skipping heredoc bodies. */
export function transform(command: string, depth = 0): Outcome {
	if (depth > MAX_DEPTH) return { ok: true, command, rewrites: [] };
	// Never laundered into a uv command: it breaks the system interpreter.
	if (/--break-system-packages/.test(command)) return block(pipBreakSystem());

	const inert = heredocRanges(command);

	// Locate each segment in the original text so the rest is preserved byte for byte.
	// Segment spans are trimmed to their own text, so separators and the whitespace
	// around them stay exactly where the model put them.
	const located: { from: number; to: number }[] = [];
	{
		let cursor = 0;
		for (const text of splitSegments(command)) {
			const raw = command.indexOf(text, cursor);
			if (raw === -1) continue;
			let from = raw;
			let to = raw + text.length;
			while (from < to && /\s/.test(command[from])) from++;
			while (to > from && /\s/.test(command[to - 1])) to--;
			located.push({ from, to });
			cursor = to;
		}
	}

	let result = "";
	let cursor = 0;
	const rewrites: Rewrite[] = [];
	for (const { from, to } of located) {
		result += command.slice(cursor, from);
		cursor = to;
		// Heredoc bodies are data, not commands: copy them through untouched.
		if (insideRanges(from, to, inert)) {
			result += command.slice(from, to);
			continue;
		}
		const withSubs = rewriteSubstitutions(command.slice(from, to), depth);
		if (!withSubs.ok) return withSubs;
		const rewritten = rewriteSegment(withSubs.command, depth);
		if (!rewritten.ok) return rewritten;
		result += rewritten.command;
		rewrites.push(...withSubs.rewrites, ...rewritten.rewrites);
	}
	result += command.slice(cursor);
	return { ok: true, command: result, rewrites };
}

/* ------------------------------------------------------------------ *
 * Extension wiring
 * ------------------------------------------------------------------ */

let rewrittenTotal = 0;
let blockedTotal = 0;
const rewritesByBinary = new Map<string, number>();

function enabled(): boolean {
	const v = (process.env.PI_TOOL_GUARD ?? "").toLowerCase();
	return v !== "off" && v !== "0" && v !== "false";
}

export default function toolGuard(pi: ExtensionAPI) {
	pi.on("tool_call", (event: ToolCallEvent) => {
		if (!enabled()) return;
		if (event.toolName === "bash") {
			const input = (event as BashToolCallEvent).input;
			if (typeof input.command !== "string" || input.command.trim() === "") return;
			const outcome = transform(input.command);
			if (!outcome.ok) {
				blockedTotal++;
				return { block: true, reason: outcome.reason } satisfies ToolCallEventResult;
			}
			if (outcome.command === input.command) return;
			rewrittenTotal++;
			for (const r of outcome.rewrites) {
				rewritesByBinary.set(r.binary, (rewritesByBinary.get(r.binary) ?? 0) + 1);
			}
			// pi skips re-validation after a tool_call mutation, so this is the
			// supported way to hand the model a corrected command.
			input.command = outcome.command;
			return;
		}
		// PowerShell has no fd/rg by default here, so rewriting would trade a
		// policy break for a guaranteed failure. Refuse with guidance instead.
		if (event.toolName === "powershell") {
			const input = (event as PowerShellToolCallEvent).input as { command?: string };
			if (typeof input.command !== "string") return;
			if (/\b(find|findstr|grep|python|pip)\b/.test(input.command)) {
				blockedTotal++;
				return {
					block: true,
					reason:
						"tool-guard: use the bash tool for file discovery and search on this machine, where `fd` and `rg` are installed.",
				} satisfies ToolCallEventResult;
			}
		}
		return;
	});

	pi.registerCommand("tool-guard", {
		description: "Show tool-guard status: rewritten and blocked shell calls",
		handler: (_args, ctx) => {
			const stats = [...rewritesByBinary.entries()].map(([binary, n]) => `${binary}->${n}`).join(", ");
			const text = enabled()
				? `tool-guard active — rewrote ${rewrittenTotal} shell call(s)${stats ? ` (${stats})` : ""}, blocked ${blockedTotal}.`
				: `tool-guard disabled by PI_TOOL_GUARD for this run.`;
			if (ctx.hasUI) ctx.ui.notify(text, "info");
			else console.log(text);
		},
	});
}
