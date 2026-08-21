/**
 * Unit tests for `src/render/decimal.ts`.
 *
 * The module is the only producer of a fractional value in the codebase, so
 * these tests are digit-for-digit rather than approximate. Every expected value
 * below is written out in full: a test that computed its own expectation with
 * arithmetic could share a rounding bug with the code and agree with it.
 *
 * The cases are chosen where a float implementation diverges from an exact one.
 * `2^53` and `2^53 + 1` are the first two doubles that cannot both be
 * represented, `2^64 - 1` is the widest `u64` a lamport balance reaches, and the
 * negative sub-unit values are where truncation toward zero loses the sign — a
 * naive split prints `-1` lamport as a *positive* `0.000000001`, which is
 * well-formed, plausible, and wrong.
 *
 * The named v1 properties over this module — design.md's Property 35 (exact
 * lamport-to-SOL conversion across the `u64` range) and Property 36 (token
 * amounts render at their mint's scale, never a default) — belong to their own
 * tasks and are deliberately not duplicated here.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { TokenAmount, TokenDecimals } from '../../src/model/analysis.js';
import {
  BASE_UNITS_LABEL,
  formatFixedPoint,
  formatLamportsAsSol,
  formatTokenAmount,
  groupThousands,
  MAX_FRACTIONAL_DIGITS,
} from '../../src/render/decimal.js';

/** An arbitrary but well-formed mint; nothing here depends on its value. */
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function tokenAmount(raw: string, decimals: TokenDecimals): TokenAmount {
  return { mint: MINT, raw, decimals };
}

// ---------------------------------------------------------------------------
// formatFixedPoint
// ---------------------------------------------------------------------------

describe('formatFixedPoint', () => {
  it('renders zero with the full fractional width', () => {
    expect(formatFixedPoint('0', 9)).toBe('0.000000000');
  });

  it('renders a value below one whole unit with a zero integer part', () => {
    expect(formatFixedPoint('1', 9)).toBe('0.000000001');
    expect(formatFixedPoint('999999999', 9)).toBe('0.999999999');
  });

  it('keeps the sign when the integer part is zero', () => {
    // The case a naive implementation reads as positive: the quotient is 0n and
    // `0n.toString()` carries no '-'.
    expect(formatFixedPoint('-1', 9)).toBe('-0.000000001');
    expect(formatFixedPoint('-999999999', 9)).toBe('-0.999999999');
  });

  it('keeps the sign when the integer part is non-zero', () => {
    expect(formatFixedPoint('-1000000001', 9)).toBe('-1.000000001');
    expect(formatFixedPoint('-1000000000', 9)).toBe('-1.000000000');
  });

  it('has one spelling of zero', () => {
    // `bigint` has no negative zero, so a '-0' leaf cannot produce a second
    // rendering of the same quantity (Req 9.1).
    expect(formatFixedPoint('-0', 9)).toBe('0.000000000');
    expect(formatFixedPoint('+0', 9)).toBe('0.000000000');
  });

  it('emits exactly the requested number of fractional digits, trailing zeros included', () => {
    expect(formatFixedPoint('1000000000', 9)).toBe('1.000000000');
    expect(formatFixedPoint('1500000000', 9)).toBe('1.500000000');
    expect(formatFixedPoint('2000000000', 9)).toBe('2.000000000');

    for (const rendered of [
      formatFixedPoint('0', 9),
      formatFixedPoint('1', 9),
      formatFixedPoint('1000000000', 9),
      formatFixedPoint('18446744073709551615', 9),
    ]) {
      expect(rendered.split('.')[1]).toHaveLength(9);
    }
  });

  it('emits no decimal point at all for a zero-digit scale', () => {
    expect(formatFixedPoint('0', 0)).toBe('0');
    expect(formatFixedPoint('1234567', 0)).toBe('1,234,567');
    expect(formatFixedPoint('-1234567', 0)).toBe('-1,234,567');
    expect(formatFixedPoint('1234567', 0)).not.toContain('.');
  });

  it('is exact above 2^53, digit for digit', () => {
    // 2^53 and 2^53 + 1 are the first pair of integers a double cannot tell
    // apart. Both renderings differ in their last fractional digit.
    expect(formatFixedPoint('9007199254740992', 9)).toBe('9,007,199.254740992');
    expect(formatFixedPoint('9007199254740993', 9)).toBe('9,007,199.254740993');
    expect(formatFixedPoint('9007199254740992', 9)).not.toBe(
      formatFixedPoint('9007199254740993', 9),
    );
  });

  it('is exact at the top of the u64 range', () => {
    expect(formatFixedPoint('18446744073709551615', 9)).toBe('18,446,744,073.709551615');
    expect(formatFixedPoint('-18446744073709551615', 9)).toBe('-18,446,744,073.709551615');
  });

  it('accepts a leading plus and leading zeros, which normalize away', () => {
    expect(formatFixedPoint('+5', 9)).toBe('0.000000005');
    expect(formatFixedPoint('0000000005', 9)).toBe('0.000000005');
  });

  it('rejects anything that is not a decimal integer string', () => {
    for (const raw of ['', ' ', ' 1 ', '1.5', '1e9', '0x10', 'NaN', 'Infinity', '-', '1_000']) {
      expect(() => formatFixedPoint(raw, 9)).toThrow(RangeError);
    }
  });

  it('rejects a fractional digit count that is not a usable scale', () => {
    for (const digits of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_FRACTIONAL_DIGITS + 1]) {
      expect(() => formatFixedPoint('1', digits)).toThrow(RangeError);
    }
    expect(() => formatFixedPoint('1', MAX_FRACTIONAL_DIGITS)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// formatLamportsAsSol
// ---------------------------------------------------------------------------

describe('formatLamportsAsSol', () => {
  it('renders one SOL with nine fractional digits', () => {
    expect(formatLamportsAsSol('1000000000')).toBe('1.000000000');
  });

  it('renders one lamport, and its negation, at nine digits', () => {
    expect(formatLamportsAsSol('1')).toBe('0.000000001');
    expect(formatLamportsAsSol('-1')).toBe('-0.000000001');
  });

  it('renders zero, a rent-exempt minimum, and a whole-SOL balance', () => {
    expect(formatLamportsAsSol('0')).toBe('0.000000000');
    expect(formatLamportsAsSol('890880')).toBe('0.000890880');
    expect(formatLamportsAsSol('5000000000')).toBe('5.000000000');
  });

  it('separates the integer portion only', () => {
    const rendered = formatLamportsAsSol('18446744073709551615');
    expect(rendered).toBe('18,446,744,073.709551615');
    const [whole, fraction] = rendered.split('.');
    expect(whole).toContain(',');
    expect(fraction).not.toContain(',');
  });

  it('agrees with formatFixedPoint at nine digits', () => {
    for (const lamports of ['0', '1', '-1', '1000000000', '18446744073709551615']) {
      expect(formatLamportsAsSol(lamports)).toBe(formatFixedPoint(lamports, 9));
    }
  });
});

// ---------------------------------------------------------------------------
// groupThousands
// ---------------------------------------------------------------------------

describe('groupThousands', () => {
  it('groups from the right at every digit count', () => {
    expect(groupThousands('1')).toBe('1');
    expect(groupThousands('12')).toBe('12');
    expect(groupThousands('123')).toBe('123');
    expect(groupThousands('1234')).toBe('1,234');
    expect(groupThousands('1234567')).toBe('1,234,567');
    expect(groupThousands('1234567890')).toBe('1,234,567,890');
    expect(groupThousands('18446744073709551615')).toBe('18,446,744,073,709,551,615');
  });

  it('groups a negative value without counting the sign as a digit', () => {
    expect(groupThousands('-1234')).toBe('-1,234');
    expect(groupThousands('-1234567')).toBe('-1,234,567');
    expect(groupThousands('-123')).toBe('-123');
  });

  it('regroups without normalizing', () => {
    // A pure string operation: it does not parse, so it does not rewrite the
    // spellings its caller handed it.
    expect(groupThousands('0')).toBe('0');
    expect(groupThousands('-0')).toBe('-0');
    expect(groupThousands('007')).toBe('007');
    expect(groupThousands('0000007')).toBe('0,000,007');
  });

  it('rejects a value that is not an integer digit string', () => {
    for (const value of ['', '-', '+1', '1.5', '1,234', '1e9', 'abc']) {
      expect(() => groupThousands(value)).toThrow(RangeError);
    }
  });
});

// ---------------------------------------------------------------------------
// formatTokenAmount
// ---------------------------------------------------------------------------

describe('formatTokenAmount', () => {
  it('renders a zero-decimals mint as whole units with no decimal point', () => {
    const formatted = formatTokenAmount(tokenAmount('1234567', { known: true, value: 0 }));
    expect(formatted).toEqual({
      unit: 'scaled',
      text: '1,234,567',
      fractionalDigits: 0,
      confidence: 'full',
    });
  });

  it('renders a six-decimals mint at six digits', () => {
    expect(formatTokenAmount(tokenAmount('1500000', { known: true, value: 6 }))).toEqual({
      unit: 'scaled',
      text: '1.500000',
      fractionalDigits: 6,
      confidence: 'full',
    });
    expect(formatTokenAmount(tokenAmount('1', { known: true, value: 6 })).text).toBe('0.000001');
    expect(formatTokenAmount(tokenAmount('-1', { known: true, value: 6 })).text).toBe('-0.000001');
  });

  it('renders a nine-decimals mint at nine digits, exactly across u64', () => {
    expect(
      formatTokenAmount(tokenAmount('18446744073709551615', { known: true, value: 9 })).text,
    ).toBe('18,446,744,073.709551615');
  });

  it('never applies the lamport rule to a token amount', () => {
    // Same digits, three scales, three different renderings. Nothing falls back
    // to nine (Req 12.14).
    const raw = '1000000';
    expect(formatTokenAmount(tokenAmount(raw, { known: true, value: 0 })).text).toBe('1,000,000');
    expect(formatTokenAmount(tokenAmount(raw, { known: true, value: 6 })).text).toBe('1.000000');
    expect(formatTokenAmount(tokenAmount(raw, { known: true, value: 9 })).text).toBe('0.001000000');
  });

  it('emits labelled base units at partial confidence when the scale is unknown', () => {
    const raw = '18446744073709551615';
    const formatted = formatTokenAmount(tokenAmount(raw, { known: false }));

    expect(formatted).toEqual({
      unit: 'baseUnits',
      text: raw,
      label: BASE_UNITS_LABEL,
      confidence: 'partial',
    });
    expect(BASE_UNITS_LABEL).toBe('base units');
  });

  it('invents no scale for an unknown-decimals amount', () => {
    const raw = '1000000';
    const formatted = formatTokenAmount(tokenAmount(raw, { known: false }));

    // Byte-identical to the raw amount: no decimal point, no separators, and in
    // particular not the nine-digit lamport rendering (Req 12.13).
    expect(formatted.text).toBe(raw);
    expect(formatted.text).not.toContain('.');
    expect(formatted.text).not.toContain(',');
    expect(formatted.text).not.toBe(formatLamportsAsSol(raw));
    expect(formatted.unit).toBe('baseUnits');
  });

  it('keeps the sign on an unknown-decimals amount', () => {
    expect(formatTokenAmount(tokenAmount('-42', { known: false })).text).toBe('-42');
  });

  it('rejects a raw amount that is not a decimal integer, at either scale', () => {
    expect(() => formatTokenAmount(tokenAmount('1.5', { known: true, value: 6 }))).toThrow(
      RangeError,
    );
    expect(() => formatTokenAmount(tokenAmount('1.5', { known: false }))).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Locale invariance — Requirement 9.7
// ---------------------------------------------------------------------------

describe('locale invariance', () => {
  const saved = { LANG: process.env['LANG'], LC_ALL: process.env['LC_ALL'] };

  afterEach(() => {
    for (const key of ['LANG', 'LC_ALL'] as const) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('produces identical bytes under a locale that swaps comma and period', () => {
    const cases: readonly (readonly [string, number])[] = [
      ['18446744073709551615', 9],
      ['-1', 9],
      ['1234567', 0],
      ['1500000', 6],
    ];

    const posix = cases.map(([raw, digits]) => formatFixedPoint(raw, digits));

    // de_DE writes 1.234.567,89 — if any locale-sensitive formatting were in
    // play, these renderings would change.
    process.env['LANG'] = 'de_DE.UTF-8';
    process.env['LC_ALL'] = 'de_DE.UTF-8';

    const german = cases.map(([raw, digits]) => formatFixedPoint(raw, digits));

    expect(german).toEqual(posix);
    expect(groupThousands('1234567')).toBe('1,234,567');
    expect(formatLamportsAsSol('1000000000')).toBe('1.000000000');
  });
});
