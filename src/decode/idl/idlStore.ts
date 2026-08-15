/**
 * Anchor IDL loading — the only filesystem read in `decode/`.
 *
 * Satisfies Requirements 18.1–18.4, 9.6, 22.5.
 *
 * `--idl-dir` is accepted by `cli.ts` and arrives here through
 * `ResolvedConfig.idlDir` (Req 18.1). Every `*.json` file in that directory is
 * loaded (Req 18.2) and indexed by `metadata.address` (Req 18.3). Downstream,
 * `decode/registry.ts` asks this store for the program's IDL before trying a
 * built-in decoder, and `resolve/errorResolver.ts` reads the `errors` array off
 * it, which is why `instructions`, `errors`, and `accounts` are all surfaced in
 * a typed shape rather than left as parsed JSON.
 *
 * Three properties hold this module together.
 *
 * - **One bad IDL never fails the run** (Req 18.4). Every failure — an
 *   unreadable directory, an unreadable file, invalid JSON, a missing required
 *   field — is a warning value, and loading continues with the next file.
 *   Aborting would let a single unparseable file block analysis of every other
 *   program in the transaction, which is the opposite of useful when the reason
 *   the user reached for `--idl-dir` is that one specific program.
 * - **Nothing here depends on file system enumeration order** (Req 9.6). Names
 *   are sorted before any file is opened, and files are then read in that
 *   order, so the store's contents *and* the warning sequence are identical
 *   across runs and across platforms. The sort is a code-unit comparison, never
 *   `localeCompare`, because a locale-sensitive sort would make the output
 *   depend on `LANG` and break Requirement 9.7.
 * - **No Anchor runtime dependency.** The IDL is read structurally by the
 *   validator below. Only `instructions`, `errors`, `accounts`, and
 *   `metadata.address` are needed, and pulling in the Anchor client to reach
 *   four fields would add a large dependency whose version would then have to
 *   track the IDLs users happen to have on disk.
 *
 * **Deviation from tasks.md, agreed with the user and recorded here so it reads
 * as a decision rather than an omission.** tasks.md and design.md both say the
 * warning is written to stderr. It is not written here: warnings are returned
 * on the store as a readonly `IdlWarning[]`, and `cli.ts` writes them through
 * `writeDiagnostic`. design.md declares `cli.ts` the owner of the only
 * `process.stderr` reference in the codebase, so emitting from this module would
 * put a second stream reference inside `decode/` and make this module untestable
 * without capturing a stream. Requirement 18.4 and Requirement 22.5 are still
 * satisfied — the warning still names the path and the reason, and it still
 * reaches stderr — one module later.
 */

import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

import type { Base58Address } from '../../model/analysis.js';

// ---------------------------------------------------------------------------
// The loaded IDL shape
// ---------------------------------------------------------------------------

/**
 * A declared type, exactly as it appeared in the JSON.
 *
 * Left as `unknown` on purpose. An Anchor type is a string (`"u64"`) or an
 * object (`{ "vec": "u8" }`, `{ "option": "u64" }`, `{ "defined": "Foo" }`,
 * `{ "array": ["u8", 32] }`), and interpreting it is the instruction decoder's
 * job (task 6.5), not the loader's. Modelling the recursion here would commit
 * this module to a type grammar it never reads, and every value it rejected
 * would be an IDL this module refused to load for a field it does not need.
 */
export type IdlTypeNode = unknown;

/** One named argument of an instruction, or one field of an account struct. */
export interface IdlField {
  readonly name: string;
  readonly type: IdlTypeNode;
}

/**
 * One account slot declared by an instruction.
 *
 * The `group` variant is Anchor's composite-accounts form, where a nested
 * `accounts` array stands in for a reusable account struct. It is preserved
 * rather than flattened because flattening is what positional mapping onto
 * `AccountRef` needs (task 6.5), and doing it here would discard the grouping
 * without the decoder ever having seen it.
 */
export type IdlInstructionAccount =
  | { readonly kind: 'account'; readonly name: string }
  | {
      readonly kind: 'group';
      readonly name: string;
      readonly accounts: readonly IdlInstructionAccount[];
    };

export interface IdlInstruction {
  readonly name: string;
  readonly accounts: readonly IdlInstructionAccount[];
  readonly args: readonly IdlField[];
}

/**
 * One entry of the IDL `errors` array, which is where `resolveError` looks for
 * a user-defined code of 6000 or above (Req 6.1).
 *
 * `msg` is nullable because the field is genuinely optional in the format. A
 * missing message stays `null` rather than becoming the error name or an empty
 * string: inventing a plausible message is exactly the guessing the product
 * forbids.
 */
export interface IdlErrorCode {
  readonly code: number;
  readonly name: string;
  readonly msg: string | null;
}

/** One account type declared by the IDL. */
export interface IdlAccountDef {
  readonly name: string;
  readonly type: IdlTypeNode;
}

/**
 * One successfully loaded IDL.
 *
 * `path` is carried so a later diagnostic can name the file an IDL-sourced
 * decode came from, and `errors` and `accounts` are always arrays — an IDL that
 * declares neither reads as empty, so no consumer needs an optional-field
 * branch to ask what a program's errors are.
 */
export interface LoadedIdl {
  /** Absolute or caller-relative path the IDL was read from. */
  readonly path: string;
  readonly version: string;
  readonly name: string;
  /** From `metadata.address` (Req 18.3). The key this IDL is indexed under. */
  readonly address: Base58Address;
  readonly instructions: readonly IdlInstruction[];
  /** Empty when the IDL declares no errors. */
  readonly errors: readonly IdlErrorCode[];
  /** Empty when the IDL declares no accounts. */
  readonly accounts: readonly IdlAccountDef[];
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/**
 * Why one path did not become a `LoadedIdl`.
 *
 * `kind` exists so a caller can tell the three cases apart without parsing
 * `reason` text; `cli.ts` needs only `path` and `reason` to satisfy Requirement
 * 18.4, and gets them from every variant.
 *
 * - `directory-unreadable` — `path` is the directory, not a file. The run
 *   continues with an empty store.
 * - `file-invalid` — unreadable file, invalid JSON, or a missing or malformed
 *   required field.
 * - `duplicate-address` — a second file claimed an address a previous file had
 *   already registered. Indexing by address needs a defined collision rule, and
 *   silently overwriting would make which IDL won depend on nothing the user can
 *   see.
 */
export interface IdlWarning {
  readonly kind: 'directory-unreadable' | 'file-invalid' | 'duplicate-address';
  readonly path: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface IdlStore {
  /** The IDL registered for a program ID, or `undefined` when none was loaded. */
  get(programId: Base58Address): LoadedIdl | undefined;
  /**
   * Every path that did not load, in sorted-filename order (Req 9.6, 18.4).
   * Written to stderr by `cli.ts` — see the deviation note at the top of this
   * file.
   */
  readonly warnings: readonly IdlWarning[];
  /**
   * Program IDs with a loaded IDL, ascending by code unit.
   *
   * Not in design.md's block. It is here because "which programs do we have an
   * IDL for" is otherwise unanswerable without already knowing the answer, and
   * a sorted list keeps any future diagnostic that enumerates the store
   * deterministic for free.
   */
  readonly programIds: readonly Base58Address[];
}

/**
 * Load every `*.json` file in `dir` (Req 18.2).
 *
 * Never throws and never writes to a stream. A missing or unreadable directory
 * is a warning and an empty store, not a failure: `--idl-dir` pointing at a
 * typo should degrade decoding, not end the run.
 */
export async function loadIdlDirectory(dir: string): Promise<IdlStore> {
  const warnings: IdlWarning[] = [];
  const byAddress = new Map<Base58Address, LoadedIdl>();

  let names: readonly string[];
  try {
    names = await listJsonFiles(dir);
  } catch (cause) {
    warnings.push({
      kind: 'directory-unreadable',
      path: dir,
      reason: `the IDL directory could not be read: ${messageOf(cause)}`,
    });
    return createStore(byAddress, warnings);
  }

  // Sequential, in sorted order. Reading in parallel would finish sooner and
  // would let completion order decide the warning order, which is the
  // enumeration-order dependency Requirement 9.6 rules out. An IDL directory
  // holds a handful of files, so the serial read costs nothing worth having.
  for (const name of names) {
    const path = join(dir, name);
    const parsed = await loadIdlFile(path);

    if (!parsed.ok) {
      warnings.push({ kind: 'file-invalid', path, reason: parsed.reason });
      continue;
    }

    const existing = byAddress.get(parsed.idl.address);
    if (existing !== undefined) {
      warnings.push({
        kind: 'duplicate-address',
        path,
        reason: `metadata.address ${parsed.idl.address} was already loaded from ${existing.path}, so this file was ignored`,
      });
      continue;
    }

    byAddress.set(parsed.idl.address, parsed.idl);
  }

  return createStore(byAddress, warnings);
}

function createStore(
  byAddress: ReadonlyMap<Base58Address, LoadedIdl>,
  warnings: readonly IdlWarning[],
): IdlStore {
  const programIds = [...byAddress.keys()].sort(byCodeUnit);

  return {
    get: (programId) => byAddress.get(programId),
    warnings,
    programIds,
  };
}

// ---------------------------------------------------------------------------
// Directory listing
// ---------------------------------------------------------------------------

/**
 * The `*.json` entries of `dir`, sorted (Req 9.6).
 *
 * Throws only when the directory itself cannot be listed; the caller turns that
 * into the one `directory-unreadable` warning.
 *
 * A directory named `something.json` is skipped rather than attempted: it is
 * plainly not an IDL file, and reading it would produce an `EISDIR` warning
 * that tells the user nothing they did not already know. Symlinks are followed,
 * since `readFile` resolves them and a symlinked IDL is a reasonable thing to
 * have. The extension test is case-sensitive `.json`, so the set of files loaded
 * does not change between a case-sensitive and a case-insensitive filesystem.
 */
async function listJsonFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });

  return entries
    .filter((entry) => !entry.isDirectory() && extname(entry.name) === '.json')
    .map((entry) => entry.name)
    .sort(byCodeUnit);
}

/**
 * Code-unit ordering. Deliberately not `localeCompare`, which is
 * locale-sensitive and would make warning order depend on `LANG` (Req 9.7).
 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// One file
// ---------------------------------------------------------------------------

type IdlParse =
  | { readonly ok: true; readonly idl: LoadedIdl }
  | { readonly ok: false; readonly reason: string };

/**
 * Strict UTF-8, for the same reason `source/fixture.ts` uses it: the lenient
 * decoder substitutes U+FFFD for invalid bytes, so a corrupt file can parse as
 * well-formed JSON with silently mangled names.
 */
const UTF8 = new TextDecoder('utf-8', { fatal: true });

async function loadIdlFile(path: string): Promise<IdlParse> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    return { ok: false, reason: `the file could not be read: ${messageOf(cause)}` };
  }

  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch (cause) {
    return { ok: false, reason: `the file is not valid UTF-8: ${messageOf(cause)}` };
  }

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    return { ok: false, reason: `the file is not valid JSON: ${messageOf(cause)}` };
  }

  return validateIdl(path, document);
}

// ---------------------------------------------------------------------------
// Structural validation — Requirement 18.4
// ---------------------------------------------------------------------------

/**
 * Check the four required fields and build the typed shape (Req 18.4).
 *
 * Checked in the order Requirement 18.4 lists them — `version`, `name`,
 * `instructions`, `metadata.address` — so a file missing several of them always
 * reports the same one, and the warning text for a given file is stable across
 * runs.
 *
 * A field of the wrong type is treated as a missing field, and the reason says
 * what was found instead. `"instructions": {}` is no more usable than no
 * `instructions` key at all, and reporting it as "missing" while showing the
 * type is more useful to someone looking at the file than a separate outcome
 * would be.
 *
 * Validation is file-level and all-or-nothing: a file either becomes a
 * `LoadedIdl` or produces exactly one warning. The alternative — loading an IDL
 * with the malformed parts dropped — would let `resolveError` report "not in
 * this program's table" for a code that is in the file, which is a wrong answer
 * where a warning is a true one.
 */
function validateIdl(path: string, document: unknown): IdlParse {
  const root = asRecord(document);
  if (root === null) {
    return { ok: false, reason: `expected a JSON object at the document root, found ${typeName(document)}` };
  }

  const version = root['version'];
  if (typeof version !== 'string') {
    return { ok: false, reason: fieldReason('version', 'a string', version) };
  }

  const name = root['name'];
  if (typeof name !== 'string') {
    return { ok: false, reason: fieldReason('name', 'a string', name) };
  }

  const rawInstructions = root['instructions'];
  if (!Array.isArray(rawInstructions)) {
    return { ok: false, reason: fieldReason('instructions', 'an array', rawInstructions) };
  }

  const metadata = asRecord(root['metadata']);
  if (metadata === null) {
    return { ok: false, reason: fieldReason('metadata', 'an object', root['metadata']) };
  }

  const address = metadata['address'];
  if (typeof address !== 'string' || address === '') {
    return { ok: false, reason: fieldReason('metadata.address', 'a non-empty string', address) };
  }

  const instructions: IdlInstruction[] = [];
  for (const [index, entry] of rawInstructions.entries()) {
    const instruction = validateInstruction(entry, `instructions[${index}]`);
    if (!instruction.ok) return instruction;
    instructions.push(instruction.value);
  }

  const errors = validateErrors(root['errors']);
  if (!errors.ok) return errors;

  const accounts = validateAccountDefs(root['accounts']);
  if (!accounts.ok) return accounts;

  return {
    ok: true,
    idl: {
      path,
      version,
      name,
      address,
      instructions,
      errors: errors.value,
      accounts: accounts.value,
    },
  };
}

type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

function validateInstruction(entry: unknown, at: string): Checked<IdlInstruction> {
  const record = asRecord(entry);
  if (record === null) {
    return { ok: false, reason: fieldReason(at, 'an object', entry) };
  }

  const name = record['name'];
  if (typeof name !== 'string') {
    return { ok: false, reason: fieldReason(`${at}.name`, 'a string', name) };
  }

  const accounts = validateInstructionAccounts(record['accounts'], `${at}.accounts`);
  if (!accounts.ok) return accounts;

  const args = validateFields(record['args'], `${at}.args`);
  if (!args.ok) return args;

  return { ok: true, value: { name, accounts: accounts.value, args: args.value } };
}

/**
 * An absent `accounts` or `args` array reads as empty rather than as an error.
 * Anchor always emits both, but an instruction that takes no accounts and no
 * arguments is a coherent thing to describe, and Requirement 18.4 does not name
 * either field as required.
 */
function validateInstructionAccounts(
  value: unknown,
  at: string,
): Checked<readonly IdlInstructionAccount[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return { ok: false, reason: fieldReason(at, 'an array', value) };
  }

  const accounts: IdlInstructionAccount[] = [];
  for (const [index, entry] of value.entries()) {
    const record = asRecord(entry);
    if (record === null) {
      return { ok: false, reason: fieldReason(`${at}[${index}]`, 'an object', entry) };
    }

    const name = record['name'];
    if (typeof name !== 'string') {
      return { ok: false, reason: fieldReason(`${at}[${index}].name`, 'a string', name) };
    }

    // A nested `accounts` array is Anchor's composite-accounts form. Its
    // presence, not a `kind` tag in the file, is what distinguishes a group.
    const nested = record['accounts'];
    if (nested === undefined) {
      accounts.push({ kind: 'account', name });
      continue;
    }

    const group = validateInstructionAccounts(nested, `${at}[${index}].accounts`);
    if (!group.ok) return group;
    accounts.push({ kind: 'group', name, accounts: group.value });
  }

  return { ok: true, value: accounts };
}

function validateFields(value: unknown, at: string): Checked<readonly IdlField[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return { ok: false, reason: fieldReason(at, 'an array', value) };
  }

  const fields: IdlField[] = [];
  for (const [index, entry] of value.entries()) {
    const record = asRecord(entry);
    if (record === null) {
      return { ok: false, reason: fieldReason(`${at}[${index}]`, 'an object', entry) };
    }

    const name = record['name'];
    if (typeof name !== 'string') {
      return { ok: false, reason: fieldReason(`${at}[${index}].name`, 'a string', name) };
    }

    fields.push({ name, type: record['type'] });
  }

  return { ok: true, value: fields };
}

/** `errors` is optional; absent means the program declares none. */
function validateErrors(value: unknown): Checked<readonly IdlErrorCode[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return { ok: false, reason: fieldReason('errors', 'an array', value) };
  }

  const errors: IdlErrorCode[] = [];
  for (const [index, entry] of value.entries()) {
    const at = `errors[${index}]`;
    const record = asRecord(entry);
    if (record === null) {
      return { ok: false, reason: fieldReason(at, 'an object', entry) };
    }

    const code = record['code'];
    if (typeof code !== 'number' || !Number.isSafeInteger(code)) {
      return { ok: false, reason: fieldReason(`${at}.code`, 'an integer', code) };
    }

    const name = record['name'];
    if (typeof name !== 'string') {
      return { ok: false, reason: fieldReason(`${at}.name`, 'a string', name) };
    }

    const msg = record['msg'];
    if (msg !== undefined && typeof msg !== 'string') {
      return { ok: false, reason: fieldReason(`${at}.msg`, 'a string', msg) };
    }

    errors.push({ code, name, msg: msg ?? null });
  }

  return { ok: true, value: errors };
}

/** `accounts` is optional; absent means the IDL declares no account types. */
function validateAccountDefs(value: unknown): Checked<readonly IdlAccountDef[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return { ok: false, reason: fieldReason('accounts', 'an array', value) };
  }

  const accounts: IdlAccountDef[] = [];
  for (const [index, entry] of value.entries()) {
    const at = `accounts[${index}]`;
    const record = asRecord(entry);
    if (record === null) {
      return { ok: false, reason: fieldReason(at, 'an object', entry) };
    }

    const name = record['name'];
    if (typeof name !== 'string') {
      return { ok: false, reason: fieldReason(`${at}.name`, 'a string', name) };
    }

    accounts.push({ name, type: record['type'] });
  }

  return { ok: true, value: accounts };
}

// ---------------------------------------------------------------------------
// Diagnostic helpers
// ---------------------------------------------------------------------------

/**
 * The one warning-text shape, so `"version" is missing` and
 * `"version" must be a string, found number` never drift apart between the
 * dozen call sites above.
 */
function fieldReason(field: string, expected: string, found: unknown): string {
  return found === undefined
    ? `"${field}" is missing`
    : `"${field}" must be ${expected}, found ${typeName(found)}`;
}

/** What a value is, for a diagnostic. `typeof` alone calls null and arrays objects. */
function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** A plain JSON object, or null for anything else including arrays and null. */
function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
