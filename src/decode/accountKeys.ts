/**
 * Account key resolution for legacy and v0 messages.
 *
 * Satisfies Requirements 7.1-7.7, 7.14, 19.1-19.7.
 *
 * Two invariants carry this module:
 *
 * - **Ordering is fixed.** The effective account key list is the static keys,
 *   then the loaded writable addresses, then the loaded readonly addresses
 *   (Req 19.3). A legacy message's effective list is the static keys alone
 *   (Req 19.2).
 * - **Roles come from two different sources and stay separate.** The message
 *   header governs static keys only (Req 7.4). A lookup-table address takes its
 *   role from which `loadedAddresses` array it appeared in and is never a signer
 *   (Req 7.5-7.7): a signature covers the static key list, so an address that
 *   was not in the message at signing time cannot have signed it.
 *
 * `resolveAccountRef` is the single point of index resolution and cannot read
 * out of bounds — every failure mode is the `unresolved` variant of
 * `AccountRef`, so it never throws and never returns `undefined` (Req 19.5).
 *
 * Addresses are emitted as base58 strings (Req 7.14). The RPC JSON encoding
 * already delivers them that way, so nothing is re-encoded here; carrying them
 * through verbatim is what keeps a fixture and a live response identical.
 */

import type {
  AccountEntry,
  AccountRef,
  AccountRole,
  Base58Address,
  MessageVersion,
} from '../model/analysis.js';
import type { RawMessageHeader, RawTransactionResponse } from '../model/rawResponse.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface EffectiveKeys {
  /** Requirement 19.1. */
  readonly messageVersion: MessageVersion;
  /** Number of leading entries governed by the message header. Req 7.4. */
  readonly staticCount: number;
  /** Effective account key list, in effective order. Requirement 19.2, 19.3. */
  readonly entries: readonly AccountEntry[];
  /**
   * Whether `meta.loadedAddresses` was present in the response. This reports an
   * observed fact about the input, not a judgement about completeness: a legacy
   * response that happens to carry the field reads `true`, and the flag plays no
   * part in resolving a legacy message. It gates the Requirement 19.6 path for
   * v0 only.
   */
  readonly loadedAddressesAvailable: boolean;
}

/**
 * Assemble the effective account key list and the role of every entry.
 *
 * Requirements 7.1-7.7, 7.14, 19.1-19.4, 19.7.
 */
export function resolveAccountKeys(response: RawTransactionResponse): EffectiveKeys {
  const message = response.transaction.message;
  const staticKeys = message.accountKeys;
  const staticCount = staticKeys.length;
  const messageVersion: MessageVersion = response.version === 0 ? 'v0' : 'legacy';
  const loaded = response.meta?.loadedAddresses ?? null;

  const entries: AccountEntry[] = [];

  // Static keys: header governs both signer and writable (Req 7.1-7.4).
  for (const address of staticKeys) {
    const index = entries.length;
    const { signer, role } = staticRoleAt(index, staticCount, message.header);
    entries.push({
      index,
      address,
      signer,
      role,
      origin: { kind: 'static' },
      referencedBy: [],
      name: null,
      confidence: 'full',
    });
  }

  // Loaded addresses: writable first, then readonly (Req 19.3). Never a signer
  // (Req 7.7), and the role is the array it came from (Req 7.5, 7.6). A legacy
  // message resolves from static keys alone, so the field is ignored (Req 19.2).
  if (messageVersion === 'v0' && loaded !== null) {
    for (const address of loaded.writable) {
      entries.push(lookupEntry(entries.length, address, 'writable'));
    }
    for (const address of loaded.readonly) {
      entries.push(lookupEntry(entries.length, address, 'readonly'));
    }
  }

  return {
    messageVersion,
    staticCount,
    entries,
    loadedAddressesAvailable: loaded !== null,
  };
}

/**
 * Resolve one instruction account index against the effective key list.
 *
 * The single point of index resolution (Req 19.5). Every out-of-range index —
 * negative, fractional, past the end, or dependent on lookup data that is not
 * in the response — yields the `unresolved` variant rather than an exception or
 * an `undefined`.
 */
export function resolveAccountRef(keys: EffectiveKeys, index: number): AccountRef {
  if (!Number.isSafeInteger(index) || index < 0) {
    return unresolvedRef(
      index,
      `account index ${index} is not a valid position in the effective account key list`,
    );
  }

  // Checked before the range check below, because with loadedAddresses absent
  // the effective list stops at the static keys and every lookup-table index is
  // also simply out of range. Requirement 19.6 asks for the specific reason.
  if (
    keys.messageVersion === 'v0' &&
    !keys.loadedAddressesAvailable &&
    index >= keys.staticCount
  ) {
    return unresolvedRef(
      index,
      `account index ${index} resolves through an address lookup table, but ` +
        `meta.loadedAddresses is absent from the transaction response, so only ` +
        `the ${keys.staticCount} static account keys could be resolved`,
    );
  }

  const entry = keys.entries[index];
  if (entry === undefined) {
    return unresolvedRef(
      index,
      `account index ${index} is out of range for the effective account key ` +
        `list of ${keys.entries.length} entries`,
    );
  }

  return {
    kind: 'resolved',
    index: entry.index,
    address: entry.address,
    signer: entry.signer,
    role: entry.role,
    origin: entry.origin,
    name: entry.name,
    confidence: entry.confidence,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function lookupEntry(
  index: number,
  address: Base58Address,
  loadedFrom: 'writable' | 'readonly',
): AccountEntry {
  return {
    index,
    address,
    signer: false,
    role: loadedFrom,
    origin: { kind: 'lookup-table', loadedFrom },
    referencedBy: [],
    name: null,
    confidence: 'full',
  };
}

/**
 * Signer and writable designation of one static key, per the Solana message
 * layout: the first `numRequiredSignatures` keys are signers, the last
 * `numReadonlySignedAccounts` of those are read-only, and the last
 * `numReadonlyUnsignedAccounts` of the remaining keys are read-only. Anything
 * not designated writable is read-only (Req 7.3).
 *
 * Header counts are clamped into range so a malformed header degrades a role
 * rather than producing a nonsensical one.
 */
function staticRoleAt(
  index: number,
  staticCount: number,
  header: RawMessageHeader,
): { readonly signer: boolean; readonly role: AccountRole } {
  const signerCount = clampCount(header.numRequiredSignatures, staticCount);
  const readonlySigned = clampCount(header.numReadonlySignedAccounts, signerCount);
  const unsignedCount = staticCount - signerCount;
  const readonlyUnsigned = clampCount(header.numReadonlyUnsignedAccounts, unsignedCount);

  if (index < signerCount) {
    return { signer: true, role: index < signerCount - readonlySigned ? 'writable' : 'readonly' };
  }
  return {
    signer: false,
    role: index < staticCount - readonlyUnsigned ? 'writable' : 'readonly',
  };
}

function clampCount(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), Math.max(max, 0));
}

function unresolvedRef(index: number, reason: string): AccountRef {
  return { kind: 'unresolved', index, reason, confidence: 'raw' };
}
