import { readFileSync } from 'node:fs';
import {
  resolveAccountKeys,
  resolveAccountRef,
  type RawTransactionResponse,
} from '../src/decode/accountKeys.js';

function load(dir: string): RawTransactionResponse {
  return JSON.parse(
    readFileSync(`tests/golden/${dir}/input.json`, 'utf8'),
  ) as RawTransactionResponse;
}

for (const dir of ['01-success-cpi-heavy', '03-program-table-error']) {
  const response = load(dir);
  const keys = resolveAccountKeys(response);
  const loaded = response.meta?.loadedAddresses ?? null;
  const lookup = keys.entries.filter((e) => e.origin.kind === 'lookup-table');
  const signers = keys.entries.filter((e) => e.signer);

  console.log(`=== ${dir}`);
  console.log(`  version field       : ${JSON.stringify(response.version)}`);
  console.log(`  messageVersion      : ${keys.messageVersion}`);
  console.log(`  staticCount         : ${keys.staticCount}`);
  console.log(
    `  loadedAddresses     : writable=${loaded?.writable.length ?? 'absent'} readonly=${loaded?.readonly.length ?? 'absent'} (available=${keys.loadedAddressesAvailable})`,
  );
  console.log(`  entries.length      : ${keys.entries.length}`);
  const expected =
    keys.messageVersion === 'v0'
      ? keys.staticCount + (loaded?.writable.length ?? 0) + (loaded?.readonly.length ?? 0)
      : keys.staticCount;
  console.log(`  expected length     : ${expected}  -> ${keys.entries.length === expected ? 'OK' : 'MISMATCH'}`);
  console.log(`  lookup-table entries: ${lookup.length}`);
  console.log(
    `  lookup signers      : ${lookup.filter((e) => e.signer).length} -> ${lookup.every((e) => !e.signer) ? 'all signer:false OK' : 'FAIL'}`,
  );
  console.log(`  signer indices      : ${JSON.stringify(signers.map((e) => e.index))}`);
  console.log(
    `  writable indices    : ${JSON.stringify(keys.entries.filter((e) => e.role === 'writable').map((e) => e.index))}`,
  );
  console.log(`  index contiguous    : ${keys.entries.every((e, i) => e.index === i) ? 'OK' : 'FAIL'}`);
  const lookupRoles = new Set(
    lookup.map((e) => (e.origin.kind === 'lookup-table' ? `${e.origin.loadedFrom}->${e.role}` : '')),
  );
  console.log(`  lookup role mapping : ${JSON.stringify([...lookupRoles])}`);

  // Boundary probes through the single resolution point.
  for (const probe of [-1, 0, keys.staticCount, keys.entries.length - 1, keys.entries.length, 1.5, NaN]) {
    const ref = resolveAccountRef(keys, probe);
    console.log(
      `  ref(${String(probe)}) -> ${ref.kind}${ref.kind === 'resolved' ? ` ${ref.address} signer=${ref.signer} ${ref.role} ${ref.origin.kind}` : ` [${ref.confidence}] ${ref.reason}`}`,
    );
  }
}

// v0 with loadedAddresses stripped: Requirement 19.6.
const v0 = load('01-success-cpi-heavy');
const stripped: RawTransactionResponse = { ...v0, meta: {} };
const strippedKeys = resolveAccountKeys(stripped);
console.log('=== 01-success-cpi-heavy with loadedAddresses removed (Req 19.6)');
console.log(`  entries.length      : ${strippedKeys.entries.length} (staticCount ${strippedKeys.staticCount})`);
console.log(`  available           : ${strippedKeys.loadedAddressesAvailable}`);
for (const probe of [strippedKeys.staticCount, strippedKeys.staticCount + 21]) {
  const ref = resolveAccountRef(strippedKeys, probe);
  console.log(
    `  ref(${probe}) -> ${ref.kind}${ref.kind === 'unresolved' ? ` [${ref.confidence}] ${ref.reason}` : ''}`,
  );
}
