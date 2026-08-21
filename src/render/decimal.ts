/**
 * Fixed-point decimal formatting — the only place in the codebase that produces
 * a fractional value.
 *
 * Satisfies Requirements 12.5, 12.10, 12.11, 12.12, 12.13, 12.14, and 9.7.
 *
 * Everything upstream of here is integral: lamports and token amounts travel
 * through `Analysis` as signed decimal *integer* strings in their smallest unit,
 * and the analysis layer performs no unit conversion at all (Req 7.10, 20.7).
 * The decimal point is a display concern and it is introduced exactly once, in
 * this module. That containment is what makes the float ban checkable: there is
 * one file to read, and Property 34's AST guard covers it.
 *
 * Four rules carry the module.
 *
 * - **No float, in any form.** There is no `Number(...)` conversion, no
 *   `parseFloat`, no `toFixed`, and no `/` between two `number`s anywhere below.
 *   The split into integer and fractional parts is `bigint` division and `bigint`
 *   remainder — both operands of every `/` and `%` in this file are `bigint`, so
 *   the operation is exact integer division at every magnitude, which is what
 *   Requirements 12.5 and 12.10 ask for and what no double can do above 2^53.
 *   Zero-padding and slicing do the rest (Req 12.12).
 * - **No locale, anywhere.** The thousands separator is the fixed ASCII comma in
 *   `THOUSANDS_SEPARATOR`, and the decimal point is the fixed ASCII period.
 *   `toLocaleString` and `Intl` are absent, so output is invariant under `LANG`,
 *   `LC_ALL`, and `TZ` (Req 9.7). A locale-aware separator — `1.234,56` under
 *   `de_DE` — is precisely what that requirement forbids, because it would make
 *   one input produce two different byte streams on two machines.
 * - **Nine digits means nine digits.** `formatLamportsAsSol('1000000000')` is
 *   `1.000000000`, not `1.0` and not `1`. Trailing zeros are significant here:
 *   a fixed column count is what lets a reader compare two balances by eye, and
 *   dropping them would make the output's digit count depend on the value
 *   (Req 12.5).
 * - **A token amount is formatted at its mint's scale or not at all.**
 *   `formatTokenAmount` takes a `TokenAmount`, which binds the raw amount to its
 *   mint and its `TokenDecimals` in one value, and `TokenDecimals` is a
 *   discriminated union. There is no way to reach the number without first
 *   handling `known: false`, and that branch emits base units at `partial`
 *   confidence rather than guessing (Req 12.11, 12.13, 12.14). No default of 9,
 *   or 6, or anything else appears below — the constant `LAMPORT_FRACTIONAL_DIGITS`
 *   is reachable only from `formatLamportsAsSol`.
 *
 * ## The sign is handled explicitly, and that is not incidental
 *
 * `bigint` division truncates toward zero, so for `-1` lamport the quotient is
 * `0n` and the remainder is `-1n`. Formatting those two parts as they come out
 * yields `0.-1`, and recovering the `-` from the quotient's string yields
 * nothing at all, because `0n.toString()` is `"0"` — a naive implementation
 * prints `0.000000001` and reads as *positive*. That is the dangerous case: the
 * output is well-formed, plausible, and has the wrong sign, and every value
 * between `-1` and `-999999999` lamports hits it.
 *
 * So the sign is taken from the `bigint` value once, the magnitude is formatted
 * unsigned, and the `-` is prepended to the finished string. `bigint` has no
 * negative zero, so `'-0'` normalizes to `0.000000000` rather than
 * `-0.000000000` — there is one spelling of zero, which is what determinism
 * requires (Req 9.1).
 *
 * ## Return shapes
 *
 * `formatFixedPoint`, `formatLamportsAsSol`, and `groupThousands` return a plain
 * `string`; only `formatTokenAmount` returns a record. The asymmetry is the
 * point rather than an inconsistency: the token case is the only one with
 * something to say beyond the digits, because an unknown scale must travel with
 * a `partial` marker and a base-units label (Req 12.13). Wrapping the other
 * three would put a constant `confidence: 'full'` on every call site in
 * `render/text.ts` for the caller to unwrap and discard, which buys nothing and
 * obscures the one place a caller genuinely has to branch. These are also the
 * signatures design.md fixes for this module.
 *
 * ## Malformed input is a caller bug, not a data condition
 *
 * Every numeric leaf of `Analysis` is a decimal integer string by construction —
 * design.md's Property 27 asserts it over the whole object — so a string this
 * module cannot parse means the object was built wrong, not that the chain
 * returned something unusual. That is different from an unknown program or an
 * absent `decimals` value, which are real conditions with honest renderings
 * (`raw`, base units). A `RangeError` is therefore the right answer for
 * unparseable input: it is unreachable from a well-typed `Analysis`, and
 * `render/text.ts` turns it into the Requirement 12.7 stderr message rather than
 * printing digits nobody can vouch for.
 */

import type { LamportAmount, RawTokenAmount, TokenAmount } from '../model/analysis.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The one thousands separator, fixed for every locale (Req 9.7).
 *
 * A comma, because the decimal point is a period; the pair has to be chosen
 * together or the output is ambiguous. Deliberately not `Intl.NumberFormat` or
 * `toLocaleString`, either of which would swap the two under `de_DE` and break
 * byte-identical output across machines.
 */
export const THOUSANDS_SEPARATOR = ',';

/** The decimal point, also fixed for every locale (Req 9.7). */
export const DECIMAL_POINT = '.';

/** 1 SOL is 10^9 lamports, so SOL display carries exactly 9 digits (Req 12.5). */
export const LAMPORT_FRACTIONAL_DIGITS = 9;

/** The label Requirement 12.13 attaches to an unscaled token amount. */
export const BASE_UNITS_LABEL = 'base units';

/**
 * The largest `fractionalDigits` this module will format.
 *
 * An SPL mint's `decimals` is a `u8` on chain, so 255 is the widest real scale
 * and Property 36 exercises 0-18. The bound exists because `10n ** n` is
 * computable for absurd `n` and would turn a malformed `decimals` value into a
 * multi-megabyte allocation; past this point the input is not a scale.
 */
export const MAX_FRACTIONAL_DIGITS = 255;

/**
 * A signed decimal integer, the shape every numeric leaf of `Analysis` has.
 *
 * `BigInt`'s own leniency is not a substitute: it accepts `'0x10'`, `' 12 '`,
 * and `''`, each of which would put a value on screen that the input did not
 * contain. `'1e9'`, `'1.5'`, `'NaN'`, and `'Infinity'` are all rejected here.
 * A leading `+` and leading zeros are accepted and normalize away through
 * `BigInt`, matching `tokenBalances.ts`'s reader, so this module is not the
 * thing that fails on a merely unusual spelling of a value it can represent
 * exactly.
 */
const DECIMAL_INTEGER = /^[+-]?[0-9]+$/;

/** Digits with an optional leading `-`; what `groupThousands` accepts. */
const SIGNED_DIGITS = /^-?[0-9]+$/;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * A token amount rendered at its mint's scale, or honestly refused.
 *
 * A union rather than a record with nullable fields, mirroring the
 * `TokenDecimals` union it is derived from: a consumer cannot read the digits
 * without seeing which of the two situations produced them, so
 * `render/text.ts` cannot print a base-unit integer as though it were a scaled
 * quantity.
 */
export type FormattedTokenAmount =
  | {
      readonly unit: 'scaled';
      /** Grouped integer portion, `.`, then exactly `fractionalDigits` digits. */
      readonly text: string;
      /**
       * The mint's `decimals`, carried through so a caller can state the scale
       * it printed at. Never a default and never inferred (Req 12.14).
       */
      readonly fractionalDigits: number;
      readonly confidence: 'full';
    }
  | {
      readonly unit: 'baseUnits';
      /**
       * The raw base-unit integer, byte-identical to `TokenAmount.raw`. No
       * decimal point and no separators, so the digits can be copied straight
       * back into a tool that speaks base units (Req 12.13).
       */
      readonly text: RawTokenAmount;
      readonly label: typeof BASE_UNITS_LABEL;
      /** Req 12.13. The amount is exact; what it is exact *in* is unknown. */
      readonly confidence: 'partial';
    };

/**
 * Render a signed decimal integer string as a fixed-point decimal with exactly
 * `fractionalDigits` fractional digits and thousand separators on the integer
 * portion.
 *
 * Requirements 12.5, 12.10, 12.11, 12.12.
 *
 * `fractionalDigits` of `0` yields no decimal point at all — a zero-decimals
 * mint holds whole units, and `1234.` is not a number anyone writes. Every other
 * count yields exactly that many digits, trailing zeros included.
 *
 * Exactness holds at every magnitude, including above 2^53 and across the full
 * `u64` range, because the value is never a `number`: `BigInt` parses the digits,
 * `bigint` division and remainder split them, and `padStart` restores the ones
 * the quotient dropped.
 *
 * @throws RangeError if `raw` is not a decimal integer string, or if
 * `fractionalDigits` is not an integer in `0..MAX_FRACTIONAL_DIGITS`. Both are
 * unreachable from a well-typed `Analysis`; see the module note.
 */
export function formatFixedPoint(raw: string, fractionalDigits: number): string {
  const value = parseDecimalInteger(raw);
  const scale = powerOfTen(fractionalDigits);

  // The sign is read off the value, once, and re-applied at the end. Truncation
  // toward zero makes every other arrangement wrong for -0.000000001; see the
  // module note.
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const sign = negative ? '-' : '';

  // Both operands are `bigint`: exact integer division and exact remainder, not
  // a float division on a monetary value.
  const wholePart = magnitude / scale;
  const fractionalPart = magnitude % scale;

  const whole = groupThousands(wholePart.toString());
  if (fractionalDigits === 0) return `${sign}${whole}`;

  // The remainder has lost its leading zeros — 1n out of 10^9 is `"1"` — and
  // `padStart` is what puts them back. This is the string padding half of
  // Requirement 12.5.
  const fraction = fractionalPart.toString().padStart(fractionalDigits, '0');
  return `${sign}${whole}${DECIMAL_POINT}${fraction}`;
}

/**
 * Render an integer lamport amount as SOL: exactly nine fractional digits, with
 * thousand separators on the integer portion.
 *
 * Requirements 12.5, 12.10.
 *
 * The nine is a constant of the chain, not a default that stands in for an
 * unknown value, which is the whole difference between this function and
 * `formatTokenAmount` (Req 12.14). SOL exists only here and in `render/text.ts`;
 * `Analysis` and the JSON renderer carry raw lamports (Req 7.10, 13.8).
 */
export function formatLamportsAsSol(lamports: LamportAmount): string {
  return formatFixedPoint(lamports, LAMPORT_FRACTIONAL_DIGITS);
}

/**
 * Render a token amount at its mint's scale, or as labelled base units when that
 * scale is unknown.
 *
 * Requirements 12.11, 12.12, 12.13, 12.14.
 *
 * The fractional digit count is `decimals.value` and nothing else. There is no
 * fallback to nine, no inference from the mint address, and no default — the
 * `known: false` branch does not reach for a number, it changes what is printed:
 * the raw base-unit integer, labelled as base units, at `partial` confidence.
 * That is strictly more useful than a confidently misplaced decimal point, which
 * is indistinguishable from a correct one on screen.
 *
 * @throws RangeError if `amount.raw` is not a decimal integer string, or if a
 * known `decimals` is outside `0..MAX_FRACTIONAL_DIGITS`. See the module note.
 */
export function formatTokenAmount(amount: TokenAmount): FormattedTokenAmount {
  const decimals = amount.decimals;

  if (!decimals.known) {
    // Validated but not rewritten: the guard rejects a leaf that is not an
    // integer at all, and the text emitted is `raw` verbatim, so the digits on
    // screen are byte-identical to the digits in `Analysis` (Req 12.13).
    parseDecimalInteger(amount.raw);
    return {
      unit: 'baseUnits',
      text: amount.raw,
      label: BASE_UNITS_LABEL,
      confidence: 'partial',
    };
  }

  return {
    unit: 'scaled',
    text: formatFixedPoint(amount.raw, decimals.value),
    fractionalDigits: decimals.value,
    confidence: 'full',
  };
}

/**
 * Insert `THOUSANDS_SEPARATOR` every three digits from the right.
 *
 * Requirements 12.5, 9.7. Also the formatter for compute units, which are plain
 * integers with separators and no fractional part.
 *
 * **Integer portions only.** Grouping a fractional part from the right would
 * produce `0.000,000,001`, which is not a notation; a fractional part is read
 * left to right from the point and is never grouped. `formatFixedPoint` calls
 * this on the quotient alone, before the point is added.
 *
 * A pure string regrouping: it neither parses nor normalizes, so `'-0'` stays
 * `'-0'` and `'007'` stays `'007'`. Sign normalization belongs to whoever
 * produced the digits — `formatFixedPoint` hands over an unsigned magnitude for
 * exactly that reason.
 *
 * @throws RangeError if `integerPart` is not digits with an optional leading `-`.
 */
export function groupThousands(integerPart: string): string {
  if (!SIGNED_DIGITS.test(integerPart)) {
    throw new RangeError(
      `groupThousands expected an integer digit string, received ${JSON.stringify(integerPart)}`,
    );
  }

  const negative = integerPart.startsWith('-');
  const digits = negative ? integerPart.slice(1) : integerPart;

  let grouped = '';
  for (let end = digits.length; end > 0; end -= 3) {
    const start = end > 3 ? end - 3 : 0;
    const chunk = digits.slice(start, end);
    grouped = grouped === '' ? chunk : `${chunk}${THOUSANDS_SEPARATOR}${grouped}`;
  }

  return negative ? `-${grouped}` : grouped;
}

// ---------------------------------------------------------------------------
// Parsing and scaling
// ---------------------------------------------------------------------------

/**
 * One decimal integer string as a `bigint`.
 *
 * The regex is the gate and `BigInt` is the conversion. `Number(...)` never
 * appears: it would round every input above 2^53 before a single digit reached
 * the output, and the rounded value has the right magnitude and the wrong digits,
 * which is the failure the whole decimal-string representation exists to prevent.
 */
function parseDecimalInteger(raw: string): bigint {
  if (typeof raw !== 'string' || !DECIMAL_INTEGER.test(raw)) {
    throw new RangeError(
      `expected a decimal integer string, received ${JSON.stringify(raw)}`,
    );
  }
  return BigInt(raw);
}

/**
 * `10n ** BigInt(fractionalDigits)`, with the scale validated first.
 *
 * `Number.isSafeInteger` is a predicate, not a conversion — it reads the value
 * and returns a boolean, and no numeric value flows through it — so it is not a
 * float path. The upper bound is `MAX_FRACTIONAL_DIGITS`; see that constant.
 */
function powerOfTen(fractionalDigits: number): bigint {
  if (
    !Number.isSafeInteger(fractionalDigits) ||
    fractionalDigits < 0 ||
    fractionalDigits > MAX_FRACTIONAL_DIGITS
  ) {
    throw new RangeError(
      `fractionalDigits must be an integer in 0..${MAX_FRACTIONAL_DIGITS}, received ${String(fractionalDigits)}`,
    );
  }
  return 10n ** BigInt(fractionalDigits);
}
