import assert from "node:assert/strict";
import { test } from "node:test";
import {
  totpCode,
  verifyTotp,
  generateTotpSecret,
  generateBackupCodes,
  generateQrCodeData,
  validateBackupCodeFormat,
  validateNumericCode,
} from "../src/totp.js";

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

test("original GenerateQRCodeData and GenerateBackupCodes formats", () => {
  const qr = generateQrCodeData("JBSWY3DPEHPK3PXP", "root", "New API");
  assert.equal(qr, "otpauth://totp/New API:root (New API)?secret=JBSWY3DPEHPK3PXP&issuer=New API&digits=6&period=30");
  const codes = generateBackupCodes();
  assert.equal(codes.length, 4);
  for (const code of codes) assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
});
