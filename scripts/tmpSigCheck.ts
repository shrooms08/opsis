import bs58 from 'bs58';

import { validateSignature } from '../src/signature.js';

const real = '4MqxZnZ3VXjTK1zARqA5Z6k4MupZkHESTM7kJX3itwc7NLWWZAbdpeKiwcYrRRPPtT4hDYr8W34WmAFKpmK4Gfwj';

console.log('real chars:', real.length, 'bytes:', bs58.decode(real).length);
console.log('real       ->', JSON.stringify(validateSignature(real)));
console.log('truncated  ->', JSON.stringify(validateSignature(real.slice(0, -2))));
console.log('non-base58 ->', JSON.stringify(validateSignature(`${real.slice(0, -1)}0`)));
console.log('empty      ->', JSON.stringify(validateSignature('')));

// A 64-byte signature with leading zero bytes: 86 characters, not 88, so a
// character-count check would reject it.
const leadingZeroes = bs58.encode(new Uint8Array(64).fill(255, 2));
console.log('leading-zero chars:', leadingZeroes.length);
console.log('leading-zero ->', JSON.stringify(validateSignature(leadingZeroes)));

// 65 bytes can still encode to 88 characters, so a character-count check would
// accept it.
const sixtyFive = bs58.encode(new Uint8Array(65).fill(1));
console.log('65-byte chars:', sixtyFive.length);
console.log('65-byte ->', JSON.stringify(validateSignature(sixtyFive)));
