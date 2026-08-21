/**
 * The terminal renderer — Text_Renderer.
 *
 * Satisfies Requirement 12 (12.1–12.9), and consumes `render/decimal.ts` for
 * 12.5 and 12.10–12.14.
 *
 * Four labelled sections — transaction metadata, instruction tree, captured log
 * output, account state — separated by exactly one blank line (Req 12.1), with
 * two spaces of indentation per tree level inside the instruction section
 * (Req 12.2).
 *
 * **Deviation, user-directed: Requirement 12.1 fixes three sections and log
 * output is not one of them.** The `LOGS` section is a fourth, added on an
 * explicit request, and it sits between `INSTRUCTIONS` and `ACCOUNTS` so the
 * account table stays the closing reference the reader scrolls back to. Nothing
 * else about 12.1 changes: the sections are still labelled, still ordered, and
 * still separated by exactly one blank line, and no section body contains a blank
 * line — which is why `SECTION_TITLES` is exported and why a test derives the
 * section count from it rather than writing down a number that the next section
 * would falsify. Requirement 21.1's verbatim array is now on screen as well as in
 * the JSON output, which is what the tool exists to explain.
 *
 * ## A sink, and nothing else
 *
 * `renderText` takes an `Analysis` and returns a string. It imports from
 * `model/` (types only) and from `render/decimal.ts`, and from nowhere else in
 * `src/`: not `source/`, not `decode/`, not `resolve/`. It cannot re-fetch, it
 * cannot consult an IDL, and it holds no stream, no clock, and no environment.
 * If it wants a mint's `decimals` the value is in `Analysis` or it is nowhere,
 * and the `known: false` branch of `TokenDecimals` is what makes that a compile
 * error rather than a judgement call — the number is unreachable without first
 * handling its absence, which is then rendered as labelled base units at
 * `partial` confidence (Req 12.13, 12.14).
 *
 * Nothing here mutates the `Analysis`. Every value read is copied into a string;
 * no array is sorted in place, no field is assigned.
 *
 * All fractional formatting and all arithmetic goes through
 * `render/decimal.ts`. There is no `parseFloat`, no `toFixed`, no
 * `toLocaleString`, and no `/` between numbers anywhere below, so the Property 34
 * guard over `src/render/` holds by inspection of two files rather than of the
 * whole tree. SOL exists here and in `decimal.ts` and nowhere else: `Analysis`
 * and the JSON renderer carry raw lamports (Req 7.10, 13.8).
 *
 * ## Two deviations, recorded rather than left as surprises
 *
 * **1. `renderText` returns a result, not a `string`, and writes to no stream.**
 * design.md types the renderer `(analysis: Analysis) => string` and Requirement
 * 12.7 wants a rendering-failure message on stderr, but design.md also declares
 * `cli.ts` the owner of the only `process.stderr` reference in the codebase and
 * `writeDiagnostic` in `exit.ts` the only sanctioned path for a diagnostic. A
 * stream reference here would be a second one, in a renderer, and would make
 * this module untestable without capturing output. `render/json.ts` resolves the
 * identical tension the identical way and `exit.ts` already carries the
 * `render-failure` outcome variant that both feed, so the two renderers are
 * symmetric at the CLI call site: `ok` or a `failure` whose `message` is the
 * `detail`. Requirement 12.7 still holds — the message still names the failure
 * and still reaches stderr — one module later, where it also picks up exit 2.
 *
 * **2. `ColorMode` is a parameter and the decision is a separate pure
 * function.** `picocolors` performs its own environment detection on import, and
 * an implicit environment read would make the output untestable and would let
 * `TERM` change what the golden path prints. `decideColorMode` takes `{ env,
 * isTty }` explicitly, following `config.ts`, which takes `env` rather than
 * reading `process.env`. The palette is then built from that boolean through
 * `picocolors`' `createColors` factory, which is the sanctioned neutralization of
 * its own detection — and when the mode is `off` the palette is built from a
 * local identity function without touching `picocolors` at all, so the
 * "no ESC byte with color off" guarantee rests on this file rather than on a
 * dependency's behaviour.
 *
 * ## Control characters in chain data are escaped, in both modes
 *
 * Program names, account names, IDL type names, and decoded strings all
 * originate off-chain or on-chain and can contain any byte. A raw ESC reaching
 * the terminal would let a program log paint its own `[FAIL]`, forge a color, or
 * reposition the cursor over a line the renderer already wrote — the output would
 * be a claim the tool never made. So every free-form string read off the
 * `Analysis` is passed through `escapeControls`, which renders C0 and DEL as
 * `\xNN` text. The closed enumerations — `messageVersion`, a namespace, an
 * attestation, a lifecycle, a decoder source — are not escaped, because their
 * inhabitants are fixed by the model and none of them contains a control
 * character. This is beyond what
 * Requirement 12 asks for and it is not a data rewrite in the `Analysis` sense:
 * the object is untouched and the JSON renderer still emits the bytes verbatim
 * (escaped per RFC 8259). It is what makes "color off emits no ESC" true for
 * every input rather than for the inputs recorded so far.
 *
 * The log lines are chain data like any other free-form string and go through
 * `escapeControls` too. "Verbatim" in Requirement 21.1 means the renderer does
 * not editorialise — no wrapping, no truncation, no reordering, no renumbering,
 * no re-indenting of the inner text — not that a program's bytes are handed
 * unexamined to a terminal. An unescaped log message is the most direct injection
 * path in the whole output: a bare `\n` fabricates a line Opsis never claimed, a
 * `\r` erases one it did, and an ESC forges a color or a marker.
 *
 * ## What is not rendered
 *
 * Per-line log attribution and CPI failure attribution are Phase 2 upstream, so
 * there is nothing here to place them next to; `logs.unattributed` is empty in v1
 * by deferral and is reported as a count on the `TRANSACTION` row rather than as
 * a second copy of lines the `LOGS` section already prints.
 */

import pc from 'picocolors';

import type {
  AccountEntry,
  AccountOrigin,
  AccountRef,
  AccountRole,
  Analysis,
  ComputeUnits,
  Confidence,
  DecodedField,
  DecodedValue,
  FailureReport,
  InstructionDecode,
  InstructionNode,
  LamportAmount,
  LamportBalanceChange,
  LogReport,
  RawData,
  ResolvedError,
  TokenAmount,
  TokenBalanceChange,
} from '../model/analysis.js';
import { formatLamportsAsSol, formatTokenAmount, groupThousands } from './decimal.js';

// ---------------------------------------------------------------------------
// Color support — Requirements 12.8, 12.9
// ---------------------------------------------------------------------------

/**
 * Whether this render emits ANSI sequences.
 *
 * A two-valued type rather than a `boolean` so a call site reads
 * `renderText(analysis, 'off')` instead of `renderText(analysis, false)`, where
 * `false` could plausibly mean anything.
 */
export type ColorMode = 'on' | 'off';

/** Everything the Requirement 12.8 decision depends on, passed in explicitly. */
export interface ColorEnvironment {
  /** Typically `process.env`, supplied by `cli.ts`. Never read from here. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Typically `process.stdout.isTTY === true`, supplied by `cli.ts`. */
  readonly isTty: boolean;
}

/**
 * `TERM` families that are color-capable when the value carries no explicit
 * `color` or `256` token.
 *
 * Matched against the first `-` or `.` delimited segment, lowercased, so
 * `screen.xterm-256color` and `xterm-kitty` both land on a known family. An
 * explicit list rather than "anything but `dumb`": `TERM` is a terminfo entry
 * name, not a capability string, and treating every unknown name as color-capable
 * would write ESC bytes into whatever is reading — which is the one direction of
 * error this decision should not take. An unlisted terminal loses color and keeps
 * every bit of information, because `[FAIL]`, `[ERROR]`, and the uppercase role
 * labels carry what the color carries (Req 12.6, 12.9). That asymmetry is why the
 * list can be short without being wrong.
 */
export const COLOR_CAPABLE_TERM_FAMILIES: readonly string[] = [
  'alacritty',
  'ansi',
  'cygwin',
  'foot',
  'ghostty',
  'kitty',
  'konsole',
  'linux',
  'putty',
  'rxvt',
  'screen',
  'st',
  'tmux',
  'wezterm',
  'xterm',
];

/**
 * The Requirement 12.8 decision, in order: `NO_COLOR` set → off; stdout not a
 * TTY → off; otherwise on when `COLORTERM` is set or `TERM` indicates a
 * color-capable terminal.
 *
 * Pure, and total. No global is read, so a test states the whole input.
 *
 * **"Set" means two different things for the two variables, on purpose.**
 * `NO_COLOR` is a suppression request, so its mere presence is the request and
 * `NO_COLOR=` (empty) disables color — a departure from no-color.org's
 * "present and not an empty string", taken because a user who exported the
 * variable at all wants no escape sequences, and because turning color off costs
 * a reader nothing. `COLORTERM` is the opposite: an affirmative claim of
 * capability, and an empty value claims nothing, so `COLORTERM=` is not
 * evidence. Both readings err toward off, which is the direction where no
 * information is lost.
 */
export function decideColorMode({ env, isTty }: ColorEnvironment): ColorMode {
  // Order is normative. `NO_COLOR` outranks a TTY and outranks COLORTERM.
  if (env['NO_COLOR'] !== undefined) return 'off';
  if (!isTty) return 'off';

  const colorterm = env['COLORTERM'];
  if (colorterm !== undefined && colorterm !== '') return 'on';

  return indicatesColorCapableTerminal(env['TERM']) ? 'on' : 'off';
}

/**
 * Whether a `TERM` value indicates a color-capable terminal.
 *
 * `toLowerCase` and not `toLocaleLowerCase`: the former is Unicode default case
 * conversion and is invariant under `LANG`, which Requirement 9.7 asks for. The
 * latter would fold `I` differently under a Turkish locale.
 */
function indicatesColorCapableTerminal(term: string | undefined): boolean {
  if (term === undefined || term === '') return false;

  const value = term.toLowerCase();
  // `dumb` is the conventional "no capabilities at all" entry and is excluded
  // before any positive rule can match it.
  if (value === 'dumb') return false;
  if (value.includes('color') || value.includes('256')) return true;

  const family = value.split(/[-.]/, 1)[0] ?? value;
  return COLOR_CAPABLE_TERM_FAMILIES.includes(family);
}

// ---------------------------------------------------------------------------
// The palette — Requirements 12.3, 12.4, 12.6
// ---------------------------------------------------------------------------

/**
 * The four categories Requirement 12.4 requires to be pairwise distinct.
 *
 * Named rather than implicit so the distinctness claim is a statement about a
 * closed set that a test can enumerate, instead of a property of scattered call
 * sites that a fifth color could quietly break.
 */
export type ColorCategory =
  | 'instructionType'
  | 'accountRole'
  | 'errorMessage'
  | 'failingInstruction';

/** Every category, in one place, for exhaustive iteration. */
export const COLOR_CATEGORIES: readonly ColorCategory[] = [
  'instructionType',
  'accountRole',
  'errorMessage',
  'failingInstruction',
];

/** The `picocolors` formatters this module uses. Four names, four categories. */
type ColorName = 'cyan' | 'magenta' | 'red' | 'yellow';

/**
 * Category to color. Four distinct hues, none of them the default foreground,
 * and none of them shared (Req 12.4).
 *
 * Red is the error message because red means error everywhere else a developer
 * looks. The failing instruction is therefore yellow rather than a second red —
 * the two appear on adjacent lines of the same output and 12.4 requires them to
 * be told apart. Cyan and magenta take the two structural categories.
 *
 * Section headings and confidence markers are deliberately *uncolored*. A fifth
 * color would have to be distinct from these four to keep 12.4 legible, and
 * neither carries information that color adds: a heading is already a heading and
 * a marker is already a word.
 */
export const CATEGORY_COLORS: { readonly [K in ColorCategory]: ColorName } = {
  instructionType: 'cyan',
  accountRole: 'magenta',
  errorMessage: 'red',
  failingInstruction: 'yellow',
};

/** Wraps one string. Identity when color is off. */
export type Painter = (text: string) => string;

/** One painter per category. */
export type Palette = { readonly [K in ColorCategory]: Painter };

/** Requirement 12.6: the prefix marking the failing instruction with color off. */
export const FAIL_MARKER = '[FAIL]';

/** Requirement 12.6: the prefix marking an error message with color off. */
export const ERROR_MARKER = '[ERROR]';

/** Color-off role labels are uppercase (Req 12.6). This is that label for a ref. */
const UNRESOLVED_ROLE = 'unresolved';

/**
 * A position no artifact supplied a name for.
 *
 * **Deliberately not `<unresolved …>`.** That word is already taken, by
 * `instructionHeader`, for a program index that could not be resolved to an
 * address — something genuinely failed there. Nothing failed here. Requirement
 * 7.13 says an instruction with no applicable IDL entry keeps every name `null`
 * *while every address stays exactly as it was*, so index resolution succeeded
 * completely and there is simply no IDL to supply a name. Calling that
 * "unresolved" would report a degradation that did not occur, which is the same
 * dishonesty as the blank, pointing the other way. `<unnamed>` states the one
 * thing that is true: this has no name.
 *
 * Emitted identically in both color modes, like the confidence markers and for
 * the same reason: it substitutes for no color, so it is not one of the three
 * Requirement 12.6 text markers.
 */
export const UNNAMED_MARKER = '<unnamed>';

/**
 * A name an artifact did supply, and left empty.
 *
 * A separate marker because it is a separate fact: `UNNAMED_MARKER` means nothing
 * named this position, and this means something named it with zero characters.
 * Collapsing the two would state the first where the second is true.
 *
 * Reachable rather than defensive. `idlStore.ts` validates every name it reads —
 * `instructions[].name`, an instruction's account slot names, `args[].name` — with
 * `typeof name !== 'string'`, which accepts `""`, and `idlDecoder.ts` carries the
 * value through verbatim into `InstructionDecode.name`, `AccountRef.name`, and
 * `DecodedField.name`. So an IDL declaring `"name": ""` produces a `full` decode
 * whose name is the empty string, and before this marker existed it rendered as
 * nothing at all in the most prominent position in the output.
 *
 * The precedent for marking rather than emitting nothing is `decodedValueText`'s
 * `string` case, which quotes its value — an empty decoded string already reads
 * as `""` and was never ambiguous.
 */
export const EMPTY_NAME_MARKER = '<empty name>';

/**
 * A recorded log message of zero length.
 *
 * Reachable: `meta.logMessages` is a JSON array of program-controlled strings and
 * `""` is a legal element, carried into `LogReport.messages` verbatim because the
 * pipeline filters no line (Req 21.1).
 *
 * Printed as a marker rather than as itself, for a layout reason that is also an
 * honesty reason. An empty message indented would be a line of nothing but
 * whitespace, and trimmed it would be a bare empty line — which is the one thing
 * a section body may not contain, because the blank line is what separates the
 * sections (Req 12.1). So an empty message would either corrupt the section
 * structure or vanish, and a vanished line would leave the `LOGS` section holding
 * fewer lines than the count on the `TRANSACTION` row. The marker keeps the line
 * present, keeps it countable, and says what it is.
 */
export const EMPTY_LOG_LINE_MARKER = '<empty log line>';

/**
 * A recorded log message that is entirely whitespace and not empty.
 *
 * A separate fact from `EMPTY_LOG_LINE_MARKER` and so a separate marker, on the
 * `UNNAMED_MARKER`/`EMPTY_NAME_MARKER` precedent: this one has content, the
 * content is just invisible. The character count follows it, because that is the
 * whole of what was recorded and it is not otherwise readable.
 *
 * Tab, CR, LF, and every other C0 control are escaped to visible `\xNN` text
 * before this is consulted, so the only characters that can reach it are spaces
 * and the non-ASCII blanks.
 */
export const BLANK_LOG_LINE_MARKER = '<blank log line>';

function identity(text: string): string {
  return text;
}

/**
 * The palette for one mode.
 *
 * With color off the painters are a local identity function and `picocolors` is
 * never called, so no code path can emit an escape sequence. With color on the
 * painters come from `createColors(true)` — the factory exists precisely so the
 * caller's boolean replaces the library's own environment sniffing, which is what
 * Requirement 12.8 requires of this module and what design.md records as the
 * reason the dependency is acceptable.
 */
export function createPalette(mode: ColorMode): Palette {
  if (mode === 'off') {
    return {
      instructionType: identity,
      accountRole: identity,
      errorMessage: identity,
      failingInstruction: identity,
    };
  }

  const colors = pc.createColors(true);
  return {
    instructionType: (text) => colors[CATEGORY_COLORS.instructionType](text),
    accountRole: (text) => colors[CATEGORY_COLORS.accountRole](text),
    errorMessage: (text) => colors[CATEGORY_COLORS.errorMessage](text),
    failingInstruction: (text) => colors[CATEGORY_COLORS.failingInstruction](text),
  };
}

// ---------------------------------------------------------------------------
// The result — Requirement 12.7
// ---------------------------------------------------------------------------

/**
 * Why a render produced no text, ready to print.
 *
 * `message` is what `writeDiagnostic` receives unchanged and what
 * `ProgramOutcome`'s `render-failure` variant carries as its `detail`, so the
 * CLI needs no formatting logic of its own. `path` locates the offending value
 * when the malformation was found structurally; it is `''` for a failure with no
 * single location.
 */
export interface TextRenderFailure {
  readonly kind: 'text-render-failure';
  /** RFC 6901-style pointer to the offending value. `''` is the document root. */
  readonly path: string;
  readonly reason: string;
  /** Ready to print, and ready to be a `render-failure` `detail`. */
  readonly message: string;
}

export type TextRender =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly failure: TextRenderFailure };

/**
 * Render one `Analysis` for a terminal.
 *
 * Total: this never throws, and it never writes to a stream. No trailing newline
 * — `cli.ts` owns that, as it does for `renderJson`.
 *
 * Deterministic in its two arguments and in nothing else: no clock, no locale, no
 * environment, no `Intl` (Req 9.1, 9.7). Two calls with the same arguments
 * produce the same bytes.
 */
export function renderText(analysis: Analysis, mode: ColorMode): TextRender {
  // Requirement 12.7's "empty or malformed" case, checked before any digits are
  // printed. A structural check first means the diagnostic can name the field
  // rather than quoting whatever `TypeError` the walk happened to raise.
  const malformation = findMalformation(analysis);
  if (malformation !== null) {
    return { ok: false, failure: failureFrom(malformation) };
  }

  try {
    return { ok: true, text: renderSections(analysis, createPalette(mode), mode) };
  } catch (cause) {
    // Reachable from a value that escaped the type: a numeric leaf that is not a
    // decimal integer string makes `decimal.ts` raise `RangeError`, and a
    // non-object where a node belongs makes the walk raise `TypeError`. Both are
    // this failure rather than a throw, because the CLI's response to either is
    // the Req 12.7 message and exit 2, and a renderer that could throw would need
    // that handling duplicated at the call site.
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, failure: failureFrom({ path: '', reason }) };
  }
}

interface Malformation {
  readonly path: string;
  readonly reason: string;
}

function failureFrom({ path, reason }: Malformation): TextRenderFailure {
  const where = path === '' ? 'the document root' : path;
  return {
    kind: 'text-render-failure',
    path,
    reason,
    message: `rendering failure: ${reason} at ${where}`,
  };
}

function isRecord(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The root shape `renderSections` assumes, field by field.
 *
 * A table rather than a chain of `if`s so the diagnostic names the field and the
 * shape it wanted, and so the check is one line per field of `Analysis`. Only the
 * root and the two nested fields the sections read unconditionally are validated:
 * a deeper malformation is caught by the walk, and enumerating the whole model
 * here would be a second copy of `analysis.ts` to keep in step.
 */
const REQUIRED_FIELDS: readonly (readonly [
  path: string,
  ok: (value: unknown) => boolean,
  expected: string,
])[] = [
  ['/signature', (value) => typeof value === 'string', 'a string'],
  [
    '/messageVersion',
    (value) => value === 'legacy' || value === 'v0',
    "'legacy' or 'v0'",
  ],
  ['/outcome', isRecord, 'an object'],
  ['/outcome/succeeded', (value) => typeof value === 'boolean', 'a boolean'],
  ['/accountKeys', Array.isArray, 'an array'],
  ['/instructions', Array.isArray, 'an array'],
  ['/failure', (value) => value === null || isRecord(value), 'an object or null'],
  ['/lamportBalances', Array.isArray, 'an array'],
  ['/tokenBalances', Array.isArray, 'an array'],
  ['/compute', isRecord, 'an object'],
  ['/compute/total', isRecord, 'an object'],
  ['/logs', isRecord, 'an object'],
  ['/logs/messages', Array.isArray, 'an array'],
  // Two rows for one field, because the array-ness and the element type are two
  // different malformations and a reader of the diagnostic wants to know which.
  // The element check earns its place now that the lines are printed: before, a
  // non-string element only ever reached `.length`, and now it would reach
  // `escapeControls` and either throw a `TypeError` or — for an object with a
  // `replace` of its own — put something unaccountable on screen. Either way the
  // Requirement 12.7 failure is the right answer and this is where the table
  // gives it, ahead of any output.
  ['/logs/messages', isArrayOfStrings, 'an array of strings'],
];

function isArrayOfStrings(value: unknown): boolean {
  return Array.isArray(value) && value.every((element: unknown) => typeof element === 'string');
}

/** The value at a `/`-separated pointer, or `undefined` if the path is absent. */
function valueAt(root: unknown, path: string): unknown {
  return path
    .split('/')
    .slice(1)
    .reduce<unknown>((node, step) => {
      if (typeof node !== 'object' || node === null) return undefined;
      return (node as Readonly<Record<string, unknown>>)[step];
    }, root);
}

/** The first structural problem with `value`, or `null` if there is none. */
function findMalformation(value: unknown): Malformation | null {
  if (!isRecord(value)) {
    return { path: '', reason: `the analysis is ${describeShape(value)} rather than an object` };
  }
  if (Object.keys(value as object).length === 0) {
    return { path: '', reason: 'the analysis is empty' };
  }

  for (const [path, ok, expected] of REQUIRED_FIELDS) {
    const field = valueAt(value, path);
    if (!ok(field)) {
      return { path, reason: `expected ${expected}, found ${describeShape(field)}` };
    }
  }
  return null;
}

function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

/** Requirement 12.2: two spaces, one level. */
const INDENT_UNIT = '  ';

/** Column the value of a labelled field starts in, relative to its indent. */
const LABEL_WIDTH = 21;

/** Two spaces between adjacent tokens on one line; one space would read as one token. */
const GAP = '  ';

/**
 * The section headings, in output order, exported so a test names them — and
 * counts them — rather than guessing.
 *
 * `logs` is the user-directed fourth section recorded in the module header. It is
 * declared here between `instructions` and `accounts` because that is where it is
 * emitted, so `Object.values` is the output order and not a second thing to keep
 * in step.
 */
export const SECTION_TITLES = {
  metadata: 'TRANSACTION',
  instructions: 'INSTRUCTIONS',
  logs: 'LOGS',
  accounts: 'ACCOUNTS',
} as const;

function indent(level: number): string {
  return INDENT_UNIT.repeat(level);
}

/** `<indent><label padded><value>`, the shape of every detail line below. */
function field(level: number, label: string, value: string): string {
  return `${indent(level)}${label.padEnd(LABEL_WIDTH)}${value}`;
}

/**
 * C0 controls and DEL as `\xNN` text. See "Control characters" in the header.
 *
 * Applied to every data-derived string. `charCodeAt` is exact for the matched
 * range, which is entirely below U+0080, so no surrogate pair is involved.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

function escapeControls(text: string): string {
  return text.replace(
    CONTROL_CHARACTERS,
    (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}

/**
 * A name read off the `Analysis`, which is never a blank.
 *
 * Every unresolved value in this output carries a visible marker, and a name is
 * not an exception: a `null` name rendered as nothing was indistinguishable from
 * a name that was the empty string, and both were indistinguishable from a line
 * that simply ended. The two absences are distinct facts and get distinct
 * markers — see `UNNAMED_MARKER` and `EMPTY_NAME_MARKER`.
 *
 * Takes `string | null` so the same call site serves an `AccountRef.name`, which
 * is nullable, and an `InstructionDecode.name` or `DecodedField.name`, which are
 * not; the `null` branch is then unreachable for the latter two by type, not by
 * assumption.
 */
function nameToken(name: string | null): string {
  if (name === null) return UNNAMED_MARKER;
  return name === '' ? EMPTY_NAME_MARKER : escapeControls(name);
}

/**
 * A confidence marker, always rendered, never omitted.
 *
 * Lowercase in brackets, which distinguishes it at a glance from the uppercase
 * `[FAIL]` and `[ERROR]` markers those brackets otherwise mean. A `partial` or
 * `raw` marker a reader cannot see would defeat the honest-degradation
 * guarantee, and a marker shown only when it is not `full` would make its absence
 * ambiguous — so `full` is printed too.
 */
function marker(confidence: Confidence): string {
  return `[${confidence}]`;
}

/**
 * A safe integer as digits.
 *
 * `Number.isSafeInteger` is a predicate: it reads the value and returns a
 * boolean, so no numeric value flows through a float operation here. A value
 * outside the safe range, or a non-integer, is a leaf that escaped the model and
 * becomes the Requirement 12.7 failure rather than `1e+21` on screen.
 */
function integerText(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`expected a safe integer, found ${String(value)}`);
  }
  return value.toString();
}

/** An index or order, unseparated: `#3`, never `#1,234`. */
function indexToken(value: number): string {
  return `#${integerText(value)}`;
}

/** Lamports as SOL. The only unit conversion in Opsis (Req 12.5, 12.10). */
function solText(lamports: LamportAmount): string {
  return `${formatLamportsAsSol(lamports)} SOL`;
}

/**
 * A token amount at its mint's scale, or the raw base-unit integer labelled as
 * such (Req 12.11, 12.13, 12.14).
 *
 * The mint is not included: every caller already prints it in a column of its
 * own, and repeating a 44-character address inside the amount would bury it.
 *
 * **The marker is printed for the base-units variant and not for the scaled
 * one.** The scaled variant's confidence is the constant `full` by construction
 * of `FormattedTokenAmount`, and a token balance row carries three amounts, so
 * printing it would put three redundant `[full]` markers on a line that already
 * ends with the row's own marker. The base-units marker is the opposite: it is
 * the `partial` Requirement 12.13 attaches to that specific rendered value, it
 * differs from what the row would otherwise imply, and it is exactly the marker a
 * reader must not miss.
 */
function tokenAmountText(amount: TokenAmount): string {
  const formatted = formatTokenAmount(amount);
  if (formatted.unit === 'baseUnits') {
    // No decimal point and no separators: the digits can be pasted back into a
    // tool that speaks base units.
    return `${formatted.text} ${formatted.label} ${marker(formatted.confidence)}`;
  }
  return formatted.text;
}

/** Compute units as an integer with thousand separators (Req 12.5). */
function computeUnitsText(units: ComputeUnits): string {
  if (!units.available) return `not recorded${GAP}${marker(units.confidence)}`;
  return `${groupThousands(integerText(units.value))}${GAP}${marker(units.confidence)}`;
}

/**
 * A role label: colored with the account-role color, or uppercase with color off
 * (Req 12.4, 12.6).
 *
 * `toUpperCase` and not `toLocaleUpperCase`, for the same reason as
 * `toLowerCase` above: the locale-aware form would change the bytes under
 * `LANG=tr_TR`.
 */
function roleLabel(
  role: AccountRole | typeof UNRESOLVED_ROLE,
  signer: boolean,
  context: Context,
): string {
  const text = signer ? `${role} signer` : role;
  return context.mode === 'off'
    ? text.toUpperCase()
    : context.palette.accountRole(text);
}

function originText(origin: AccountOrigin): string {
  return origin.kind === 'static'
    ? 'static'
    : `lookup table (${origin.loadedFrom})`;
}

/** Everything a line-builder needs beyond the data itself. */
interface Context {
  readonly palette: Palette;
  readonly mode: ColorMode;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Every section, joined by exactly one blank line (Req 12.1).
 *
 * No section body contains an empty line, so `\n\n` occurs exactly once per gap
 * between sections and a reader — or a test — can split on it to recover them.
 * The `LOGS` section is the deviation recorded in the module header; its position
 * here is the one place that decides the order.
 */
function renderSections(analysis: Analysis, palette: Palette, mode: ColorMode): string {
  const context: Context = { palette, mode };
  return [
    metadataSection(analysis, context),
    instructionsSection(analysis, context),
    logsSection(analysis.logs),
    accountsSection(analysis, context),
  ]
    .map((lines) => lines.join('\n'))
    .join('\n\n');
}

// --- metadata --------------------------------------------------------------

function metadataSection(analysis: Analysis, context: Context): readonly string[] {
  const lines: string[] = [SECTION_TITLES.metadata];

  lines.push(field(1, 'signature', escapeControls(analysis.signature)));
  lines.push(field(1, 'version', analysis.messageVersion));
  lines.push(field(1, 'outcome', analysis.outcome.succeeded ? 'succeeded' : 'failed'));

  const error = analysis.outcome.error;
  if (error !== null) {
    lines.push(field(1, 'error', errorText(error, context)));
  }
  if (analysis.failure !== null) {
    lines.push(...failureLines(analysis.failure));
  }

  lines.push(field(1, 'compute units', computeUnitsText(analysis.compute.total)));
  lines.push(field(1, 'logs', logsText(analysis.logs)));
  lines.push(field(1, 'accounts', integerText(analysis.accountKeys.length)));
  lines.push(field(1, 'instructions', integerText(countInstructions(analysis.instructions))));

  return lines;
}

/**
 * An error, prefixed with `[ERROR]` or painted (Req 12.4, 12.6).
 *
 * The three `ResolvedError` variants say different things and are rendered
 * differently on purpose: `unresolved` carries no `message` field at all, by
 * construction of the model, so there is nothing here that could invent one.
 */
function errorText(error: ResolvedError, context: Context): string {
  const body = errorBody(error);
  const painted =
    context.mode === 'off'
      ? `${ERROR_MARKER} ${body}`
      : context.palette.errorMessage(body);
  return `${painted}${GAP}${marker(error.confidence)}`;
}

function errorBody(error: ResolvedError): string {
  switch (error.kind) {
    case 'resolved': {
      const named = `${integerText(error.code)} ${escapeControls(error.name)} (${error.namespace})`;
      const described =
        error.message === null ? named : `${named}: ${escapeControls(error.message)}`;
      return `${described}${GAP}attested by ${error.attestation}`;
    }
    case 'unresolved': {
      const raw = escapeControls(error.rawCode);
      // Both spellings, because `0x1771` is what the RPC said and `6001` is what
      // an IDL would be indexed by, and a reader converting by hand is the whole
      // problem Opsis exists to remove. Shown once when they coincide: `7 (7)`
      // states nothing twice.
      const decimal = error.code === null ? null : integerText(error.code);
      const code = decimal === null || decimal === raw ? raw : `${decimal} (${raw})`;
      return `${code} unresolved: ${error.reason}`;
    }
    case 'non-custom': {
      const variant = escapeControls(error.variant);
      return error.detail === null ? variant : `${variant}: ${escapeControls(error.detail)}`;
    }
  }
}

/**
 * The failure report's location fields.
 *
 * Its `error` is not rendered here: `pipeline.ts` puts the same value on
 * `outcome.error`, which the line above already printed, and printing it twice
 * would read as two errors.
 */
function failureLines(failure: FailureReport): readonly string[] {
  const lines: string[] = [];

  const index =
    failure.failingInstructionIndex === null
      ? 'not reported'
      : indexToken(failure.failingInstructionIndex);
  const range = failure.indexOutOfRange ? `${GAP}(out of range)` : '';
  lines.push(field(1, 'failing instruction', `${index}${range}`));

  const attribution = failure.cpiAttribution;
  if (attribution !== null) {
    lines.push(
      field(
        1,
        'cpi attribution',
        `${indexToken(attribution.instructionOrder)}${GAP}${escapeControls(attribution.programId)}${GAP}${marker(attribution.confidence)}`,
      ),
    );
  }

  return lines;
}

function logsText(logs: LogReport): string {
  if (!logs.present) return `not recorded${GAP}${marker(logs.confidence)}`;
  const truncated = logs.truncated ? `${GAP}(truncated)` : '';
  const unattributed =
    logs.unattributed.length > 0
      ? `${GAP}${integerText(logs.unattributed.length)} unattributed`
      : '';
  return `${integerText(logs.messages.length)} lines${truncated}${unattributed}${GAP}${marker(logs.confidence)}`;
}

function countInstructions(nodes: readonly InstructionNode[]): number {
  let total = 0;
  for (const node of nodes) total += 1 + countInstructions(node.inner);
  return total;
}

// --- instruction tree ------------------------------------------------------

function instructionsSection(analysis: Analysis, context: Context): readonly string[] {
  const lines: string[] = [SECTION_TITLES.instructions];
  if (analysis.instructions.length === 0) {
    lines.push(field(1, 'none', 'the message carried no instruction'));
    return lines;
  }
  for (const node of analysis.instructions) {
    lines.push(...instructionLines(node, context));
  }
  return lines;
}

/**
 * One node and its subtree.
 *
 * The header sits at `indent(depth + 1)` and its details at
 * `indent(depth + 2)`, so a node and its child differ by exactly one two-space
 * level (Req 12.2) at every depth. `node.depth` is read rather than a recursion
 * counter, because `depth` is the field a reader of the `Analysis` sees and the
 * two must not be able to disagree.
 */
function instructionLines(node: InstructionNode, context: Context): readonly string[] {
  const level = node.depth + 1;
  const lines = [instructionHeader(node, level, context)];

  if (node.programId !== null) {
    lines.push(field(level + 1, 'program', escapeControls(node.programId)));
  }
  if (!node.valid) {
    lines.push(
      field(
        level + 1,
        'invalid',
        node.invalidReason === null ? 'the program could not be resolved' : escapeControls(node.invalidReason),
      ),
    );
  }
  lines.push(field(level + 1, 'compute units', computeUnitsText(node.computeUnits)));
  lines.push(...decodeLines(node.decode, level + 1));
  lines.push(...accountRefLines(node.accounts, level + 1, context));

  for (const child of node.inner) {
    lines.push(...instructionLines(child, context));
  }
  return lines;
}

/**
 * `[FAIL] #3 Program  name  decode [full]  subtree [partial]`.
 *
 * With color off the failing instruction takes the `[FAIL]` prefix (Req 12.6);
 * with color on its index token is painted in the failing-instruction color,
 * which is distinct from every other category and therefore from the unpainted
 * index of a non-failing instruction (Req 12.3, 12.4). Only the token is painted,
 * not the whole line: painting the line would nest the instruction-type color
 * inside it and the inner reset would end the outer color early.
 *
 * Two markers, each labelled, because they describe different things. `decode` is
 * this instruction's own decode completeness; `subtree` is the propagated minimum
 * over it and every descendant. A single marker would either hide a `raw` child
 * or misreport a good decode as partial.
 */
function instructionHeader(node: InstructionNode, level: number, context: Context): string {
  const prefix = node.failed && context.mode === 'off' ? `${FAIL_MARKER} ` : '';
  const token = node.failed ? context.palette.failingInstruction(indexToken(node.order)) : indexToken(node.order);

  const program =
    node.programName !== null
      ? escapeControls(node.programName)
      : node.programId !== null
        ? escapeControls(node.programId)
        : '<unresolved program>';

  // Painted even when it is a marker: the instruction-type color is what tells a
  // reader which slot they are looking at in color mode, and leaving the marker
  // as the one unpainted token in that position would lose that. No fifth color
  // is involved, so the Requirement 12.4 argument for uncolored confidence
  // markers does not apply here.
  const name = context.palette.instructionType(nameToken(node.decode.name));

  return `${indent(level)}${prefix}${token} ${program}${GAP}${name}${GAP}decode ${marker(node.decode.confidence)}${GAP}subtree ${marker(node.confidence)}`;
}

function decodeLines(decode: InstructionDecode, level: number): readonly string[] {
  switch (decode.kind) {
    case 'full':
      return [field(level, 'decoder', decode.source), ...fieldLines(decode.fields, level)];
    case 'partial':
      return [
        field(level, 'decoder', decode.source),
        ...fieldLines(decode.decodedFields, level),
        field(level, 'undecoded data', rawDataText(decode.undecodedData)),
      ];
    case 'raw': {
      const lines = [
        field(level, 'note', escapeControls(decode.note)),
        field(level, decode.rawInstructionData.label, rawDataText(decode.rawInstructionData)),
      ];
      if (decode.errorDetail !== null) {
        lines.push(field(level, 'decode error', escapeControls(decode.errorDetail)));
      }
      return lines;
    }
  }
}

function fieldLines(fields: readonly DecodedField[], level: number): readonly string[] {
  // The label is the IDL's `args[].name`, so an empty one would leave the label
  // column blank and the value floating in it with nothing to say why.
  return fields.map((entry) =>
    field(level + 1, nameToken(entry.name), decodedValueText(entry.value)),
  );
}

/**
 * The hex payload and its true byte length.
 *
 * `hex` already carries `... (truncated)` when it was cut short, appended by the
 * decoder (Req 11.6), and `byteLength` is the length before truncation — so
 * "1,024 bytes, here are the first 256" is what a reader sees, rather than a
 * 256-byte payload.
 */
function rawDataText(data: RawData): string {
  return `${escapeControls(data.hex)}${GAP}${groupThousands(integerText(data.byteLength))} bytes`;
}

function decodedValueText(value: DecodedValue): string {
  switch (value.type) {
    case 'bool':
      return value.value ? 'true' : 'false';
    case 'u8':
    case 'u16':
    case 'u32':
    case 'i8':
    case 'i16':
    case 'i32':
      return groupThousands(integerText(value.value));
    case 'u64':
    case 'u128':
    case 'i64':
    case 'i128':
      // A decimal integer string, possibly beyond 2^53. Grouped, never parsed.
      return groupThousands(value.value);
    case 'string':
      // Quoted, so an empty string and a missing one are not the same line.
      return `"${escapeControls(value.value)}"`;
    case 'pubkey':
    case 'bytes':
      return escapeControls(value.value);
    case 'lamports':
      return solText(value.value);
    case 'tokenAmount':
      return `${tokenAmountText(value.value)}${GAP}mint ${escapeControls(value.value.mint)}`;
    case 'unsupported':
      // The IDL named a type this decoder does not implement — a float, for one.
      // Naming it is the honest rendering; there is no value to print.
      return `unsupported IDL type ${escapeControls(value.idlType)}`;
  }
}

function accountRefLines(
  refs: readonly AccountRef[],
  level: number,
  context: Context,
): readonly string[] {
  if (refs.length === 0) return [field(level, 'accounts', 'none')];

  const lines = [`${indent(level)}accounts`];
  for (const ref of refs) {
    if (ref.kind === 'unresolved') {
      lines.push(
        `${indent(level + 1)}${indexToken(ref.index)} ${roleLabel(UNRESOLVED_ROLE, false, context)}${GAP}${escapeControls(ref.reason)}${GAP}${marker(ref.confidence)}`,
      );
      continue;
    }
    // Always a token, never a blank: the name column is present on every row, so
    // an unnamed position reads as unnamed rather than as a row that ended early.
    lines.push(
      `${indent(level + 1)}${indexToken(ref.index)} ${roleLabel(ref.role, ref.signer, context)}${GAP}${escapeControls(ref.address)}${GAP}${nameToken(ref.name)}${GAP}${marker(ref.confidence)}`,
    );
  }
  return lines;
}

// --- captured log output ---------------------------------------------------

/**
 * The recorded log lines, in RPC order (Req 21.1).
 *
 * **The marker is on the heading, not on the lines.** `LogReport.confidence`
 * describes the collection — `full` when present and untruncated, `partial` when
 * truncated, `raw` when the field was absent — and an individual verbatim copy
 * makes no claim that could be partial. A marker on every line would repeat one
 * fact per line and would imply a per-line judgement the model does not carry, so
 * it goes on the container, which is what the container is.
 *
 * No sorting, no grouping, no deduplication, no renumbering, and no line is
 * dropped: `messages[i]` is the `i`-th body line of this section, so the reader
 * can count them against the `TRANSACTION` row's total.
 *
 * `truncated` is not restated here. It is on the `TRANSACTION` row together with
 * the line count and the unattributed count, and it is already visible in this
 * heading as a `[partial]` marker.
 *
 * The three states below are three different facts and read differently on
 * purpose. `present: false` is the recorded absence of the field (Req 21.6) and
 * says so at `raw` — the section appears rather than disappearing, because a
 * silently absent section is indistinguishable from a transaction that genuinely
 * logged nothing, and an absent record and an empty one are exactly what honest
 * degradation must keep apart. `present: true` with no messages is the other one:
 * the field was there and held nothing.
 */
function logsSection(logs: LogReport): readonly string[] {
  const lines: string[] = [`${SECTION_TITLES.logs}${GAP}${marker(logs.confidence)}`];

  if (!logs.present) {
    lines.push(field(1, 'none', 'no log output was recorded for this transaction'));
    return lines;
  }
  if (logs.messages.length === 0) {
    lines.push(field(1, 'none', 'the log was recorded and held no line'));
    return lines;
  }

  for (const message of logs.messages) {
    lines.push(`${indent(1)}${logLineText(message)}`);
  }
  return lines;
}

/**
 * One log message, as one line of body text.
 *
 * Escaped and otherwise untouched. The indent is a prefix and nothing else is
 * added, so a message that begins with spaces — Solana's own CPI logs are indented
 * by the runtime — keeps its own leading whitespace after the two-space section
 * indent, and a message that contains a `\n` becomes the visible text `\x0a` on
 * one line rather than two lines the transaction never emitted.
 *
 * The two blank cases are markers. `escaped === ''` can only come from a message
 * that was already empty, and `escaped.trim() === ''` beyond that can only be
 * spaces and non-ASCII blanks, every control character having become `\xNN` text
 * first — so `escaped.length` in that branch is the recorded message's own length.
 */
function logLineText(message: string): string {
  const escaped = escapeControls(message);
  if (escaped === '') return EMPTY_LOG_LINE_MARKER;
  if (escaped.trim() === '') {
    return `${BLANK_LOG_LINE_MARKER}${GAP}${integerText(escaped.length)} characters`;
  }
  return escaped;
}

// --- account state ---------------------------------------------------------

/**
 * Every account, with its lamport and token balance changes underneath.
 *
 * Iterates the union of indices appearing in `accountKeys`, `lamportBalances`,
 * and `tokenBalances`, ascending. Keying off `accountKeys` alone would silently
 * drop a balance whose index has no entry in the key list — a shape the pipeline
 * does not produce, but one where dropping the row would hide real data rather
 * than report it.
 */
function accountsSection(analysis: Analysis, context: Context): readonly string[] {
  const lines: string[] = [SECTION_TITLES.accounts];

  const entries = new Map<number, AccountEntry>();
  for (const entry of analysis.accountKeys) entries.set(entry.index, entry);

  const lamports = new Map<number, LamportBalanceChange>();
  for (const change of analysis.lamportBalances) lamports.set(change.accountIndex, change);

  const tokens = new Map<number, TokenBalanceChange[]>();
  for (const change of analysis.tokenBalances) {
    const existing = tokens.get(change.accountIndex);
    if (existing === undefined) tokens.set(change.accountIndex, [change]);
    else existing.push(change);
  }

  const indices = [...new Set([...entries.keys(), ...lamports.keys(), ...tokens.keys()])].sort(
    (left, right) => left - right,
  );

  if (indices.length === 0) {
    lines.push(field(1, 'none', 'the message carried no account key'));
    return lines;
  }

  for (const index of indices) {
    const entry = entries.get(index);
    lines.push(
      entry === undefined
        ? `${indent(1)}${indexToken(index)} <not in the account key list>`
        : `${indent(1)}${indexToken(entry.index)} ${roleLabel(entry.role, entry.signer, context)}${GAP}${escapeControls(entry.address)}${GAP}${marker(entry.confidence)}`,
    );

    if (entry !== undefined) {
      // `null` omits the whole labelled row, which is this section's established
      // shape for an absent optional row — as `program`, `invalid`, and `error`
      // are elsewhere — and an absent row is not an ambiguous value. An empty
      // string is: it would pad the label column and end the line in whitespace.
      if (entry.name !== null) lines.push(field(2, 'name', nameToken(entry.name)));
      lines.push(field(2, 'origin', originText(entry.origin)));
      lines.push(field(2, 'referenced by', referencedByText(entry.referencedBy)));
    }

    const change = lamports.get(index);
    if (change !== undefined) lines.push(field(2, 'lamports', lamportChangeText(change)));

    for (const token of tokens.get(index) ?? []) {
      lines.push(field(2, 'token', tokenChangeText(token)));
    }
  }

  return lines;
}

function referencedByText(orders: readonly number[]): string {
  if (orders.length === 0) return 'no instruction';
  return orders.map((order) => indexToken(order)).join(', ');
}

/**
 * A lamport change, in SOL.
 *
 * The `post-only` variant has no `delta` field on the model at all — the pre
 * balance was not recorded, so no difference exists to state — and this renders
 * that absence rather than a zero (Req 7.9).
 */
function lamportChangeText(change: LamportBalanceChange): string {
  if (change.kind === 'post-only') {
    return `post ${solText(change.post)}${GAP}delta not recorded${GAP}${marker(change.confidence)}`;
  }
  return `pre ${solText(change.pre)}${GAP}post ${solText(change.post)}${GAP}delta ${solText(change.delta)}${GAP}${marker(change.confidence)}`;
}

function tokenChangeText(change: TokenBalanceChange): string {
  const pre = change.pre === null ? 'none' : tokenAmountText(change.pre);
  const post = change.post === null ? 'none' : tokenAmountText(change.post);
  return `mint ${escapeControls(change.mint)}${GAP}${change.lifecycle}${GAP}pre ${pre}${GAP}post ${post}${GAP}delta ${tokenAmountText(change.delta)}${GAP}${marker(change.confidence)}`;
}
