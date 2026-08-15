/* Throwaway hand-check for task 4.3. Deleted after running. */
import { resolveConfig, DEFAULT_RPC_URL, type CliOptions } from '../src/config.js';

const base: CliOptions = {
  signature: 'sig',
  json: false,
  rpcUrl: undefined,
  idlDir: undefined,
};

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  if (!pass) failures += 1;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}  actual=${a} expected=${e}`);
}

// --- Precedence (Req 16.1-16.4) ---
check(
  'flag wins over env',
  resolveConfig({ ...base, rpcUrl: 'http://flag.example' }, { OPSIS_RPC_URL: 'http://env.example' }),
  { ok: true, config: { rpcUrl: 'http://flag.example', idlDir: undefined, fixtureDir: './fixtures', requestTimeoutMs: 10_000 } },
);
check(
  'env used when no flag',
  resolveConfig(base, { OPSIS_RPC_URL: 'http://env.example:8899' }).ok &&
    resolveConfig(base, { OPSIS_RPC_URL: 'http://env.example:8899' }),
  { ok: true, config: { rpcUrl: 'http://env.example:8899', idlDir: undefined, fixtureDir: './fixtures', requestTimeoutMs: 10_000 } },
);
const dflt = resolveConfig(base, {});
check('default when neither', dflt.ok && dflt.config.rpcUrl, DEFAULT_RPC_URL);
const emptyEnv = resolveConfig(base, { OPSIS_RPC_URL: '' });
check('empty env treated as unset', emptyEnv.ok && emptyEnv.config.rpcUrl, DEFAULT_RPC_URL);
const emptyFlag = resolveConfig({ ...base, rpcUrl: '' }, {});
check('empty flag rejected', emptyFlag.ok, false);

// --- idlDir passthrough (Req 18.1) ---
const withIdl = resolveConfig({ ...base, idlDir: './idls' }, {});
check('idlDir passthrough', withIdl.ok && withIdl.config.idlDir, './idls');
check('idlDir absent stays undefined', dflt.ok && dflt.config.idlDir === undefined, true);

// --- URL validation (Req 16.5) ---
const accept = [
  'https://api.mainnet-beta.solana.com',
  'http://localhost:8899',
  'http://127.0.0.1:8899',
  'https://example.com/rpc/v1',
  'ws://[::1]:8900',
  'https://example.com:443/',
  'solana+rpc://host.example',
];
const reject = [
  '',
  'not a url',
  'api.mainnet-beta.solana.com',
  'https:/example.com',
  'https://',
  '://example.com',
  'https://example.com?api-key=abc',
  'https://example.com#frag',
  'https://user:pass@example.com',
  'https://example.com:',
  'https://example.com:0',
  'https://example.com:70000',
  'https://example.com:abc',
  ' https://example.com',
  'https://example.com\n',
  '1https://example.com',
];

for (const url of accept) {
  check(`accept ${JSON.stringify(url)}`, resolveConfig({ ...base, rpcUrl: url }, {}).ok, true);
}
for (const url of reject) {
  const r = resolveConfig({ ...base, rpcUrl: url }, {});
  check(`reject ${JSON.stringify(url)}`, r.ok, false);
  if (!r.ok) {
    check(`  error carries url ${JSON.stringify(url)}`, r.error.url, url);
    check(`  error carries form`, r.error.expectedForm, 'scheme://host[:port][/path]');
  }
}

// An invalid env value must also be rejected, not silently defaulted.
check('invalid env value rejected', resolveConfig(base, { OPSIS_RPC_URL: 'nonsense' }).ok, false);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
