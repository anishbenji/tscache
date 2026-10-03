// PreToolUse guard for Bash — enforces the toolchain rules in AGENTS.md.
// Exit 2 blocks the call and returns stderr to Claude.
// Regression cases: .claude/hooks/guard-bash.test.sh
//
// The command is tokenized like a shell would (quotes, escapes, operators,
// heredocs, $(…) and backtick substitutions, `bash -c` and `eval` bodies),
// so rules apply to real argv rather than to text: a commit message that
// mentions a forbidden flag passes, and quoting or wrappers cannot hide one.
// It is a tripwire against accidental violations, not a security boundary.
// Known limits, by design: variable expansion (`$X test`), aliases and
// functions, scripts on disk, tools that spawn git or bun themselves, and
// option tables (git, bun) that cover common options rather than all of
// them. The rules bind through AGENTS.md regardless.

export {};

type Command = string[];

class ParseError extends Error {}

const SEPARATORS = new Set([";", "&", "|", "(", ")", "\n"]);

const ANSI_C_ESCAPES: Record<string, string> = {
  a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
  "\\": "\\", "'": "'", '"': '"', "?": "?",
};

/** Decodes the body of a bash `$'…'` string. */
function decodeAnsiC(body: string): string {
  return body.replace(
    /\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/gs,
    (_m, e: string) => {
      const head = e[0] as string;
      if (head === "x" || head === "u" || head === "U") {
        return String.fromCodePoint(Number.parseInt(e.slice(1), 16));
      }
      if (/[0-7]/.test(head)) return String.fromCharCode(Number.parseInt(e, 8));
      if (head === "c" && e.length === 2) return String.fromCharCode(e.charCodeAt(1) & 0x1f);
      return ANSI_C_ESCAPES[e] ?? `\\${e}`;
    },
  );
}

/** Splits shell source into simple commands, recursing into substitutions. */
function parse(src: string): Command[] {
  const commands: Command[] = [];
  let argv: string[] = [];
  let word: string | null = null;
  const heredocs: { delim: string; strip: boolean; expand: boolean }[] = [];
  let i = 0;
  // A redirection's target (`> file`, `2>&1`) is not an argument.
  let skipTarget = false;

  const endWord = () => {
    if (word !== null) {
      if (skipTarget) skipTarget = false;
      else argv.push(word);
    }
    word = null;
  };
  const endCommand = () => {
    endWord();
    skipTarget = false;
    if (argv.length > 0) commands.push(argv);
    argv = [];
  };
  const append = (s: string) => {
    word = (word ?? "") + s;
  };
  const nested = (body: string) => {
    commands.push(...parse(body));
  };

  /** Index of the `)` closing a `$(` whose body starts at `from`. */
  const closeParen = (from: number): number => {
    let depth = 1;
    for (let j = from; j < src.length; j++) {
      const c = src[j];
      if (c === "\\") j++;
      else if (c === "'") {
        j = src.indexOf("'", j + 1);
        if (j < 0) break;
      } else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return j;
    }
    throw new ParseError("unbalanced $(");
  };
  const closeBacktick = (from: number): number => {
    for (let j = from; j < src.length; j++) {
      if (src[j] === "\\") j++;
      else if (src[j] === "`") return j;
    }
    throw new ParseError("unbalanced backtick");
  };
  /** Runs substitutions found in text the shell expands (heredoc bodies). */
  const expandSubstitutions = (text: string) => {
    for (const m of text.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)) {
      nested(m[1] ?? m[2] ?? "");
    }
  };
  const readHeredocs = () => {
    for (const doc of heredocs.splice(0)) {
      const body: string[] = [];
      while (i < src.length) {
        const eol = src.indexOf("\n", i);
        const line = src.slice(i, eol < 0 ? src.length : eol);
        i = eol < 0 ? src.length : eol + 1;
        if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delim) break;
        body.push(line);
      }
      if (doc.expand) expandSubstitutions(body.join("\n"));
    }
  };

  while (i < src.length) {
    const c = src[i] as string;
    if (c === "\\") {
      if (src[i + 1] !== "\n") append(src[i + 1] ?? "");
      i += 2;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) throw new ParseError("unterminated single quote");
      append(src.slice(i + 1, end));
      i = end + 1;
    } else if (c === "$" && src[i + 1] === "'") {
      let j = i + 2;
      while (j < src.length && src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) throw new ParseError("unterminated $'");
      append(decodeAnsiC(src.slice(i + 2, j)));
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== '"') {
        const d = src[j];
        if (d === "\\") {
          s += src[j + 1] ?? "";
          j += 2;
        } else if (d === "$" && src[j + 1] === "(") {
          const end = closeParen(j + 2);
          nested(src.slice(j + 2, end));
          j = end + 1;
        } else if (d === "`") {
          const end = closeBacktick(j + 1);
          nested(src.slice(j + 1, end));
          j = end + 1;
        } else {
          s += d;
          j++;
        }
      }
      if (j >= src.length) throw new ParseError("unterminated double quote");
      append(s);
      i = j + 1;
    } else if (c === "$" && src[i + 1] === "(") {
      const end = closeParen(i + 2);
      nested(src.slice(i + 2, end));
      append("");
      i = end + 1;
    } else if (c === "`") {
      const end = closeBacktick(i + 1);
      nested(src.slice(i + 1, end));
      append("");
      i = end + 1;
    } else if (c === "#" && word === null) {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      endWord();
      i += 2;
      const strip = src[i] === "-";
      if (strip) i++;
      while (src[i] === " " || src[i] === "\t") i++;
      const m = /^(['"]?)([^\s;&|<>()'"]+)\1/.exec(src.slice(i));
      if (!m) throw new ParseError("bad heredoc delimiter");
      heredocs.push({ delim: m[2] as string, strip, expand: m[1] === "" });
      i += m[0].length;
    } else if (c === "<" || c === ">" || (c === "&" && src[i + 1] === ">")) {
      // Redirection: drop a leading fd number (`2>`) and the target word,
      // but keep process substitution `<(…)` / `>(…)` as nested commands.
      if (word !== null && /^\d+$/.test(word)) word = null;
      else endWord();
      i++;
      while (src[i] === "<" || src[i] === ">" || src[i] === "&" || src[i] === "|") i++;
      if (src[i] !== "(") skipTarget = true;
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (SEPARATORS.has(c)) {
      endCommand();
      i++;
      if (c === "\n") readHeredocs();
    } else {
      append(c);
      i++;
    }
  }
  endCommand();
  return commands;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const KEYWORDS = new Set(["{", "}", "!", "if", "then", "elif", "else", "do", "while", "until", "time"]);
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "exec", "nohup", "nice", "xargs", "timeout", "bunx", "npx"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const EXPORTERS = new Set(["export", "declare", "typeset", "readonly", "local"]);
const GIT_OPTS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

const BUN_TEST = "never run 'bun test' — Vitest runs under Node. Use 'bun run test' or 'bunx vitest run'.";
const HOOK_BYPASS = "git hooks must not be bypassed. Fix the failing check instead.";

const basename = (w: string) => w.slice(w.lastIndexOf("/") + 1);

function checkAssignment(name: string, value: string): string | null {
  if (name === "LEFTHOOK" && /^(0|false)$/i.test(value)) return HOOK_BYPASS;
  if (name === "LEFTHOOK_EXCLUDE" || name === "LEFTHOOK_SKIP") return HOOK_BYPASS;
  if (/core\.hookspath/i.test(value)) return HOOK_BYPASS;
  return null;
}

// Subcommand options whose value is a separate word (a message, a file, ...).
// Skipping the value keeps `-m '--no-verify is forbidden'` from reading as a flag.
const GIT_SHORT_WITH_VALUE = new Set(["m", "F", "C", "c", "t", "o"]);
const GIT_LONG_WITH_VALUE = new Set([
  "--message", "--file", "--author", "--date", "--template", "--trailer", "--cleanup",
  "--fixup", "--squash", "--reuse-message", "--reedit-message", "--push-option",
  "--receive-pack", "--exec", "--repo", "--pathspec-from-file",
]);
const HOOKS_PATH = /core\.hookspath/i;

function checkGit(args: string[]): string | null {
  let k = 0;
  while (k < args.length && (args[k] as string).startsWith("-")) {
    const opt = args[k] as string;
    if (HOOKS_PATH.test(opt) || (GIT_OPTS_WITH_VALUE.has(opt) && HOOKS_PATH.test(args[k + 1] ?? ""))) {
      return HOOK_BYPASS;
    }
    k += GIT_OPTS_WITH_VALUE.has(opt) ? 2 : 1;
  }
  const sub = args[k];
  const rest = args.slice(k + 1);
  // `git config core.hooksPath …` names the key as an operand.
  if (sub === "config" && rest.some((a) => HOOKS_PATH.test(a))) return HOOK_BYPASS;

  for (let j = 0; j < rest.length; j++) {
    const a = rest[j] as string;
    if (a === "--") break;
    if (a.startsWith("--")) {
      // Git accepts unambiguous prefixes of long options: --no-v… is --no-verify.
      if (/^--no-v/i.test(a)) return HOOK_BYPASS;
      if (GIT_LONG_WITH_VALUE.has(a)) j++;
    } else if (/^-[a-zA-Z]/.test(a)) {
      // Short cluster: a value-taking letter consumes the rest of the word,
      // or the next word when it is last (`-nm msg`, `-mn` = message "n").
      for (let p = 1; p < a.length; p++) {
        const letter = a[p] as string;
        if (sub === "commit" && letter === "n") return HOOK_BYPASS;
        if (GIT_SHORT_WITH_VALUE.has(letter)) {
          if (p === a.length - 1) j++;
          break;
        }
      }
    }
  }
  return null;
}

// Bun options whose value is a separate word; the subcommand follows them.
const BUN_OPTS_WITH_VALUE = new Set([
  "--cwd", "--config", "-c", "--env-file", "--preload", "-r", "--tsconfig-override",
  "--define", "-d", "--loader", "-l", "--conditions", "--main-fields", "--port",
  "--install", "--jsx-factory", "--jsx-fragment", "--jsx-import-source", "--jsx-runtime",
]);

function bunSubcommand(args: string[]): string | undefined {
  let k = 0;
  while (args[k]?.startsWith("-")) k += BUN_OPTS_WITH_VALUE.has(args[k] as string) ? 2 : 1;
  return args[k];
}

function check(argv: string[]): string | null {
  let k = 0;
  for (;;) {
    const w = argv[k];
    if (w === undefined) return null;
    const assignment = ASSIGNMENT.exec(w);
    if (assignment) {
      const hit = checkAssignment(assignment[1] as string, assignment[2] as string);
      if (hit) return hit;
      k++;
    } else if (KEYWORDS.has(w)) {
      k++;
    } else if (WRAPPERS.has(basename(w))) {
      const wrapper = basename(w);
      k++;
      while (argv[k]?.startsWith("-")) k += /^-[ugCD]$/.test(argv[k] as string) ? 2 : 1;
      if (wrapper === "timeout") k++;
    } else break;
  }
  const cmd = basename(argv[k] as string);
  const args = argv.slice(k + 1);

  if (cmd === "bun" && bunSubcommand(args) === "test") return BUN_TEST;
  if (cmd === "git") return checkGit(args);
  if (cmd === "lefthook" && args.includes("uninstall")) return HOOK_BYPASS;
  if (EXPORTERS.has(cmd)) {
    for (const a of args) {
      const m = ASSIGNMENT.exec(a);
      const hit = m && checkAssignment(m[1] as string, m[2] as string);
      if (hit) return hit;
    }
  }
  if (cmd === "eval") return checkSource(args.join(" "));
  if (SHELLS.has(cmd)) {
    const flag = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (flag >= 0 && args[flag + 1] !== undefined) return checkSource(args[flag + 1] as string);
  }
  return null;
}

/** Fails closed on unparseable input, but only if it names a guarded tool. */
function checkSource(src: string): string | null {
  let commands: Command[];
  try {
    commands = parse(src);
  } catch {
    if (/\bbun\b[\s\S]*\btest\b/.test(src)) return BUN_TEST;
    if (/--no-v|hookspath|lefthook/i.test(src)) return HOOK_BYPASS;
    return null;
  }
  for (const argv of commands) {
    const hit = check(argv);
    if (hit) return hit;
  }
  return null;
}

const input = await Bun.stdin.json();
const reason = checkSource(input?.tool_input?.command ?? "");
if (reason) {
  console.error(`Blocked by .claude/hooks/guard-bash.sh: ${reason}`);
  process.exit(2);
}
