/* TEMPORARY offline check of the recorder's pure retry helpers. Deleted after running. */
import {
  backoffDecision,
  isRetryableStatus,
  parseRetryAfter,
  describeTally,
  newWalkTally,
} from './recordFixture.js';

const NOW = Date.UTC(2025, 0, 15, 12, 0, 0);
const base = { attempt: 1, maxAttempts: 6, nowMs: NOW, jitter: 0 } as const;

const results: string[] = [];
let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures += 1;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        got ${a}${ok ? '' : `\n        want ${e}`}`);
}

// --- Retry-After parsing ----------------------------------------------------
check('parseRetryAfter delta-seconds "2"', parseRetryAfter('2', NOW), 2_000);
check('parseRetryAfter "0"', parseRetryAfter('0', NOW), 0);
check(
  'parseRetryAfter HTTP-date +5s',
  parseRetryAfter(new Date(NOW + 5_000).toUTCString(), NOW),
  5_000,
);
check(
  'parseRetryAfter HTTP-date in the past clamps to 0',
  parseRetryAfter(new Date(NOW - 60_000).toUTCString(), NOW),
  0,
);
check('parseRetryAfter absent (null)', parseRetryAfter(null, NOW), null);
check('parseRetryAfter absent (undefined)', parseRetryAfter(undefined, NOW), null);
check('parseRetryAfter empty string', parseRetryAfter('   ', NOW), null);
check('parseRetryAfter float "1.5"', parseRetryAfter('1.5', NOW), null);
check('parseRetryAfter "12abc"', parseRetryAfter('12abc', NOW), null);
check('parseRetryAfter "-3"', parseRetryAfter('-3', NOW), null);
check('parseRetryAfter garbage word', parseRetryAfter('soon', NOW), null);

// --- status classification --------------------------------------------------
check('isRetryableStatus 429/502/503/504', [429, 502, 503, 504].map(isRetryableStatus), [
  true,
  true,
  true,
  true,
]);
check('isRetryableStatus 200/400/404/500', [200, 400, 404, 500].map(isRetryableStatus), [
  false,
  false,
  false,
  false,
]);

// --- backoff decisions ------------------------------------------------------
check('429 with Retry-After: 2', backoffDecision({ ...base, status: 429, retryAfter: '2' }), {
  retry: true,
  waitMs: 2_000,
  reason: 'retry-after',
});
check(
  '429 with HTTP-date Retry-After (+7s)',
  backoffDecision({
    ...base,
    status: 429,
    retryAfter: new Date(NOW + 7_000).toUTCString(),
  }),
  { retry: true, waitMs: 7_000, reason: 'retry-after' },
);
check(
  '429 Retry-After: 600 caps at MAX_BACKOFF_WAIT_MS',
  backoffDecision({ ...base, status: 429, retryAfter: '600' }),
  { retry: true, waitMs: 30_000, reason: 'retry-after' },
);
check(
  '429 no header, attempt 1, jitter 0',
  backoffDecision({ ...base, status: 429, retryAfter: null }),
  { retry: true, waitMs: 1_000, reason: 'backoff' },
);
check(
  '429 no header, attempt 3, jitter 0 (exponential)',
  backoffDecision({ ...base, status: 429, retryAfter: null, attempt: 3 }),
  { retry: true, waitMs: 4_000, reason: 'backoff' },
);
check(
  '429 no header, attempt 3, jitter 1 (+25%)',
  backoffDecision({ ...base, status: 429, retryAfter: null, attempt: 3, jitter: 1 }),
  { retry: true, waitMs: 5_000, reason: 'backoff' },
);
check(
  '429 no header, attempt 5, jitter 1 stays under the cap',
  backoffDecision({ ...base, status: 429, retryAfter: null, attempt: 5, jitter: 1 }),
  { retry: true, waitMs: 20_000, reason: 'backoff' },
);
check('503 with no header retries', backoffDecision({ ...base, status: 503, retryAfter: null }), {
  retry: true,
  waitMs: 1_000,
  reason: 'backoff',
});
check(
  '500 does NOT retry',
  backoffDecision({ ...base, status: 500, retryAfter: '2' }),
  { retry: false, waitMs: 0, reason: 'not-retryable' },
);
check(
  '404 does NOT retry',
  backoffDecision({ ...base, status: 404, retryAfter: null }),
  { retry: false, waitMs: 0, reason: 'not-retryable' },
);
check('200 does NOT retry', backoffDecision({ ...base, status: 200, retryAfter: null }), {
  retry: false,
  waitMs: 0,
  reason: 'success',
});
check(
  'attempt cap reached (attempt 6 of 6) stops',
  backoffDecision({ ...base, status: 429, retryAfter: '2', attempt: 6 }),
  { retry: false, waitMs: 0, reason: 'attempts-exhausted' },
);
check(
  'attempt 5 of 6 still retries (cap is the boundary)',
  backoffDecision({ ...base, status: 429, retryAfter: '2', attempt: 5 }).retry,
  true,
);

// --- the retry schedule a real 429 walk would produce -----------------------
const schedule: number[] = [];
for (let attempt = 1; attempt <= 6; attempt += 1) {
  const d = backoffDecision({ ...base, status: 429, retryAfter: null, attempt });
  if (!d.retry) break;
  schedule.push(d.waitMs);
}
check('full 429 schedule, jitter 0', schedule, [1_000, 2_000, 4_000, 8_000, 16_000]);

// --- tally prose ------------------------------------------------------------
const tally = newWalkTally();
tally.examined = 400;
tally.fetched = 120;
tally.outcomeRejected = 280;
tally.failingProgramRejected = 118;
tally.retries = 3;
check(
  'describeTally omits zero categories',
  describeTally(tally),
  '400 candidates examined, 120 fetched, 280 rejected by --outcome before fetching, 118 rejected by --failing-program, 3 requests retried',
);
check('describeTally on a fresh tally', describeTally(newWalkTally()), '0 candidates examined, 0 fetched');

process.stderr.write(`${results.join('\n')}\n\n${results.length - failures}/${results.length} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
