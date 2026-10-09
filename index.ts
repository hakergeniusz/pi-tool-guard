/**
 * tool-guard — make forbidden CLIs unreachable from pi's shell tools.
 *
 * AGENTS.md bans `find`, `grep` and bare `python`/`pip` (use `fd`, `rg`, and
 * `uv run`), yet 48% of agent shell calls in prior sessions ignored the rule.
 * An instruction in a system prompt is a suggestion the model can talk itself
 * out of; this extension makes the choice structural instead.
 *
 * Enforcement layer: pi's `bash` and `powershell` tools. Every command is
 * parsed quote-aware (segments, wrappers, `sh -c`, `$(...)`, backticks, xargs)
 * before execution, and a call whose *executed* command word is blocked is
 * refused outright. Block messages name the sanctioned replacement so the
 * model can rewrite the call in the same turn.
 *
 * Deliberately out of scope, because banning the binary there would break
 * unrelated work:
 * - pi's built-in `grep`/`find` tools — they spawn `rg`/`fd` already.
 * - Search *patterns* — `rg -n 'grep|find' file` is a search, not a call.
 * - File contents — writing a script that contains `grep` is fine; only
 *   executing it here is checked.
 * - Probes that never execute the binary (`which find`, `command -v grep`).
 *
 * Escape hatch: `PI_TOOL_GUARD=off pi` disables the guard for one run.
 */

import type {
	BashToolCallEvent,
	ExtensionAPI,
	PowerShellToolCallEvent,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

/** What to say when a binary is refused. */
type Rule = {
	/** Sanctioned replacement, shown to the model. */
	use: string;
	/** One-line reason naming the policy. */
	why: string;
};

/** Binaries that may not be executed, with their replacement. */
const RULES: Record<string, Rule> = {
	// fd not find
	find: { use: "fd PATTERN [PATH]   e.g. fd -e ts src", why: "AGENTS.md: fd not find" },
	// rg not grep
	grep: { use: "rg PATTERN [PATH]   e.g. rg -n 'foo' src", why: "AGENTS.md: rg not grep" },
	egrep: { use: "rg -e PATTERN", why: "AGENTS.md: rg not grep" },
	fgrep: { use: "rg -F PATTERN", why: "AGENTS.md: rg not grep" },
	rgrep: { use: "rg PATTERN", why: "AGENTS.md: rg not grep" },
	// uv, not a system interpreter
	python: { use: "uv run python SCRIPT", why: "AGENTS.md: Python through uv (uv run python / uv run --with pkg python)" },
	python2: { use: "uv run python SCRIPT", why: "AGENTS.md: Python through uv (uv run python / uv run --with pkg python)" },
	python3: { use: "uv run python SCRIPT", why: "AGENTS.md: Python through uv (uv run python / uv run --with pkg python)" },
	pypy3: { use: "uv run python SCRIPT", why: "AGENTS.md: Python through uv (uv run python / uv run --with pkg python)" },
	pip: { use: "uv add PKG   /   uv pip install PKG", why: "AGENTS.md: uv not pip" },
	pip2: { use: "uv add PKG   /   uv pip install PKG", why: "AGENTS.md: uv not pip" },
	pip3: { use: "uv add PKG   /   uv pip install PKG", why: "AGENTS.md: uv not pip" },
	pipx: { use: "uv tool run PKG", why: "AGENTS.md: uv not pip" },
	// PowerShell spellings
	findstr: { use: "rg PATTERN [PATH]", why: "AGENTS.md: rg not grep" },
	py: { use: "uv run python SCRIPT", why: "AGENTS.md: Python through uv (uv run python / uv run --with pkg python)" },
};

/** Commands that run another command; their operands must be checked too. */
const WRAPPERS = new Set([
	"sudo", "doas", "env", "nice", "nohup", "timeout", "stdbuf", "setsid", "ionice",
	"chronic", "exec", "eval", "xargs", "flock", "watch", "time", "su", "runuser",
	"script", "unbuffer", "chrt", "taskset", "pkexec",
]);

/** Shells: `sh -c '...'` executes its operand, so recurse into it. */
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "fish", "busybox"]);

/** Commands that only *describe* a binary and never run it. */
const PROBES = new Set(["which", "whereis", "type", "hash", "apropos", "whatis", "man"]);

/** Guards against self-referential parsing blow-ups. */
const MAX_DEPTH = 6;

/**
 * Shell keywords that only sequence other commands: `then find x`, `do grep x`,
 * `! grep x`, `{ grep x; }`. Dropped so the real command word is exposed.
 */
const KEYWORD_PREFIX = new Set(["then", "else", "elif", "do", "done", "fi", "esac", "in", "time", "!", "{", "(", "&&", "||"]);

/**
 * Keywords whose operand is a *condition*, which may itself contain commands:
 * `if grep -q foo f; then ...`.
 */
const CONDITION_KEYWORDS = new Set(["if", "while", "until"]);

type Hit = { binary: string; rule: Rule; command: string };

/* ------------------------------------------------------------------ *
 * Shell text parsing (quote-aware, so patterns are never misread)
 * ------------------------------------------------------------------ */

type Tok = { raw: string; quoted: boolean };

/** Split a segment into tokens, keeping quotes attached and flagging them. */
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

/** Split a command on `;`, `|`, `&&`, `||`, newline — never inside quotes. */
function splitSegments(cmd: string): string[] {
	const segs: string[] = [];
	let cur = "";
	let quote: string | null = null;
	let i = 0;
	while (i < cmd.length) {
		const c = cmd[i];
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
		if (c === "\\" && i + 1 < cmd.length) {
			cur += cmd.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (cmd.startsWith("&&", i) || cmd.startsWith("||", i)) {
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

/** Contents of `$(...)`, backticks and `<(...)` / `>(...)` substitutions. */
function substitutions(text: string): string[] {
	const found: string[] = [];
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
			found.push(text.slice(start, j));
			i = j + 1;
			continue;
		}
		if (text[i] === "`") {
			const end = text.indexOf("`", i + 1);
			if (end === -1) break;
			found.push(text.slice(i + 1, end));
			i = end + 1;
			continue;
		}
		i++;
	}
	return found;
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

/** `./usr/bin/find` and `/usr/bin/find` both mean `find`. */
function baseName(token: string): string {
	return unquote(token).replace(/^.*\//, "").replace(/\.exe$/i, "");
}

const ENV_ASSIGN = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+)+/;

/**
 * Blank out heredoc bodies so their contents are treated as data, not as
 * commands. `cat > s.sh <<'EOF'\ngrep foo f\nEOF` must not be read as a
 * `grep` call — it is text being written to a file. The delimiter line itself
 * is kept so the following command still parses.
 */
function maskHeredocs(command: string): string {
	const lines = command.split("\n");
	const out: string[] = [];
	let delimiter: string | null = null;
	for (const line of lines) {
		if (delimiter !== null) {
			if (line.trim() === delimiter) delimiter = null;
			else {
				out.push("");
				continue;
			}
		}
		const start = line.match(/<<[-]?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*$/);
		if (start) delimiter = start[2];
		out.push(line);
	}
	return out.join("\n");
}

/** Operand of a trailing `-c` / `-lc` flag, which a shell executes verbatim. */
function dashCOperand(toks: Tok[]): string | null {
	for (let i = 0; i < toks.length; i++) {
		const raw = unquote(toks[i].raw);
		if (raw === "-c" || /^-[a-z]{0,3}c$/.test(raw)) {
			const next = toks[i + 1];
			return next ? unquote(next.raw) : null;
		}
	}
	return null;
}

/* ------------------------------------------------------------------ *
 * Policy check
 * ------------------------------------------------------------------ */

function scanSegment(segment: string, depth: number): Hit | null {
	if (depth > MAX_DEPTH) return null;
	let s = segment.trim().replace(/^[!({`\s]+/, "");
	s = s.replace(ENV_ASSIGN, "").trim();
	// Drop sequencing keywords so the real command word surfaces.
	let toks = tokenize(s);
	while (toks.length > 0) {
		const head = unquote(toks[0].raw);
		if (KEYWORD_PREFIX.has(head)) {
			toks = toks.slice(1);
			continue;
		}
		if (CONDITION_KEYWORDS.has(head)) {
			toks = toks.slice(1);
			continue;
		}
		break;
	}
	if (toks.length === 0) return null;
	s = toks.map((t) => t.raw).join(" ");

	const head = baseName(toks[0].raw);
	const where = s.slice(0, 200);

	// `which find`, `type grep`: describes the binary, never runs it.
	if (PROBES.has(head)) return null;
	// `command -v grep` describes; `command grep foo` executes.
	if (head === "command") {
		const next = toks[1] ? unquote(toks[1].raw) : "";
		if (next === "-v" || next === "-V") return null;
		return scanSegment(toks.slice(1).map((t) => t.raw).join(" "), depth + 1);
	}

	// The obvious case: the segment starts with a blocked binary.
	const direct = RULES[head];
	if (direct) return { binary: head, rule: direct, command: where };

	// `sudo find`, `timeout 60 grep`, `env F=1 python3`, `xargs grep ...`
	if (WRAPPERS.has(head)) {
		for (let i = 1; i < toks.length; i++) {
			const raw = toks[i].raw;
			const word = baseName(raw);
			const rule = RULES[word];
			if (rule) return { binary: word, rule, command: where };
			if (SHELLS.has(word)) {
				const inner = dashCOperand(toks.slice(i));
				if (inner) {
					const nested = scanCommand(inner, depth + 1);
					if (nested) return nested;
				}
			}
			// A quoted multi-word operand is itself a command: `eval "grep -r foo ."`.
			// A single quoted word (`echo "grep"`) stays an argument.
			if (toks[i].quoted) {
				const inner = unquote(raw);
				if (/\s/.test(inner)) {
					const nested = scanCommand(inner, depth + 1);
					if (nested) return nested;
				}
			}
		}
		return null;
	}

	// `bash -c '...'`, `bash -lc '...'`, `busybox find`
	if (SHELLS.has(head)) {
		const inner = dashCOperand(toks);
		if (inner) {
			const nested = scanCommand(inner, depth + 1);
			if (nested) return nested;
		}
		if (head === "busybox" && toks[1]) {
			const word = baseName(toks[1].raw);
			const rule = RULES[word];
			if (rule) return { binary: word, rule, command: where };
		}
	}

	return null;
}

export function scanCommand(command: string, depth = 0): Hit | null {
	for (const segment of splitSegments(maskHeredocs(command))) {
		const hit = scanSegment(segment, depth);
		if (hit) return hit;
		for (const sub of substitutions(segment)) {
			const nested = scanCommand(sub, depth + 1);
			if (nested) return nested;
		}
	}
	return null;
}

/** Block message. Short: it costs fresh tokens on every violation. */
function blockMessage(hit: Hit): string {
	return (
		`tool-guard: \`${hit.binary}\` is blocked (${hit.rule.why}). ` +
		`Use \`${hit.rule.use}\`. Rewrite the command; do not retry it as written. ` +
		`Blocked: ${hit.command}`
	);
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

let blockedTotal = 0;
let overridden = 0;
const blockedByBinary = new Map<string, number>();

/**
 * Marker that re-opens the blocked binary for one command, but only when the
 * human enables it with PI_TOOL_GUARD_OVERRIDE=1. AGENTS.md allows a fallback
 * "and say why in one line", so the command must carry its own reason, which
 * is surfaced back to the model. Off by default, and a model cannot enable it.
 */
const OVERRIDE = /#\s*tool-guard\s+override\s*:\s*(.{3,160})/i;

function overrideEnabled(): boolean {
	const v = (process.env.PI_TOOL_GUARD_OVERRIDE ?? "").toLowerCase();
	return v === "1" || v === "true" || v === "on";
}

/** Per-run opt-out, e.g. `PI_TOOL_GUARD=off pi`. */
function enabled(): boolean {
	const v = (process.env.PI_TOOL_GUARD ?? "").toLowerCase();
	return v !== "off" && v !== "0" && v !== "false";
}

function check(command: string): ToolCallEventResult | undefined {
	const hit = scanCommand(command);
	if (!hit) return undefined;
	const claim = command.match(OVERRIDE);
	if (overrideEnabled() && claim) {
		overridden++;
		return undefined;
	}
	blockedTotal++;
	blockedByBinary.set(hit.binary, (blockedByBinary.get(hit.binary) ?? 0) + 1);
	return { block: true, reason: blockMessage(hit) };
}

export default function toolGuard(pi: ExtensionAPI) {
	// Model-issued shell calls: the only path where a policy can be enforced.
	pi.on("tool_call", (event: ToolCallEvent) => {
		if (!enabled()) return;
		if (event.toolName === "bash") {
			const { command } = (event as BashToolCallEvent).input;
			if (typeof command === "string") return check(command);
		}
		if (event.toolName === "powershell") {
			const { command } = (event as PowerShellToolCallEvent).input as { command?: string };
			if (typeof command === "string") return check(command);
		}
		return undefined;
	});

	// `/tool-guard` — confirm the guard is loaded and see what it stopped.
	pi.registerCommand("tool-guard", {
		description: "Show tool-guard status and blocked-command counts",
			handler: (_args, ctx) => {
				const stats = [...blockedByBinary.entries()]
					.map(([binary, n]) => `${binary}: ${n}`)
					.join(", ");
				const state = enabled()
					? `tool-guard active — blocked ${blockedTotal} shell call(s)${stats ? ` (${stats})` : ""}`
					: `tool-guard disabled by PI_TOOL_GUARD for this run.`;
				const over = overrideEnabled()
					? `override marker allowed (PI_TOOL_GUARD_OVERRIDE=1, ${overridden} used)`
					: `override marker ignored (set PI_TOOL_GUARD_OVERRIDE=1 to allow \`# tool-guard override: <reason>\`)`;
				const text = `${state}. ${over}.`;
				if (ctx.hasUI) ctx.ui.notify(text, "info");
				else console.log(text);
			},
	});
}
