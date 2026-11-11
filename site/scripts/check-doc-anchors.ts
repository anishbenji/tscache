// Fails when a `path#symbol` anchor in the docs site no longer resolves.
//
// The "How it works" pages name the code they describe as an inline-code
// anchor, `packages/tscache/src/<path>.ts#<symbol>`, usually as the text of
// a link to the file on GitHub. An anchor resolves when the file exists and
// declares the symbol. `A.b` names a member `b` of the top-level `A`.
//
// Both readers are real parsers, already dependencies of the site:
//   - Pages are parsed by VitePress's own Markdown renderer, so a link reads
//     exactly as the site renders it: references, titles and every link form
//     resolve to the `href` the page shows. An anchor in a link must be the
//     link's whole text, and the link must point at the anchor's file on
//     GitHub. The check does not model HTML: after a raw `<a` anywhere on a
//     page (a tag, an attribute, a comment or a script string), every later
//     anchor on the page is reported, since its link cannot be trusted. A
//     token shaped like an anchor whose symbol is not a name or `Top.member`
//     is reported. Container titles (`::: tip <title>`) are read as the
//     inline Markdown VitePress renders them as. Fenced code, includes and
//     HTML blocks hold no inline code token, so they hold no anchor.
//   - Sources are parsed by TypeScript 6's compiler API (the site's TypeDoc
//     pins it; TypeScript 7 has no JS API). A symbol resolves when the file
//     declares it at top level (a function, class, variable, type,
//     interface, enum or namespace, or a name in an `export { … }` clause).
//     A member is named `Top.member` and resolves against `Top`'s own body
//     only; a bare name never resolves to a member.
//
//   bun site/scripts/check-doc-anchors.ts           checks every page under site/
//   bun site/scripts/check-doc-anchors.ts <files>   checks those pages

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createMarkdownRenderer, type MarkdownRenderer } from "vitepress";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Where a link to an anchor's file must point: the file on GitHub's main. */
export const BLOB = "https://github.com/anishbenji/tscache/blob/main/";

const ANCHOR =
  /^([\w@.-]+(?:\/[\w@.-]+)*\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs))#([A-Za-z_$][\w$]*(?:\.#?[A-Za-z_$][\w$]*)?)$/;

/** What a link target reads as when the anchor is only part of a link's text. */
export const PART_OF_TEXT = "a link whose text holds more than the anchor";

/** What a link target reads as when a raw HTML `<a` comes before the anchor on its page. */
export const HTML_LINK = "an HTML link";

/** An inline code token shaped like an anchor's start, a code file and `#`, whatever follows. */
const ANCHOR_LIKE =
  /^([\w@.-]+(?:\/[\w@.-]+)*\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs))#(.*)$/;

export interface Anchor {
  file: string;
  line: number;
  path: string;
  symbol: string;
  /** The link's `href` when the anchor is a link's whole text, or `PART_OF_TEXT` or `HTML_LINK`. */
  target?: string;
  /** Set when the token looks like an anchor but its symbol is not a name or `Top.member`. */
  malformed?: true;
}

export interface Problem {
  file: string;
  line: number;
  anchor: string;
  message: string;
}

/** Finds the anchors on one Markdown page. */
export type FindAnchors = (file: string, markdown: string) => Anchor[];

type Token = ReturnType<MarkdownRenderer["parse"]>[number];

const newlines = (text: string) => text.split("\n").length - 1;

/**
 * A reader of pages built on VitePress's Markdown renderer, with its default options: the site's
 * config adds a rule that fails the build on a link to a missing repository file and Mermaid's
 * fences, neither of which changes how a page parses.
 */
export async function anchorReader(): Promise<FindAnchors> {
  const md = await createMarkdownRenderer(join(ROOT, "site"));
  const lines = noteCodeLines(md);
  return (file, markdown) => {
    const env: { content?: string } = {};
    const tokens = md.parse(markdown, env);
    const first = firstLine(markdown, env.content);
    // A raw HTML `<a` anywhere on the page (an HTML block can wrap paragraphs) makes every later
    // anchor on the page unreadable; see `htmlLinks`.
    const html = { open: 0 };
    return tokens.flatMap((block, i) => {
      const line = first + lineOf(tokens, i);
      if (block.type === "html_block") htmlLinks(block.content, html);
      if (block.type === "inline") {
        return anchorsIn(file, block, line, lines, html);
      }
      // A container's title (`::: tip <title>`) is rendered as inline Markdown from its `info`.
      const title = containerTitle(block);
      if (title === undefined) return [];
      return md
        .parseInline(title, env)
        .flatMap((inline) => anchorsIn(file, inline, line, lines, html));
    });
  };
}

/** The title of a custom container's opening token (`::: tip <title>`), if it has one. */
function containerTitle(block: Token): string | undefined {
  if (!/^container_.+_open$/.test(block.type)) return undefined;
  const title = block.info.trim().replace(/^\S+\s*/, "");
  return title === "" ? undefined : title;
}

/**
 * Notes, for each inline code token the renderer creates, how many lines into its block's text it
 * starts. Markdown-it puts lines on blocks only; the inline parser's offset into the block's text
 * when it pushes the token is where the opening backtick is.
 */
function noteCodeLines(md: MarkdownRenderer): WeakMap<Token, number> {
  const lines = new WeakMap<Token, number>();
  const Base = md.inline.State;
  md.inline.State = class extends Base {
    override push(...args: Parameters<InstanceType<typeof Base>["push"]>) {
      const token = super.push(...args);
      if (token.type === "code_inline") {
        lines.set(token, newlines(this.src.slice(0, this.pos)));
      }
      return token;
    }
  };
  return lines;
}

/**
 * The 1-based line of the page where the parsed text starts. VitePress strips the frontmatter
 * before parsing and leaves the rest of the page as `content`.
 */
function firstLine(markdown: string, content = markdown): number {
  if (!markdown.endsWith(content)) {
    throw new Error("doc-anchors: the frontmatter is not a prefix of the page");
  }
  return 1 + newlines(markdown.slice(0, markdown.length - content.length));
}

/** The 0-based line of the block an inline token at `index` belongs to. */
function lineOf(tokens: Token[], index: number): number {
  for (let i = index; i >= 0; i--) {
    const map = tokens[i]?.map;
    if (map) return map[0];
  }
  return 0;
}

/** The anchors in one block's inline tokens, the first of whose lines is `line`. */
function anchorsIn(
  file: string,
  block: Token,
  line: number,
  lines: WeakMap<Token, number>,
  html: { open: number },
): Anchor[] {
  const children = block.children ?? [];
  const links: number[] = [];
  const anchors: Anchor[] = [];
  children.forEach((token, i) => {
    if (token.type === "link_open") links.push(i);
    else if (token.type === "link_close") links.pop();
    else if (token.type === "html_inline") htmlLinks(token.content, html);
    const like =
      token.type === "code_inline" ? ANCHOR_LIKE.exec(token.content) : null;
    if (like === null) return;
    const target =
      html.open > 0 ? HTML_LINK : targetOf(children, links.at(-1), i);
    anchors.push({
      file,
      line: line + (lines.get(token) ?? 0),
      path: like[1] as string,
      symbol: like[2] as string,
      ...(target === undefined ? {} : { target }),
      ...(ANCHOR.test(token.content) ? {} : { malformed: true }),
    });
  });
  return anchors;
}

/**
 * Notes a raw HTML `<a` anywhere in `html` (a tag, an attribute, a comment or a script alike). The
 * check does not model HTML: once a page holds one, no later anchor's link can be trusted, so every
 * later anchor on the page is reported, and nothing closes it. No page writes a raw `<a>` today.
 */
function htmlLinks(html: string, page: { open: number }): void {
  if (/<a[\s>/]/i.test(html)) page.open = 1;
}

/**
 * The target of the link that opens at `open` around the code token at `at`: its `href` when the
 * token is the link's whole text, `PART_OF_TEXT` when the text holds more.
 */
function targetOf(
  children: Token[],
  open: number | undefined,
  at: number,
): string | undefined {
  if (open === undefined) return undefined;
  const whole = open === at - 1 && children[at + 1]?.type === "link_close";
  return whole ? (children[open]?.attrGet("href") ?? "") : PART_OF_TEXT;
}

/** The names a source file declares. */
export interface Declarations {
  /** Top-level declarations and the names of top-level export clauses. */
  top: Set<string>;
  /** The members of each top-level declaration that has a body. */
  membersOf: Map<string, Set<string>>;
}

/** A member's name, when it is written as a name, a `#private` name or a literal. */
function nameOf(node: ts.Declaration): string | undefined {
  const name = ts.getNameOfDeclaration(node);
  if (name === undefined) return undefined;
  const plain =
    ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name);
  return plain ? name.text : undefined;
}

const namesOf = (nodes: readonly ts.Declaration[]) =>
  nodes.flatMap((node) => nameOf(node) ?? []);

/** A class body's members, constructor parameter properties included. */
function classMembers(node: ts.ClassLikeDeclaration): string[] {
  return node.members.flatMap((member) =>
    ts.isConstructorDeclaration(member)
      ? namesOf(
          member.parameters.filter((p) =>
            ts.isParameterPropertyDeclaration(p, member),
          ),
        )
      : namesOf([member]),
  );
}

/** The members of a node with a body of members, or undefined when it has none. */
function membersOfNode(node: ts.Node): string[] | undefined {
  if (ts.isClassLike(node)) return classMembers(node);
  if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
    return namesOf(node.members);
  }
  if (ts.isEnumDeclaration(node)) return namesOf(node.members);
  if (ts.isObjectLiteralExpression(node)) return namesOf(node.properties);
  return undefined;
}

/** An expression seen through parentheses, `as`, `satisfies`, `<T>` and `!`. */
function unwrap(node: ts.Expression): ts.Expression {
  const outer =
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node);
  return outer ? unwrap(node.expression) : node;
}

/** Whether `node` is `Object.freeze(…)`, which returns the object it is given. */
function isFreeze(node: ts.Expression): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Object" &&
    callee.name.text === "freeze"
  );
}

/**
 * The members of what initialises a variable: an object literal or class expression, or one
 * passed to `Object.freeze`.
 */
function initializerMembers(init: ts.Expression | undefined): string[] {
  if (init === undefined) return [];
  let node = unwrap(init);
  const frozen = isFreeze(node) ? node.arguments[0] : undefined;
  if (frozen !== undefined) node = unwrap(frozen);
  return ts.isObjectLiteralExpression(node) || ts.isClassExpression(node)
    ? (membersOfNode(node) ?? [])
    : [];
}

/** The names a binding declares: a name, or every name a destructuring pattern binds. */
function bound(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bound(element.name),
  );
}

type Declare = (name: string, members?: readonly string[]) => void;

/** Declares the names one top-level statement declares, with their bodies' members. */
function declareStatement(statement: ts.Statement, declare: Declare): void {
  if (ts.isVariableStatement(statement)) {
    for (const d of statement.declarationList.declarations) {
      const members = ts.isIdentifier(d.name)
        ? initializerMembers(d.initializer)
        : [];
      for (const name of bound(d.name)) declare(name, members);
    }
  } else if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause;
    if (clause !== undefined && ts.isNamedExports(clause)) {
      for (const element of clause.elements) declare(element.name.text);
    } else if (clause !== undefined) declare(clause.name.text);
  } else if (ts.isModuleDeclaration(statement)) {
    const global = statement.flags & ts.NodeFlags.GlobalAugmentation;
    if (ts.isIdentifier(statement.name) && !global) {
      declare(statement.name.text, namespaceNames(statement.body));
    }
  } else if (isNamedDeclaration(statement)) {
    // `type T = { … }` owns the object type's members.
    const body = ts.isTypeAliasDeclaration(statement)
      ? statement.type
      : statement;
    declare(statement.name.text, membersOfNode(body));
  }
}

function isNamedDeclaration(
  node: ts.Statement,
): node is ts.DeclarationStatement & { name: ts.Identifier } {
  const kind =
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node);
  return kind && node.name !== undefined && ts.isIdentifier(node.name);
}

/** The names a namespace's body declares: `namespace A.B {}` gives `A` the member `B`. */
function namespaceNames(body: ts.ModuleBody | undefined): string[] {
  if (body === undefined) return [];
  if (ts.isModuleDeclaration(body)) return [body.name.text];
  if (!ts.isModuleBlock(body)) return [];
  const names: string[] = [];
  for (const statement of body.statements) {
    declareStatement(statement, (name) => names.push(name));
  }
  return names;
}

/**
 * Reads the names a TypeScript or JavaScript source declares. `path` picks the parser's dialect
 * by its extension, as TypeScript does: `.tsx` and `.jsx` parse JSX.
 */
export function declarations(source: string, path = "source.ts"): Declarations {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest);
  const top = new Set<string>();
  const membersOf = new Map<string, Set<string>>();
  for (const statement of file.statements) {
    declareStatement(statement, (name, members) => {
      top.add(name);
      if (members === undefined) return;
      const own = membersOf.get(name) ?? new Set();
      for (const member of members) own.add(member);
      membersOf.set(name, own);
    });
  }
  return { top, membersOf };
}

/** Whether `symbol` (a name, or `Top.member`) is declared. */
export function resolves(decls: Declarations, symbol: string): boolean {
  const [name, member] = symbol.split(".") as [string, string | undefined];
  if (member === undefined) return decls.top.has(name);
  return decls.membersOf.get(name)?.has(member) ?? false;
}

/** Reads a repository file's text, or undefined when there is no such file. */
export type ReadSource = (path: string) => string | undefined;

/** The problems with a page's anchors. */
export function checkAnchors(
  anchors: readonly Anchor[],
  read: ReadSource,
  cache: Map<string, Declarations | undefined> = new Map(),
): Problem[] {
  const problems: Problem[] = [];
  for (const a of anchors) {
    const anchor = `${a.path}#${a.symbol}`;
    const report = (message: string) =>
      problems.push({ file: a.file, line: a.line, anchor, message });
    if (a.malformed) {
      report("not a checkable anchor: name a symbol as `name` or `Top.member`");
      continue;
    }
    if (a.target !== undefined && a.target !== BLOB + a.path)
      report(linkProblem(a));
    if (!cache.has(a.path)) {
      const text = read(a.path);
      cache.set(
        a.path,
        text === undefined ? undefined : declarations(text, a.path),
      );
    }
    const decls = cache.get(a.path);
    if (decls === undefined)
      report(`${a.path} is not a file in the repository`);
    else if (!resolves(decls, a.symbol))
      report(`${a.path} declares no ${a.symbol}`);
  }
  return problems;
}

/** What is wrong with the link around an anchor whose target is not the anchor's file. */
function linkProblem(a: Anchor): string {
  if (a.target === PART_OF_TEXT) {
    return "an anchor in a link must be the link's whole text, so its target can be checked";
  }
  if (a.target === HTML_LINK) {
    return "an anchor after a raw HTML <a> on its page cannot be checked; write links in Markdown";
  }
  return `the link points to ${a.target}, not ${BLOB}${a.path}`;
}

/**
 * A reader for files under `root` that Git tracks or would track (`listed`), refusing paths that
 * leave the root. An ignored file, such as a build output, has no page on GitHub, so it does not
 * resolve.
 */
export function repoReader(
  root: string,
  listed: ReadonlySet<string>,
): ReadSource {
  return (path) => {
    const full = resolve(root, path);
    const rel = relative(root, full);
    if (rel.startsWith("..") || !listed.has(rel)) return undefined;
    if (!existsSync(full) || !statSync(full).isFile()) return undefined;
    return readFileSync(full, "utf8");
  };
}

/** What `git ls-files` printed, and its exit code. */
export interface Listing {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Lists the repository's files, tracked or new but not ignored. */
function gitLsFiles(): Listing {
  const listed = Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT },
  );
  return {
    exitCode: listed.exitCode,
    stdout: listed.stdout.toString(),
    stderr: listed.stderr.toString(),
  };
}

/**
 * Checks the `given` pages, or every page Git lists under `site/`, and returns the exit code: 1
 * when an anchor does not resolve, when Git cannot list the files, or when there is no page.
 */
export async function run(
  given: readonly string[],
  list: () => Listing = gitLsFiles,
): Promise<number> {
  const listed = list();
  if (listed.exitCode !== 0) {
    console.error(`doc-anchors: git ls-files failed: ${listed.stderr}`);
    return 1;
  }
  const files = listed.stdout
    .split("\n")
    .filter((file) => file !== "" && existsSync(join(ROOT, file)));
  const pages =
    given.length > 0
      ? given
      : files.filter((f) => f.startsWith("site/") && f.endsWith(".md"));
  if (pages.length === 0) {
    console.error("doc-anchors: no pages to check");
    return 1;
  }
  const find = await anchorReader();
  const read = repoReader(ROOT, new Set(files));
  const cache = new Map<string, Declarations | undefined>();
  let count = 0;
  const problems = pages.flatMap((page) => {
    const anchors = find(page, readFileSync(resolve(ROOT, page), "utf8"));
    count += anchors.length;
    return checkAnchors(anchors, read, cache);
  });
  for (const p of problems) {
    console.error(`${p.file}:${p.line}: ${p.anchor}: ${p.message}`);
  }
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} anchor problem(s). Point each anchor at a file and symbol that exist.`,
    );
    return 1;
  }
  console.log(`doc-anchors: ${count} anchors in ${pages.length} pages resolve`);
  return 0;
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
