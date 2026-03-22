# Agent World SDK — Final Bug Fixes (BUG-2, BUG-4, BUG-5, BUG-6)

## Summary

Four remaining bugs in `packages/agent-world-sdk/src/`. BUG-1 (broadcast leak) and BUG-3 (key rotation) are already fixed. This report covers all four remaining bugs as a single batch.

## Priority Item

Fix base58 codec, domain separator mismatch, ledger dead code, and Fastify reply pattern in `packages/agent-world-sdk/src/`.

## Bugs to Fix

### BUG-2 [MEDIUM] — base58Encode/Decode incorrect for leading-zero byte inputs

**Files to change:**
- `packages/agent-world-sdk/src/identity.ts` — `base58Encode` function (around line 12)
- `packages/agent-world-sdk/src/peer-protocol.ts` — `base58Decode` function (around line 343)

**Problem:** `base58Encode` starts with `digits = [0]` and always emits all digits including trailing zeros. This causes `Buffer.from([0])` to encode as `"11"` instead of `"1"`. The decode has the mirror issue.

**Fix for base58Encode in identity.ts:** After the main encoding loop, skip trailing zero digits (which are high-order zeros in big-endian) before emitting characters. Replace the final output loop:

```typescript
// CURRENT (broken):
for (let i = digits.length - 1; i >= 0; i--) str += BASE58_ALPHABET[digits[i]]

// FIXED:
let k = digits.length - 1
while (k >= 0 && digits[k] === 0) k--
for (let i = k; i >= 0; i--) str += BASE58_ALPHABET[digits[i]]
```

**Fix for base58Decode in peer-protocol.ts:** Replace the leading-zeros handling at the end of the function:

```typescript
// CURRENT (broken):
for (const char of str) {
  if (char === "1") bytes.push(0);
  else break;
}
return new Uint8Array(bytes.reverse());

// FIXED:
let leadingOnes = 0;
for (const char of str) {
  if (char === "1") leadingOnes++;
  else break;
}
let k = bytes.length - 1;
while (k >= 0 && bytes[k] === 0) k--;
const numericBytes = bytes.slice(0, k + 1).reverse();
const result = new Uint8Array(leadingOnes + numericBytes.length);
result.set(numericBytes, leadingOnes);
return result;
```

**Required tests:** Add a new test file `test/base58.test.mjs` with these cases:
- encode `[0]` → `"1"`, decode `"1"` → `[0]`
- encode `[0,0]` → `"11"`, decode `"11"` → `[0,0]`
- encode `[0,1]` → `"12"` (unchanged)
- encode `[1]` → `"2"` (unchanged)
- encode `[1,0]` → `"5R"` (unchanged)
- Round-trip: encode(x) then decode gives back x for all above
- `deriveDidKey` and `toPublicKeyMultibase` still work correctly after the fix

---

### BUG-4 [LOW] — world.state body signature uses wrong domain separator

**File to change:** `packages/agent-world-sdk/src/world-server.ts` — in `broadcastWorldState()` function

**Problem:** Body signature uses `DOMAIN_SEPARATORS.WORLD_STATE` but the receiver `/peer/message` verifies with `DOMAIN_SEPARATORS.MESSAGE`.

**Fix:** Change one line in `broadcastWorldState()`:
```typescript
// BEFORE:
payload["signature"] = signWithDomainSeparator(
  DOMAIN_SEPARATORS.WORLD_STATE,
  payload,
  identity.secretKey
);

// AFTER:
payload["signature"] = signWithDomainSeparator(
  DOMAIN_SEPARATORS.MESSAGE,
  payload,
  identity.secretKey
);
```

---

### BUG-5 [LOW] — LEDGER_DOMAIN dead code + LEDGER_SEPARATOR fragile construction

**File to change:** `packages/agent-world-sdk/src/world-ledger.ts` — lines 9-10

**Problem:** `LEDGER_DOMAIN` declared but never used. `LEDGER_SEPARATOR` derived by string-splitting instead of using `PROTOCOL_VERSION`.

**Fix:**
1. Add import: `import { PROTOCOL_VERSION } from "./version.js"` at the top
2. Delete the `LEDGER_DOMAIN` line entirely
3. Replace `LEDGER_SEPARATOR` with: `const LEDGER_SEPARATOR = \`AgentWorld-Ledger-${PROTOCOL_VERSION}\\0\``

**IMPORTANT:** The resulting LEDGER_SEPARATOR string value MUST be identical to what it was before (same bytes). Verify by checking that `DOMAIN_SEPARATORS.MESSAGE.split("-")[2]` equals `PROTOCOL_VERSION + "\0"`. The existing WorldLedger tests must still pass unchanged.

---

### BUG-6 [LOW] — Fastify async handler returns undefined after reply.send()

**File to change:** `packages/agent-world-sdk/src/peer-protocol.ts` — in the `/peer/message` handler, around line 223

**Problem:** After `onMessage` calls `sendReply` (which calls `reply.send()`), the async handler implicitly returns `undefined`.

**Fix:** Add `return reply;` after the `if (!replied)` block:
```typescript
if (!replied) return { ok: true };
return reply;
```

---

## Validation

After all fixes:
1. `npm --prefix packages/agent-world-sdk run build` must succeed
2. `npm run build` (root) must succeed  
3. `node --test test/*.test.mjs` must pass all tests
4. The new `test/base58.test.mjs` must pass
