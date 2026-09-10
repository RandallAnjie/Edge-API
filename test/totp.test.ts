import assert from "node:assert/strict";
import { test } from "node:test";
import { totpCode, verifyTotp, generateTotpSecret } from "../src/totp.js";

test("totp generates 6 digits and verifies within window", async () => {
  const secret = generateTotpSecret();
  const code = await totpCode(secret);
  assert.match(code, /^\d{6}$/);
  assert.equal(await verifyTotp(secret, code), true);
  assert.equal(await verifyTotp(secret, "000000"), false);
});
