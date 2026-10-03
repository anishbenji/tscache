// PreToolUse guard for Bash — enforces the toolchain rules in AGENTS.md.
// Exit 2 blocks the call and returns stderr to Claude.
// Regression cases: .claude/hooks/guard-bash.test.sh
//
// Threat model. A tripwire for the likely *accidents*: typing the forbidden
// test runner, or reaching for a hook-bypass flag after a hook fails. It
// checks literal commands only, tokenized like bash: quoting, escapes,
// operators, redirections, heredocs, wrappers and their options, keyword and
// function forms, and static `bash -c` / `eval` / `env -S` bodies.
//
// Out of scope by design: values known only at run time (variables, $(…),
// backticks, brace expansion, stdin, aliases), unparseable input, tools that
// spawn git or bun themselves, and options missing from the git, bun and
// wrapper tables (they cover common options, not all). Those are not
// accidents, and hardening against them made the guard large and noisy.
// The backstop is `bun run ci`, which re-runs gitleaks and commitlint over
// every commit on the branch, so a hook bypass is caught before merge however
// it was done. For the same reason a guard crash lets the command through
// rather than blocking every Bash call.

export {};

type Command = string[];

class ParseError extends Error {}

const SEPARATORS = new Set([";", "&", "|", "(", ")", "\n"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

const ANSI_C_ESCAPES: Record<string, string> = {
  a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
  "\\": "\\", "'": "'", '"': '"', "?": "?",
};

/** Decodes the body of a bash `$'…'` string; bash truncates it at NUL. */
function decodeAnsiC(body: string): string {
  const decoded = body.replace(
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
  const nul = decoded.indexOf("\0");
  return nul < 0 ? decoded : decoded.slice(0, nul);
}

const basename = (w: string) => w.slice(w.lastIndexOf("/") + 1);

/**
 * Splits shell source into simple commands. Substitution bodies are parsed
 * as commands of their own (they run), but their output is not modelled.
 */
function parse(src: string): Command[] {
  const commands: Command[] = [];
  let argv: string[] = [];
  let word: string | null = null;
  const heredocs: { delim: string; strip: boolean; expand: boolean; owner: string[] }[] = [];
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
      const text = body.join("\n");
      // A heredoc fed to a shell with no -c is its script; otherwise only
      // substitutions in an unquoted heredoc run.
      const start = commandStart(doc.owner);
      const owner = doc.owner[start.k];
      const shell = !start.lookup && !start.split && owner !== undefined && SHELLS.has(basename(owner));
      if (shell && !doc.owner.slice(start.k + 1).some((a) => /^-[a-z]*c[a-z]*$/.test(a))) nested(text);
      else if (doc.expand) {
        for (const m of text.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)) nested(m[1] ?? m[2] ?? "");
      }
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
      heredocs.push({ delim: m[2] as string, strip, expand: m[1] === "", owner: argv });
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

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const KEYWORDS = new Set(["{", "}", "!", "if", "then", "elif", "else", "do", "while", "until"]);
// Wrapper → its options that take a separate value word.
const WRAPPERS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-R", "--user", "--group", "--chdir"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "-C", "--unset", "--chdir"]),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(["-a"]),
  nohup: new Set(),
  nice: new Set(["-n", "--adjustment"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  time: new Set(["-f", "-o", "--format", "--output"]),
  xargs: new Set(["-I", "-n", "-L", "-P", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file"]),
  bunx: new Set(),
  npx: new Set(),
};
const EXPORTERS = new Set(["export", "declare", "typeset", "readonly", "local"]);
const GIT_OPTS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
const HOOKS_PATH = /core\.hookspath/i;
const HOOKS_PATH_KEY = /^core\.hookspath$/i;
const configKey = (keyValue: string) => keyValue.split("=")[0] ?? "";
// Lefthook variables that only change output. Any other LEFTHOOK_* variable
// (LEFTHOOK_BIN, LEFTHOOK_CONFIG, LEFTHOOK_EXCLUDE, ...) can change or skip
// what the hooks run, so it fails closed.
const LEFTHOOK_OUTPUT_VARS = new Set(["LEFTHOOK_VERBOSE", "LEFTHOOK_QUIET", "LEFTHOOK_OUTPUT"]);

/** Literal assignments that turn hooks off. */
function checkAssignment(name: string, value: string): string | null {
  if (name === "LEFTHOOK") return /^(0|false)$/i.test(value) ? HOOK_BYPASS : null;
  if (name.startsWith("LEFTHOOK_") && !LEFTHOOK_OUTPUT_VARS.has(name)) return HOOK_BYPASS;
  if (name.startsWith("GIT_CONFIG") && HOOKS_PATH.test(value)) return HOOK_BYPASS;
  return null;
}

// Subcommand options whose value is a separate word (a message, a file, ...).
// Skipping the value keeps `-m '--no-verify is forbidden'` from reading as a flag.
const GIT_SHORT_WITH_VALUE = new Set(["m", "F", "C", "c", "t", "o"]);
const GIT_LONG_WITH_VALUE = new Set([
  "--message", "--file", "--author", "--date", "--template", "--trailer", "--cleanup",
  "--fixup", "--squash", "--reuse-message", "--reedit-message", "--push-option",
  "--receive-pack", "--exec", "--repo", "--pathspec-from-file", "--grep",
]);
// `git config` forms that only read or remove a key: a legacy flag, or a
// subcommand word as the first operand (`git config get <key>`). A bare word
// elsewhere is a value: `git config core.hooksPath list` sets it.
const GIT_CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "-l", "--list", "--unset", "--unset-all"]);
const GIT_CONFIG_READ_SUBCOMMANDS = new Set(["get", "list", "unset"]);
const GIT_CONFIG_OPTS_WITH_VALUE = new Set(["-f", "--file", "--blob", "--type", "--default", "--comment", "--value"]);

/**
 * Whether `git config <rest>` writes core.hooksPath. One pass separates
 * options, their values and operands, so a value is never read as a flag.
 */
function configWritesHooksPath(rest: string[]): boolean {
  const operands: string[] = [];
  for (let j = 0; j < rest.length; j++) {
    const a = rest[j] as string;
    if (a === "--") {
      operands.push(...rest.slice(j + 1));
      break;
    }
    if (!a.startsWith("-")) operands.push(a);
    else if (GIT_CONFIG_READ_FLAGS.has(a)) return false;
    else if (GIT_CONFIG_OPTS_WITH_VALUE.has(a)) j++;
  }
  const [first, second] = operands;
  if (first === undefined || GIT_CONFIG_READ_SUBCOMMANDS.has(first)) return false;
  if (first === "set") return HOOKS_PATH_KEY.test(second ?? "");
  // Legacy form: `<key>` alone reads, `<key> <value>` writes.
  return HOOKS_PATH_KEY.test(first) && second !== undefined;
}

function checkGit(args: string[]): string | null {
  let k = 0;
  while (k < args.length && (args[k] as string).startsWith("-")) {
    const opt = args[k] as string;
    // `-c <key>=<value>`, `--config-env <key>=<var>` or `--config-env=…`:
    // match the key, not a value that merely names it.
    const setting =
      opt === "-c" || opt === "--config-env" ? (args[k + 1] ?? "")
      : opt.startsWith("--config-env=") ? opt.slice("--config-env=".length)
      : "";
    if (HOOKS_PATH_KEY.test(configKey(setting))) return HOOK_BYPASS;
    k += GIT_OPTS_WITH_VALUE.has(opt) ? 2 : 1;
  }
  const sub = args[k];
  const rest = args.slice(k + 1);
  // `git config core.hooksPath <path>` sets it; reads and unsets are fine.
  if (sub === "config" && configWritesHooksPath(rest)) return HOOK_BYPASS;

  for (let j = 0; j < rest.length; j++) {
    const a = rest[j] as string;
    if (a === "--") break;
    if (a.startsWith("--")) {
      // Git accepts unambiguous prefixes: --no-veri… can only be --no-verify.
      if (/^--no-veri/i.test(a)) return HOOK_BYPASS;
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

// Common Bun options whose value is a separate word; the subcommand follows.
const BUN_OPTS_WITH_VALUE = new Set([
  "--cwd", "--config", "-c", "--env-file", "--preload", "-r", "--tsconfig-override",
  "--define", "-d", "--loader", "-l", "--conditions", "--main-fields", "--port",
  "--install", "--console-depth", "--user-agent", "--jsx-factory", "--jsx-fragment",
  "--jsx-import-source", "--jsx-runtime",
]);

/** Index of Bun's subcommand, after its global options. */
function bunSubcommand(args: string[]): number {
  let k = 0;
  while (args[k]?.startsWith("-")) k += BUN_OPTS_WITH_VALUE.has(args[k] as string) ? 2 : 1;
  return k;
}

/** `bun test` is forbidden; `bun x|run|exec <cmd>` runs <cmd>, so check it. */
function checkBun(args: string[]): string | null {
  const k = bunSubcommand(args);
  const sub = args[k];
  if (sub === "test") return BUN_TEST;
  if (sub === "x" || sub === "run" || sub === "exec") {
    const rest = args.slice(k + 1);
    return check(rest.slice(bunSubcommand(rest)));
  }
  return null;
}

/**
 * Walks leading assignments, keywords and wrappers to the command word.
 * `lookup` marks `command -v` (runs nothing); `split` is the argv that
 * `env -S` builds from its value plus the remaining arguments.
 */
function commandStart(argv: string[]): { k: number; lookup?: boolean; split?: string[] } {
  let k = 0;
  for (;;) {
    const w = argv[k];
    if (w === undefined) return { k };
    const name = basename(w);
    const wrapper = WRAPPERS[name];
    if (ASSIGNMENT.test(w) || KEYWORDS.has(w)) {
      k++;
    } else if (w === "function") {
      k += 2; // `function name { … }`
    } else if (w === "coproc") {
      k += argv[k + 2] === "{" ? 2 : 1; // `coproc [NAME] { … }` or `coproc cmd`
    } else if (wrapper) {
      k++;
      while (argv[k]?.startsWith("-")) {
        const opt = argv[k] as string;
        // `command -v`, `-V`, `-vv`, `-pv` only look a command up.
        if (name === "command" && /^-[pvV]*[vV][pvV]*$/.test(opt)) return { k, lookup: true };
        // `env -S 'cmd args'` (or -S'…') splits its value with shell-like
        // quoting and runs it followed by the remaining arguments, kept whole.
        if (name === "env" && opt.startsWith("-S")) {
          const attached = opt.length > 2;
          const value = attached ? opt.slice(2) : (argv[k + 1] ?? "");
          // `\_` is env's escaped space. If the value does not parse, fall back
          // to plain whitespace splitting rather than skipping the check.
          const spaced = value.replaceAll("\\_", " ");
          let words: string[];
          try {
            words = parse(spaced).flat();
          } catch {
            words = spaced.split(/\s+/).filter(Boolean);
          }
          return { k, split: [...words, ...argv.slice(k + (attached ? 1 : 2))] };
        }
        k += wrapper.has(opt) ? 2 : 1;
      }
      if (name === "timeout") k++; // the duration
    } else return { k };
  }
}

function check(argv: string[]): string | null {
  const start = commandStart(argv);
  for (const w of argv.slice(0, start.k)) {
    const m = ASSIGNMENT.exec(w);
    const hit = m && checkAssignment(m[1] as string, m[2] as string);
    if (hit) return hit;
  }
  if (start.lookup) return null;
  if (start.split) return check(start.split);
  const k = start.k;
  if (argv[k] === undefined) return null;
  const cmd = basename(argv[k] as string);
  const args = argv.slice(k + 1);

  if (cmd === "bun") return checkBun(args);
  if (cmd === "git") return checkGit(args);
  if (cmd === "lefthook") return args.includes("uninstall") ? HOOK_BYPASS : null;
  if (EXPORTERS.has(cmd)) {
    for (const a of args) {
      const m = ASSIGNMENT.exec(a);
      const hit = m && checkAssignment(m[1] as string, m[2] as string);
      if (hit) return hit;
    }
  }
  // A `--` terminator before an eval or `-c` body is consumed by bash.
  if (cmd === "eval") return checkSource((args[0] === "--" ? args.slice(1) : args).join(" "));
  if (SHELLS.has(cmd)) {
    const flag = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    const body = args[flag + 1] === "--" ? args[flag + 2] : args[flag + 1];
    if (flag >= 0 && body !== undefined) return checkSource(body);
  }
  return null;
}

/** Checks a command line. Unparseable input passes (out of scope; CI backstop). */
function checkSource(src: string): string | null {
  let commands: Command[];
  try {
    commands = parse(src);
  } catch {
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
