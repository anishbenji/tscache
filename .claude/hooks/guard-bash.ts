// PreToolUse guard for Bash — enforces the toolchain rules in AGENTS.md.
// Exit 2 blocks the call and returns stderr to Claude.
// Regression cases: .claude/hooks/guard-bash.test.sh
//
// The command is tokenized like a shell would (quotes, escapes, operators,
// heredocs, $(…) and backtick substitutions, `bash -c` and `eval` bodies),
// so rules apply to real argv rather than to text: a commit message that
// mentions a forbidden flag passes, and quoting or wrappers cannot hide one.
// It is still a tripwire, not a security boundary — variables, aliases and
// scripts on disk are out of reach. The rules bind through AGENTS.md anyway.

export {};

type Command = string[];

class ParseError extends Error {}

const SEPARATORS = new Set([";", "&", "|", "(", ")", "\n"]);

/** Splits shell source into simple commands, recursing into substitutions. */
function parse(src: string): Command[] {
  const commands: Command[] = [];
  let argv: string[] = [];
  let word: string | null = null;
  const heredocs: { delim: string; strip: boolean; expand: boolean }[] = [];
  let i = 0;

  const endWord = () => {
    if (word !== null) argv.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
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
      let s = "";
      while (j < src.length && src[j] !== "'") {
        if (src[j] === "\\") j++;
        s += src[j] ?? "";
        j++;
      }
      if (j >= src.length) throw new ParseError("unterminated $'");
      append(s);
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
    } else if (c === " " || c === "\t" || c === "<" || c === ">") {
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

function checkGit(args: string[]): string | null {
  let k = 0;
  while (k < args.length && (args[k] as string).startsWith("-")) {
    const opt = args[k] as string;
    if (/core\.hookspath/i.test(opt) || (GIT_OPTS_WITH_VALUE.has(opt) && /core\.hookspath/i.test(args[k + 1] ?? ""))) {
      return HOOK_BYPASS;
    }
    k += GIT_OPTS_WITH_VALUE.has(opt) ? 2 : 1;
  }
  const sub = args[k];
  const rest = args.slice(k + 1);
  // Git accepts unambiguous prefixes of long options: --no-v… is --no-verify.
  if (rest.some((a) => /^--no-v/i.test(a) || /core\.hookspath/i.test(a))) return HOOK_BYPASS;
  if (sub === "commit") {
    for (let j = 0; j < rest.length; j++) {
      const a = rest[j] as string;
      if (a === "--") break;
      if (/^-[a-zA-Z]*n[a-zA-Z]*$/.test(a)) return HOOK_BYPASS;
      // -m, -F, -c, -C take a value; skip it so a message is never a flag.
      if (/^-[a-zA-Z]*[mFcCt]$/.test(a)) j++;
    }
  }
  return null;
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

  if (cmd === "bun" && args[0] === "test") return BUN_TEST;
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
