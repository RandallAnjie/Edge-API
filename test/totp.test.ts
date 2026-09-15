import assert from "node:assert/strict";
import { test } from "node:test";
import { totpCode, verifyTotp, generateTotpSecret, validateBackupCodeFormat, validateNumericCode } from "../src/totp.js";

test("totp generates 6 digits and verifies within window", async () => {
  const secret = generateTotpSecret();
  const code = await totpCode(secret);
  assert.match(code, /^\d{6}$/);
  assert.equal(await verifyTotp(secret, code), true);
  assert.equal(await verifyTotp(secret, "000000"), false);
});

test("original ValidateNumericCode and ValidateBackupCode formats", () => {
  assert.equal(validateNumericCode("123456"), "123456");
  assert.equal(validateNumericCode("12 3456"), "123456");
  assert.equal(validateNumericCode("12345"), null);
  assert.equal(validateNumericCode("12345a"), null);
  assert.equal(validateBackupCodeFormat("ABCD-1234"), true);
  assert.equal(validateBackupCodeFormat("abcd1234"), true);
  assert.equal(validateBackupCodeFormat("abc"), false);
  assert.equal(validateBackupCodeFormat("123456"), false);
});
