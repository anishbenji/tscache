// PreToolUse guard for Bash — enforces the toolchain rules in AGENTS.md.
// Exit 2 blocks the call and returns stderr to Claude.
// Regression cases: .claude/hooks/guard-bash.test.sh
//
// Threat model. The guard stops an agent from *accidentally* running the
// forbidden test runner or bypassing git hooks, in any way an agent plausibly
// writes shell: quoting, escapes, wrappers and their options, redirections,
// keyword and function forms, substitutions, several commands or lines.
//   1. Static commands are tokenized like bash and checked on real argv, so
//      a commit message that mentions a flag passes.
//   2. Dynamic input the guard cannot resolve (variables, $(…), backticks,
//      brace expansion, xargs reading stdin) fails closed: if a guarded
//      command has a dynamic word and the command text contains a trigger,
//      it is blocked.
//   3. Unparseable input fails closed on the same text triggers.
// Out of scope: deliberate evasion where no trigger appears in the text
// (encoded or assembled strings), aliases or functions defined in an earlier
// call, scripts on disk, and tools that spawn git or bun themselves. It is a
// tripwire, not a security boundary; the rules bind through AGENTS.md and
// git hooks run regardless.

export {};

type Command = string[];

class ParseError extends Error {}

/** Marks a word whose value the shell computes at run time. */
const DYN = "\u0001";
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

/** True when `$` at `j` starts a parameter expansion. */
const isExpansion = (src: string, j: number) => /[A-Za-z_{@*#?$!0-9-]/.test(src[j + 1] ?? "");

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
          s += DYN;
          j = end + 1;
        } else if (d === "`") {
          const end = closeBacktick(j + 1);
          nested(src.slice(j + 1, end));
          s += DYN;
          j = end + 1;
        } else {
          if (d === "$" && isExpansion(src, j)) s += DYN;
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
      append(DYN);
      i = end + 1;
    } else if (c === "`") {
      const end = closeBacktick(i + 1);
      nested(src.slice(i + 1, end));
      append(DYN);
      i = end + 1;
    } else if (c === "$" && isExpansion(src, i)) {
      append(`${DYN}$`);
      i++;
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

const BUN_TEST = "never run 'bun test' — Vitest runs under Node. Use 'bun run test' or 'bunx vitest run'.";
const HOOK_BYPASS = "git hooks must not be bypassed. Fix the failing check instead.";

// Text triggers, used where argv cannot be resolved (dynamic or unparseable).
// Order-independent: `echo test | xargs bun` names the subcommand first.
const hasBunTest = (src: string) => /\bbun\b/.test(src) && /\btest\b/.test(src);
const HOOK_BYPASS_TEXT = /--no-v|hookspath|lefthook(=|_exclude|_skip|\s+uninstall)/i;
const SHORT_N_TEXT = /(^|[\s='"])-[a-zA-Z]*n\b/;

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const KEYWORDS = new Set(["{", "}", "!", "if", "then", "elif", "else", "do", "while", "until"]);
// Wrapper → its options that take a separate value word.
const WRAPPERS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-R", "--user", "--group", "--chdir"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "-C", "--unset", "--chdir"]),
  command: new Set(),
  exec: new Set(["-a"]),
  nohup: new Set(),
  nice: new Set(["-n", "--adjustment"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  time: new Set(["-f", "-o", "--format", "--output"]),
  xargs: new Set(["-I", "-n", "-L", "-P", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file"]),
  bunx: new Set(),
  npx: new Set(),
};
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const EXPORTERS = new Set(["export", "declare", "typeset", "readonly", "local"]);
const GIT_OPTS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

const basename = (w: string) => w.slice(w.lastIndexOf("/") + 1);
const isDynamic = (w: string) => w.includes(DYN) || /\{[^{}]*,[^{}]*\}/.test(w);

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

function checkGit(args: string[], src: string, dynamicInput: boolean): string | null {
  let k = 0;
  // A dynamic global option (`-c "$X"`) may set core.hooksPath at run time.
  let dynamic = dynamicInput;
  while (k < args.length && (args[k] as string).startsWith("-")) {
    const opt = args[k] as string;
    const value = GIT_OPTS_WITH_VALUE.has(opt) ? (args[k + 1] ?? "") : "";
    if (HOOKS_PATH.test(opt) || HOOKS_PATH.test(value)) return HOOK_BYPASS;
    if (isDynamic(opt) || isDynamic(value)) dynamic = true;
    k += GIT_OPTS_WITH_VALUE.has(opt) ? 2 : 1;
  }
  const sub = args[k];
  const rest = args.slice(k + 1);
  // `git config core.hooksPath …` names the key as an operand.
  if (sub === "config" && rest.some((a) => HOOKS_PATH.test(a))) return HOOK_BYPASS;

  // Words that are options or operands; option values (a message, a file)
  // are skipped, so neither their text nor their dynamism counts.
  if (sub !== undefined && isDynamic(sub)) dynamic = true;
  for (let j = 0; j < rest.length; j++) {
    const a = rest[j] as string;
    if (a === "--") break;
    if (isDynamic(a)) dynamic = true;
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
  // A dynamic option or operand may expand to a bypass flag at run time.
  if (dynamic) {
    if (HOOK_BYPASS_TEXT.test(src)) return HOOK_BYPASS;
    if ((sub === "commit" || isDynamic(sub ?? "")) && SHORT_N_TEXT.test(src)) return HOOK_BYPASS;
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

/**
 * Text-trigger fallback for input whose argv the guard cannot resolve.
 * Unparseable input is broader still: any mention of Lefthook blocks.
 */
function checkText(src: string, unparseable = false): string | null {
  if (hasBunTest(src)) return BUN_TEST;
  if (HOOK_BYPASS_TEXT.test(src) || (unparseable && /lefthook/i.test(src))) return HOOK_BYPASS;
  if (/\bgit\b/.test(src) && SHORT_N_TEXT.test(src)) return HOOK_BYPASS;
  return null;
}

function check(argv: string[], src: string): string | null {
  let k = 0;
  let stdinArgs = false;
  for (;;) {
    const w = argv[k];
    if (w === undefined) return null;
    const assignment = ASSIGNMENT.exec(w);
    const wrapper = WRAPPERS[basename(w)];
    if (assignment) {
      const hit = checkAssignment(assignment[1] as string, assignment[2] as string);
      if (hit) return hit;
      k++;
    } else if (KEYWORDS.has(w)) {
      k++;
    } else if (w === "function") {
      k += 2; // `function name { … }`
    } else if (w === "coproc") {
      k += argv[k + 2] === "{" ? 2 : 1; // `coproc [NAME] { … }` or `coproc cmd`
    } else if (wrapper) {
      const name = basename(w);
      k++;
      while (argv[k]?.startsWith("-")) {
        const opt = argv[k] as string;
        // `env -S 'cmd args'` runs its value as a command line.
        if (name === "env" && opt === "-S") return checkSource(argv[k + 1] ?? "", src);
        k += wrapper.has(opt) ? 2 : 1;
      }
      if (name === "timeout") k++; // the duration
      if (name === "xargs") stdinArgs = true;
    } else break;
  }
  const words = argv.slice(k);
  const cmd = basename(words[0] as string);
  const args = words.slice(1);

  // Dynamic input exists only at run time, so fall back to text triggers:
  // all of them for an unknown command, the relevant ones for bun and git.
  if (isDynamic(words[0] as string)) return checkText(src);
  if (cmd === "bun") {
    if (bunSubcommand(args) === "test") return BUN_TEST;
    if ((stdinArgs || args.some(isDynamic)) && hasBunTest(src)) return BUN_TEST;
    return null;
  }
  if (cmd === "git") return checkGit(args, src, stdinArgs);
  if (cmd === "lefthook" && args.includes("uninstall")) return HOOK_BYPASS;
  if (EXPORTERS.has(cmd)) {
    for (const a of args) {
      const m = ASSIGNMENT.exec(a);
      const hit = m && checkAssignment(m[1] as string, m[2] as string);
      if (hit) return hit;
    }
  }
  if (cmd === "eval") return checkSource(args.join(" "), src);
  if (SHELLS.has(cmd)) {
    const flag = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (flag >= 0 && args[flag + 1] !== undefined) return checkSource(args[flag + 1] as string, src);
  }
  return null;
}

/**
 * Checks a command line; unparseable input fails closed on text triggers.
 * `root` is the whole tool call: nested sources (`sh -c "$CMD"`, `eval`)
 * still match text triggers against it, where the value was assigned.
 */
function checkSource(src: string, root: string = src): string | null {
  let commands: Command[];
  try {
    commands = parse(src);
  } catch {
    return checkText(root, true);
  }
  for (const argv of commands) {
    const hit = check(argv, root);
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
