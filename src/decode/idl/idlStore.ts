/**
 * Anchor IDL loading — the only filesystem read in `decode/`.
 *
 * Satisfies Requirements 18.1–18.4, 9.6, 22.5.
 *
 * `--idl-dir` is accepted by `cli.ts` and arrives here through
 * `ResolvedConfig.idlDir` (Req 18.1). Every `*.json` file in that directory is
 * loaded (Req 18.2) and indexed by the program address the file declares, read
 * from `metadata.address` or from the top-level `address` (Req 18.3). Downstream,
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
 *   validator below. Only `instructions`, `errors`, `accounts`, and the program
 *   address are needed, and pulling in the Anchor client to reach four fields
 *   would add a large dependency whose version would then have to track the IDLs
 *   users happen to have on disk.
 * - **Two on-disk layouts, one loaded shape** (Req 18.3, 18.4). Anchor moved the
 *   three identity fields between releases, so each is read from either
 *   position:
 *
 *   | value     | Anchor ≤0.29        | Anchor 0.30+        |
 *   | --------- | ------------------- | ------------------- |
 *   | `address` | `metadata.address`  | `address` (root)    |
 *   | `version` | `version` (root)    | `metadata.version`  |
 *   | `name`    | `name` (root)       | `metadata.name`     |
 *
 *   `instructions`, `errors`, and `accounts` sit at the root in both. A value is
 *   missing only when it is absent from *both* positions, so `LoadedIdl` keeps
 *   all three non-optional and no consumer can tell which layout a file used.
 *   The 0.30 grammar changes *inside* `instructions` and `accounts` are not this
 *   module's business — `IdlTypeNode` is `unknown` and `idlDecoder.ts` owns
 *   interpretation, with one exception.
 *
 *   That exception is **`instructions[].discriminator`**, the one 0.30 addition
 *   this module does read. Anchor ≤0.29 declared no discriminator and left it to
 *   be computed from the instruction name; Anchor 0.30+ writes the eight bytes
 *   into the file, and a program is free to override them. The value is surfaced
 *   on `IdlInstruction` as declared-or-`null` rather than defaulted, because a
 *   loader that computed the fallback here would hide from `idlDecoder.ts` the
 *   one thing it has to know: whether the program stated its own wire format or
 *   left the convention to be inferred. This is not grammar interpretation —
 *   it is eight literal bytes, and nothing about the type system in `args` is
 *   involved.
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
  /**
   * The eight discriminator bytes the IDL declared, or `null` when it declared
   * none (Anchor ≤0.29, where the value is computed from `name` instead).
   *
   * `null` and not an eight-byte default. The distinction is the whole point of
   * the field: `idlDecoder.ts` prefers a declared discriminator over the
   * computed `sha256("global:" + snake_case(name))` because the IDL is the
   * program's own statement about its wire format, and a loader that filled in
   * the hash here would erase the difference between "the program said this" and
   * "we inferred this from a naming convention the program need not follow".
   *
   * `Uint8Array` rather than `readonly number[]` so it is the same type
   * `anchorDiscriminator` returns, which lets the decoder key its map with one
   * expression and no per-branch conversion. The array is technically mutable,
   * which the readonly modifier cannot fix; it costs nothing here because the
   * decoder reads it once, at construction, into a hex key.
   *
   * Always exactly `DISCRIMINATOR_BYTES` (8) long when non-null — see
   * `validateDiscriminator`.
   */
  readonly discriminator: Uint8Array | null;
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
  /**
   * From `metadata.address` (Anchor ≤0.29) or the top-level `address` (Anchor
   * 0.30+) — Req 18.3. The key this IDL is indexed under.
   */
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
        reason: `program address ${parsed.idl.address} was already loaded from ${existing.path}, so this file was ignored`,
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
 * Check the four required values and build the typed shape (Req 18.4).
 *
 * Two layouts are accepted, because Anchor 0.30 moved the identity fields and
 * both toolchains are in use:
 *
 * - **Anchor ≤0.29** — `version` and `name` at the root, address at
 *   `metadata.address`.
 * - **Anchor 0.30+** — `address` at the root, `name` and `version` under
 *   `metadata` (alongside `spec`).
 *
 * Each of the three is resolved from *either* position, so a mixed or
 * hand-edited file loads as long as every value is reachable somewhere. Only a
 * value absent from both positions is a warning.
 *
 * Checked in the order Requirement 18.4 lists them — `version`, `name`,
 * `instructions`, then the address — so a file missing several of them always
 * reports the same one, and the warning text for a given file is stable across
 * runs. Within one value, the root position is examined before the `metadata`
 * one, so which position a wrong-type reason names is fixed too.
 *
 * A field of the wrong type is treated as a missing field, and the reason says
 * what was found instead. `"instructions": {}` is no more usable than no
 * `instructions` key at all, and reporting it as "missing" while showing the
 * type is more useful to someone looking at the file than a separate outcome
 * would be.
 *
 * **`metadata` is no longer required in itself.** It used to be, when it was the
 * only place the address could live. Now it is just one of two places the three
 * identity values may sit, and a file carrying a root `address`, `version`, and
 * `name` has everything this module reads — rejecting it would be rejecting on a
 * container the loader never looks at, the same reason `IdlTypeNode` is left
 * `unknown`. A malformed `metadata` (a string, an array) is not an error either;
 * it simply contributes no positions, so the root has to supply everything.
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

  // `null` when absent or not an object: no positions, rather than an error.
  const metadata = asRecord(root['metadata']);

  const version = resolveIdentity('version', 'a string', root, metadata);
  if (!version.ok) return version;

  const name = resolveIdentity('name', 'a string', root, metadata);
  if (!name.ok) return name;

  const rawInstructions = root['instructions'];
  if (!Array.isArray(rawInstructions)) {
    return { ok: false, reason: fieldReason('instructions', 'an array', rawInstructions) };
  }

  const address = resolveIdentity('address', 'a non-empty string', root, metadata);
  if (!address.ok) return address;

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
      version: version.value,
      name: name.value,
      address: address.value,
      instructions,
      errors: errors.value,
      accounts: accounts.value,
    },
  };
}

type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

/**
 * One of `version`, `name`, `address`, read from the root or from `metadata`.
 *
 * The root position is examined first, so the position a wrong-type reason names
 * is a function of the file and not of which layout the file is closer to.
 *
 * **A present-in-both disagreement is a warning, not a preference.** If the root
 * says one thing and `metadata` says another, this file is malformed under both
 * Anchor layouts, and no toolchain emits it. For `address` a silent choice is
 * outright dangerous: the address is the key the store is indexed by, so guessing
 * wrong means decoding one program's instructions with another program's IDL —
 * a confidently wrong answer where a warning is a true one. `version` and `name`
 * are only labels, but a rule that holds for all three is one the user can
 * predict, and splitting it would mean the same file shape sometimes loads and
 * sometimes does not depending on which field disagreed. Both values are quoted
 * in the reason so the fix is obvious.
 */
function resolveIdentity(
  field: 'version' | 'name' | 'address',
  expected: 'a string' | 'a non-empty string',
  root: Readonly<Record<string, unknown>>,
  metadata: Readonly<Record<string, unknown>> | null,
): Checked<string> {
  const positions = [
    { label: field, value: root[field] },
    { label: `metadata.${field}`, value: metadata === null ? undefined : metadata[field] },
  ];

  const present = positions.filter((position) => position.value !== undefined);
  if (present.length === 0) {
    return { ok: false, reason: missingReason(positions.map((position) => position.label)) };
  }

  const usable = present.filter(
    (position) =>
      typeof position.value === 'string' &&
      (expected === 'a string' || position.value !== ''),
  );

  const first = usable[0];
  const offending = present[0];
  if (first === undefined) {
    // Every present position holds something unusable; name the first one.
    return {
      ok: false,
      reason:
        offending === undefined
          ? missingReason(positions.map((position) => position.label))
          : fieldReason(offending.label, expected, offending.value),
    };
  }

  const conflict = usable.find((position) => position.value !== first.value);
  if (conflict !== undefined) {
    return {
      ok: false,
      reason:
        `"${first.label}" is ${JSON.stringify(first.value)} but "${conflict.label}" is ` +
        `${JSON.stringify(conflict.value)}; the two disagree, so which one describes ` +
        `this program cannot be decided here`,
    };
  }

  return { ok: true, value: first.value as string };
}

function validateInstruction(entry: unknown, at: string): Checked<IdlInstruction> {
  const record = asRecord(entry);
  if (record === null) {
    return { ok: false, reason: fieldReason(at, 'an object', entry) };
  }

  const name = record['name'];
  if (typeof name !== 'string') {
    return { ok: false, reason: fieldReason(`${at}.name`, 'a string', name) };
  }

  const discriminator = validateDiscriminator(record['discriminator'], `${at}.discriminator`);
  if (!discriminator.ok) return discriminator;

  const accounts = validateInstructionAccounts(record['accounts'], `${at}.accounts`);
  if (!accounts.ok) return accounts;

  const args = validateFields(record['args'], `${at}.args`);
  if (!args.ok) return args;

  return {
    ok: true,
    value: {
      name,
      discriminator: discriminator.value,
      accounts: accounts.value,
      args: args.value,
    },
  };
}

/**
 * The discriminator width `idlDecoder.ts` also exports as `DISCRIMINATOR_BYTES`.
 *
 * Deliberately a second declaration rather than an import: the dependency
 * between these two modules runs decoder → loader, and importing a runtime value
 * from the decoder would reverse it so the loader could not be read, or tested,
 * without the whole Borsh reader behind it. Eight is a fixed property of the
 * Anchor wire format, not a tunable, so the two declarations cannot drift into
 * disagreeing about anything that changes.
 */
const DISCRIMINATOR_BYTES = 8;

/**
 * `instructions[].discriminator`, the one Anchor 0.30 addition inside
 * `instructions` this module reads (Req 4.1, 18.4).
 *
 * **Absent is not an error.** Anchor ≤0.29 declared no discriminator at all, and
 * the legacy layout is still the common case on disk; `null` means "compute it
 * from the name", which is what `idlDecoder.ts` does.
 *
 * **Present means exactly eight byte-valued integers, or the file is rejected.**
 * The length check is not pedantry about matching Anchor's emitter. `match`
 * compares the first eight bytes of a payload against these keys, so a
 * discriminator of any other length can never equal that prefix: the instruction
 * would load cleanly and then match nothing, degrading every payload that hit it
 * to `Unknown` with no diagnostic anywhere. That is precisely the silent failure
 * a declared discriminator was read in order to prevent, so the wrong length is
 * refused loudly here, where the reason can name the file and the field, rather
 * than being discovered as an absence of output later.
 *
 * A byte outside 0–255, a non-integer, or a non-number is refused for the same
 * reason — there is no eight-byte value it could describe.
 */
function validateDiscriminator(value: unknown, at: string): Checked<Uint8Array | null> {
  if (value === undefined) return { ok: true, value: null };

  const expected = `an array of ${DISCRIMINATOR_BYTES} integers from 0 to 255`;
  if (!Array.isArray(value)) {
    return { ok: false, reason: fieldReason(at, expected, value) };
  }

  if (value.length !== DISCRIMINATOR_BYTES) {
    return {
      ok: false,
      reason:
        `"${at}" must be ${expected}, found ${value.length}; a discriminator of any ` +
        `other length could never match the ${DISCRIMINATOR_BYTES}-byte payload prefix`,
    };
  }

  const bytes = new Uint8Array(DISCRIMINATOR_BYTES);
  for (const [index, entry] of value.entries()) {
    if (
      typeof entry !== 'number' ||
      !Number.isSafeInteger(entry) ||
      entry < 0 ||
      entry > 255
    ) {
      return {
        ok: false,
        reason: fieldReason(`${at}[${index}]`, 'an integer from 0 to 255', entry),
      };
    }
    bytes[index] = entry;
  }

  return { ok: true, value: bytes };
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

/**
 * A value the loader looked for in more than one place, found in none of them.
 *
 * Both positions are named, so a user whose Anchor 0.30 IDL genuinely has no
 * name is told where the loader looked instead of being pointed at the one
 * legacy spelling.
 */
function missingReason(labels: readonly string[]): string {
  return `${labels.map((label) => `"${label}"`).join(' or ')} is missing`;
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
