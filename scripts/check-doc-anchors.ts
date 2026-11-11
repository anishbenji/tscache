// Fails when a `path#symbol` anchor in the docs site no longer resolves.
//
// The "How it works" pages name the code they describe as an inline-code
// anchor, `packages/tscache/src/<path>.ts#<symbol>`, usually as the text of
// a link to the file on GitHub. An anchor resolves when the file exists and
// declares the symbol. `A.b` names a member `b` of the top-level `A`.
//
// What counts as declaring a name:
//   - a top-level function, class, const, let, var, type, interface or enum,
//     exported or not;
//   - a name in a top-level `export { … }` clause, re-exports included (the
//     package's entries declare their API that way);
//   - a method, property, accessor or enum member of a class, interface,
//     object literal, object type or enum anywhere in the file, and a
//     constructor parameter property.
//
// A link whose text is an anchor must point at that anchor's file on GitHub,
// whether it is an inline link (with or without a title) or a reference link;
// a link form the check cannot read is reported, never treated as bare.
//
// TypeScript 7 ships no JS API, so this reads declarations with a small
// scanner rather than a parser: it blanks comments, strings, template
// literals and regular expressions, then walks the brackets. It cannot see
// names a parser would find through destructuring, a second declarator
// (`const a = 1, b = 2`), `export *`, or JSX text; and a block it takes for
// an object literal (a `case x: {` block) can lend it a false member, which
// only makes the check more lenient.
//
//   bun scripts/check-doc-anchors.ts           checks every page under site/
//   bun scripts/check-doc-anchors.ts <files>   checks those pages

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Where a link to an anchor's file must point: the file on GitHub's main. */
export const BLOB = "https://github.com/anishbenji/tscache/blob/main/";

const ANCHOR =
  /^([\w@.-]+(?:\/[\w@.-]+)*\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs))#([A-Za-z_$][\w$]*(?:\.#?[A-Za-z_$][\w$]*)?)$/;

/**
 * An inline-code span, with the link around it when it is a link's text. The link may carry a title
 * (`"…"`, `'…'` or `(…)`), which is ignored.
 */
const CODE_SPAN =
  /(\[?)`([^`]+)`(\]\(([^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\))?/g;

/** What a link target reads as when the link after an anchor cannot be parsed. */
export const UNREADABLE = "a link the check cannot read";

export interface Anchor {
  file: string;
  line: number;
  path: string;
  symbol: string;
  /** The link target, when the anchor is a link's text. */
  target?: string;
}

export interface Problem {
  file: string;
  line: number;
  anchor: string;
  message: string;
}

/** A reference-link definition, `[label]: destination`, on a line of its own. */
const DEFINITION = /^ {0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?/;

/** A reference label as Markdown matches it: trimmed, inner spaces collapsed, case folded. */
const labelOf = (text: string) =>
  text.trim().replace(/\s+/g, " ").toLowerCase();

/** The page's lines outside fenced code blocks, with their line numbers. */
function proseLines(markdown: string): [number, string][] {
  const lines: [number, string][] = [];
  let fence: string | undefined;
  markdown.split("\n").forEach((text, i) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(text)?.[1];
    if (marker !== undefined) fence = toggleFence(fence, marker);
    else if (fence === undefined) lines.push([i + 1, text]);
  });
  return lines;
}

/** The anchors on one Markdown page, outside fenced code blocks. */
export function findAnchors(file: string, markdown: string): Anchor[] {
  const lines = proseLines(markdown);
  const refs = new Map<string, string>();
  for (const [, text] of lines) {
    const def = DEFINITION.exec(text);
    const name = labelOf(def?.[1] ?? "");
    // The first definition of a label wins, as in CommonMark.
    if (def !== null && !refs.has(name)) refs.set(name, def[2] as string);
  }
  // A definition line is not rendered; its label is checked where a link uses it.
  return lines
    .filter(([, text]) => !DEFINITION.test(text))
    .flatMap(([line, text]) => anchorsOn(file, line, text, refs));
}

/** The open fence after a fence marker line: opened, closed or unchanged. */
function toggleFence(fence: string | undefined, marker: string) {
  if (fence === undefined) return marker;
  const closes = marker[0] === fence[0] && marker.length >= fence.length;
  return closes ? undefined : fence;
}

/** The anchors in one line of text. */
function anchorsOn(
  file: string,
  line: number,
  text: string,
  refs: ReadonlyMap<string, string>,
): Anchor[] {
  return [...text.matchAll(CODE_SPAN)].flatMap((match): Anchor[] => {
    const anchor = ANCHOR.exec(match[2] ?? "");
    if (anchor === null) return [];
    const path = anchor[1] as string;
    const symbol = anchor[2] as string;
    const target = targetOf(match, text, refs);
    return [
      { file, line, path, symbol, ...(target === undefined ? {} : { target }) },
    ];
  });
}

/**
 * The link target of a code span that is a link's whole text, or undefined when it is not a link.
 * Inline links (`[…](url)`, with or without a title) and reference links (`[…][label]`, `[…][]`,
 * and `[…]` with a definition) all resolve to their destination. A form that opens a link but that
 * the check cannot read (`[…](<url>)`, an undefined `[label]`) reads as `UNREADABLE`, never as a
 * bare anchor, so its target is never skipped.
 */
function targetOf(
  match: RegExpExecArray,
  text: string,
  refs: ReadonlyMap<string, string>,
): string | undefined {
  const [whole, open, code, link, target] = match;
  if (open !== "[") return undefined;
  if (link !== undefined) return target ?? UNREADABLE;
  const after = text.slice(match.index + whole.length);
  if (!after.startsWith("]")) return undefined;
  if (after.startsWith("](")) return UNREADABLE;
  return referenceTarget(after, code ?? "", refs);
}

/**
 * The destination of a reference link whose text, the code span `code`, is followed by `after`. A
 * full or collapsed reference is a link even when its label is undefined; a shortcut is one only
 * when defined.
 */
function referenceTarget(
  after: string,
  code: string,
  refs: ReadonlyMap<string, string>,
): string | undefined {
  const reference = /^\]\[([^\]]*)\]/.exec(after);
  const destination = refs.get(labelOf(reference?.[1] || `\`${code}\``));
  return reference === null ? destination : (destination ?? UNREADABLE);
}

/** The names a source file declares, as far as the scanner can see. */
export interface Declarations {
  /** Top-level declarations and the names of top-level export clauses. */
  top: Set<string>;
  /** Every member of every class, interface, object, object type or enum. */
  members: Set<string>;
  /** The members of each top-level declaration that has a body. */
  membersOf: Map<string, Set<string>>;
}

/** Characters that end a value, after which a `/` divides (besides names, numbers and `)`). */
const VALUE_END = new Set(["]", "`", "'", '"', "/"]);
/** Words after which a `/` starts a regular expression although they end in a name character. */
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "void",
  "yield",
  "await",
  "delete",
  "throw",
  "new",
]);
/** Keywords whose parenthesised condition can be followed by a regular expression. */
const CONTROL = new Set(["if", "while", "for", "with"]);
const QUOTES = new Set(["'", '"']);
const WORD = /[\w$]/;

/** One pass over a source, wiping what is not code. */
class Blanker {
  readonly #src: string;
  readonly #out: string[];
  /** The brace depth at each open template interpolation, innermost last. */
  readonly #interpolations: number[] = [];
  #templateStart = 0;
  #depth = 0;
  /** The last code character, its offset, and the word it ends. */
  #prev = "";
  #prevAt = -1;
  #word = "";
  /** For each open `(`, whether it starts a control keyword's condition. */
  readonly #parens: boolean[] = [];
  /** Whether the last code character closed a control keyword's condition. */
  #afterCondition = false;

  constructor(src: string) {
    this.#src = src;
    this.#out = src.split("");
  }

  run(): string {
    let i = 0;
    while (i < this.#src.length) i = this.#step(i);
    return this.#out.join("");
  }

  /** Consumes what starts at `i`; returns where the next thing starts. */
  #step(i: number): number {
    const c = this.#src[i] as string;
    if (c === "/") return this.#slash(i);
    if (c === "`") return this.#template(i);
    if (QUOTES.has(c)) return this.#string(i, c);
    if (c === "}" && this.#interpolations.at(-1) === this.#depth) {
      this.#interpolations.pop();
      return this.#templateText(i + 1);
    }
    this.#code(c, i);
    return i + 1;
  }

  #slash(i: number): number {
    const next = this.#src[i + 1];
    if (next === "/") return this.#wipeTo(i, this.#find("\n", i, 0));
    if (next === "*") return this.#wipeTo(i, this.#find("*/", i + 2, 2));
    if (!this.#divides()) return this.#regex(i);
    this.#code("/", i);
    return i + 1;
  }

  /**
   * Whether a `/` here is a division: only right after a value, that is a name or number (not a
   * keyword such as `return`), a `)` that does not close a control keyword's condition, a `]`, or
   * the end of a string, template or regular expression. Anywhere else it starts a regular
   * expression, so a misread wipes at most the rest of one line instead of leaving a stray brace.
   */
  #divides(): boolean {
    const prev = this.#prev;
    if (WORD.test(prev)) return !REGEX_AFTER_WORD.has(this.#word);
    if (prev === ")") return !this.#afterCondition;
    return VALUE_END.has(prev);
  }

  /** The end of the first `text` at or after `from`, or the source's end. */
  #find(text: string, from: number, length: number): number {
    const at = this.#src.indexOf(text, from);
    return at === -1 ? this.#src.length : at + length;
  }

  #wipe(from: number, to: number): void {
    for (let k = from; k < Math.min(to, this.#src.length); k++) {
      if (this.#out[k] !== "\n") this.#out[k] = " ";
    }
  }

  #wipeTo(from: number, to: number): number {
    this.#wipe(from, to);
    return to;
  }

  /** After a literal: it reads as a value, so a `/` next is a division. */
  #literalEnd(at: number, prev: string): number {
    this.#prev = prev;
    this.#word = "";
    this.#afterCondition = false;
    return at;
  }

  #string(i: number, quote: string): number {
    let j = i + 1;
    while (j < this.#src.length && this.#src[j] !== quote) {
      if (this.#src[j] === "\n") break;
      j += this.#src[j] === "\\" ? 2 : 1;
    }
    this.#wipe(i + 1, j);
    return this.#literalEnd(j + 1, quote);
  }

  #regex(i: number): number {
    const end = this.#regexBody(i + 1);
    this.#wipe(i + 1, end);
    let j = end + 1;
    while (/[a-z]/.test(this.#src[j] ?? "")) j++;
    return this.#literalEnd(j, "/");
  }

  /** Where a regular expression whose body starts at `from` ends. */
  #regexBody(from: number): number {
    let inClass = false;
    for (let j = from; j < this.#src.length; j++) {
      const r = this.#src[j];
      if (r === "\n" || (r === "/" && !inClass)) return j;
      if (r === "\\") j++;
      else if (r === "[" || r === "]") inClass = r === "[";
    }
    return this.#src.length;
  }

  #template(i: number): number {
    if (this.#interpolations.length === 0) this.#templateStart = i;
    return this.#templateText(i + 1);
  }

  /** Scans template text from `from`; returns where code resumes, with the state code resumes in. */
  #templateText(from: number): number {
    let j = from;
    while (j < this.#src.length) {
      const c = this.#src[j];
      if (c === "`") return this.#literalEnd(this.#templateEnd(j + 1), "`");
      if (c === "$" && this.#src[j + 1] === "{") {
        this.#interpolations.push(this.#depth);
        // Code resumes as after an opening brace, where a `/` starts a regular expression.
        return this.#literalEnd(j + 2, "{");
      }
      j += c === "\\" ? 2 : 1;
    }
    return this.#literalEnd(this.#templateEnd(this.#src.length), "`");
  }

  /** Wipes the outermost template once its closing backtick is reached. */
  #templateEnd(at: number): number {
    if (this.#interpolations.length === 0) this.#wipe(this.#templateStart, at);
    return at;
  }

  /** Tracks whether `c` closes a control keyword's condition, after which a `/` starts a regex. */
  #condition(c: string): void {
    if (c === "(") this.#parens.push(CONTROL.has(this.#word));
    this.#afterCondition = c === ")" ? (this.#parens.pop() ?? false) : false;
  }

  #code(c: string, i: number): void {
    if (c === "{") this.#depth++;
    else if (c === "}") this.#depth--;
    if (/\s/.test(c)) return;
    this.#condition(c);
    const joined = this.#prevAt === i - 1 && WORD.test(this.#prev);
    this.#word = WORD.test(c) ? (joined ? this.#word : "") + c : "";
    this.#prev = c;
    this.#prevAt = i;
  }
}

/**
 * The source with comments, string and template contents and regular
 * expressions replaced by spaces, newlines kept, so every offset and line
 * stays where it was. Quote characters stay; template literals, their
 * interpolations included, become spaces entirely.
 */
export function blank(src: string): string {
  return new Blanker(src).run();
}

type Kind = "class" | "object" | "block" | "paren" | "bracket" | "root";

/** A bracket pair of the blanked source, with its own-level text. */
interface Group {
  kind: Kind;
  children: Group[];
  /** Own-level text; each child is one placeholder character. */
  text: string;
}

const BRACE = "\uE000";
const PAREN = "\uE001";
const SQUARE = "\uE002";
const PLACEHOLDER = /[\uE000-\uE002]/;
const CLOSE: Record<string, string> = { "{": "}", "(": ")", "[": "]" };

/** What an opening brace at `at` starts, judged by the text before it. */
function braceKind(code: string, at: number): Kind {
  const head = code.slice(
    Math.max(
      code.lastIndexOf(";", at - 1),
      code.lastIndexOf("{", at - 1),
      code.lastIndexOf("}", at - 1),
    ) + 1,
    at,
  );
  if (/(^|[^\w$.])class\b/.test(head)) return "class";
  if (/(^|[^\w$.])(interface|enum)\s+[\w$]+/.test(head)) return "object";
  if (/^\s*(export|import)(\s+type)?\s*$/.test(head)) return "block";
  const before = head.trimEnd();
  const last = before.at(-1) ?? "";
  if ("=(,:[?|&<".includes(last) && last !== "") {
    return before.endsWith("=>") ? "block" : "object";
  }
  if (/(^|[^\w$])return$/.test(before)) return "object";
  return "block";
}

/** Parses the blanked source into its bracket tree. */
function tree(code: string): Group {
  const root: Group = { kind: "root", children: [], text: "" };
  const stack: Frame[] = [{ group: root, close: "", own: [] }];
  for (let i = 0; i < code.length; i++) {
    const c = code[i] as string;
    const top = stack.at(-1) as Frame;
    if (c in CLOSE) stack.push(open(top, c, () => braceKind(code, i)));
    else if (c === top.close) close(stack);
    else top.own.push(c);
  }
  // Unclosed groups keep what they had.
  while (stack.length > 0) close(stack);
  return root;
}

/** A group being read: its own-level characters so far, and its closer. */
interface Frame {
  group: Group;
  close: string;
  own: string[];
}

const OPENED: Record<string, { placeholder: string; kind?: Kind }> = {
  "{": { placeholder: BRACE },
  "(": { placeholder: PAREN, kind: "paren" },
  "[": { placeholder: SQUARE, kind: "bracket" },
};

/** Opens a child of `top` at the bracket `c`; `brace` judges a brace. */
function open(top: Frame, c: string, brace: () => Kind): Frame {
  const opened = OPENED[c] as { placeholder: string; kind?: Kind };
  const group: Group = { kind: opened.kind ?? brace(), children: [], text: "" };
  top.group.children.push(group);
  top.own.push(opened.placeholder);
  return { group, close: CLOSE[c] as string, own: [] };
}

function close(stack: Frame[]): void {
  const frame = stack.pop() as Frame;
  frame.group.text = frame.own.join("");
}

const TOP_LEVEL =
  /(?:^|[;\s\uE000])(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|const\s+enum|enum|const|let|var|type|interface)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_CLAUSE = /(?:^|[;\s])export\s+(?:type\s+)?\uE000/g;
const MODIFIERS =
  "(?:(?:public|private|protected|readonly|static|async|get|set|override|declare|abstract|accessor)\\s+)*";
const MEMBER = new RegExp(
  `^\\s*(?:@[\\w$.]+\\uE001?\\s+)*${MODIFIERS}\\*?\\s*(#?[A-Za-z_$][\\w$]*)\\s*[?!]?\\s*(?:[(<:=\\uE001]|$)`,
);
const PARAMETER_PROPERTY =
  /^\s*(?:@[\w$.]+\uE001?\s+)*(?:(?:public|private|protected|readonly|override)\s+)+(#?[A-Za-z_$][\w$]*)/;

/** The child a placeholder at `index` of `group.text` stands for. */
function childAt(group: Group, index: number): Group {
  let k = 0;
  for (let i = 0; i < index; i++) {
    if (PLACEHOLDER.test(group.text[i] as string)) k++;
  }
  return group.children[k] as Group;
}

/** The member names of one class, interface, object or enum body. */
function membersIn(group: Group): Set<string> {
  const names = new Set<string>();
  for (const chunk of group.text.split(/[,;\n\uE000]/)) {
    const name = MEMBER.exec(chunk)?.[1];
    if (name !== undefined) names.add(name);
  }
  if (group.kind === "class") {
    const at = /\bconstructor\s*\uE001/.exec(group.text);
    if (at !== null) {
      const params = childAt(group, at.index + at[0].length - 1);
      for (const param of params.text.split(",")) {
        const name = PARAMETER_PROPERTY.exec(param)?.[1];
        if (name !== undefined) names.add(name);
      }
    }
  }
  return names;
}

/** The body a top-level declaration ending at `from` owns, if any. */
function bodyOf(root: Group, from: number): Group | undefined {
  let initializer = false;
  for (let i = from; i < root.text.length; i++) {
    const c = root.text[i] as string;
    if (c === ";") return undefined;
    if (c === "=") initializer = true;
    if (c === BRACE) {
      const body = childAt(root, i);
      return body.kind === "block" ? undefined : body;
    }
    if (c === PAREN && initializer) {
      // `Object.freeze({ … })` and the like: the first object argument.
      return childAt(root, i).children.find((g) => g.kind === "object");
    }
  }
  return undefined;
}

/** Reads the names a TypeScript or JavaScript source declares. */
export function declarations(source: string): Declarations {
  const root = tree(blank(source));
  const top = new Set<string>();
  const membersOf = new Map<string, Set<string>>();
  for (const match of root.text.matchAll(TOP_LEVEL)) {
    const name = match[1] as string;
    top.add(name);
    const body = bodyOf(root, (match.index ?? 0) + match[0].length);
    if (body !== undefined) membersOf.set(name, membersIn(body));
  }
  for (const match of root.text.matchAll(EXPORT_CLAUSE)) {
    const clause = childAt(root, (match.index ?? 0) + match[0].length - 1);
    for (const item of clause.text.split(",")) {
      const words = item
        .trim()
        .split(/\s+/)
        .filter((w) => w !== "type");
      const name = words.at(-1);
      if (name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name)) top.add(name);
    }
  }
  const members = new Set<string>();
  const visit = (group: Group) => {
    if (group.kind === "class" || group.kind === "object") {
      for (const name of membersIn(group)) members.add(name);
    }
    group.children.forEach(visit);
  };
  visit(root);
  return { top, members, membersOf };
}

/** Whether `symbol` (a name, or `Top.member`) is declared. */
export function resolves(decls: Declarations, symbol: string): boolean {
  const [name, member] = symbol.split(".") as [string, string | undefined];
  if (member === undefined) {
    return decls.top.has(name) || decls.members.has(name);
  }
  return decls.membersOf.get(name)?.has(member) ?? false;
}

/** Reads a repository file's text, or undefined when there is no such file. */
export type ReadSource = (path: string) => string | undefined;

/** The problems with one page's anchors. */
export function checkPage(
  file: string,
  markdown: string,
  read: ReadSource,
  cache: Map<string, Declarations | undefined> = new Map(),
): Problem[] {
  const problems: Problem[] = [];
  for (const a of findAnchors(file, markdown)) {
    const anchor = `${a.path}#${a.symbol}`;
    const report = (message: string) =>
      problems.push({ file, line: a.line, anchor, message });
    if (a.target !== undefined && a.target !== BLOB + a.path) {
      report(`the link points to ${a.target}, not ${BLOB}${a.path}`);
    }
    if (!cache.has(a.path)) {
      const text = read(a.path);
      cache.set(a.path, text === undefined ? undefined : declarations(text));
    }
    const decls = cache.get(a.path);
    if (decls === undefined)
      report(`${a.path} is not a file in the repository`);
    else if (!resolves(decls, a.symbol)) {
      report(`${a.path} declares no ${a.symbol}`);
    }
  }
  return problems;
}

/**
 * A reader for files under `root` that Git tracks or would track (`listed`), refusing paths that
 * leave the root. An ignored file, such as a build output, has no page on GitHub, so it does not
 * resolve.
 */
export function repoReader(
  root: string,
  listed: ReadonlySet<string>,
): (path: string) => string | undefined {
  return (path) => {
    const full = resolve(root, path);
    const rel = relative(root, full);
    if (rel.startsWith("..") || !listed.has(rel)) return undefined;
    if (!existsSync(full) || !statSync(full).isFile()) return undefined;
    return readFileSync(full, "utf8");
  };
}

/** The repository's files, tracked or new but not ignored; exits when Git cannot list them. */
function repoFiles(): string[] {
  const listed = Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT },
  );
  if (listed.exitCode !== 0) {
    console.error(
      `doc-anchors: git ls-files failed: ${listed.stderr.toString()}`,
    );
    process.exit(1);
  }
  return listed.stdout
    .toString()
    .split("\n")
    .filter((file) => file !== "" && existsSync(join(ROOT, file)));
}

if (import.meta.main) {
  const files = repoFiles();
  const given = process.argv.slice(2);
  const pages =
    given.length > 0
      ? given
      : files.filter(
          (file) => file.startsWith("site/") && file.endsWith(".md"),
        );
  if (pages.length === 0) {
    console.error("doc-anchors: no pages to check");
    process.exit(1);
  }
  const readRepoFile = repoReader(ROOT, new Set(files));
  const cache = new Map<string, Declarations | undefined>();
  let count = 0;
  const problems = pages.flatMap((page) => {
    const text = readFileSync(resolve(ROOT, page), "utf8");
    count += findAnchors(page, text).length;
    return checkPage(page, text, readRepoFile, cache);
  });
  for (const p of problems) {
    console.error(`${p.file}:${p.line}: ${p.anchor}: ${p.message}`);
  }
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} anchor problem(s). Point each anchor at a file and symbol that exist.`,
    );
    process.exit(1);
  }
  console.log(`doc-anchors: ${count} anchors in ${pages.length} pages resolve`);
}
