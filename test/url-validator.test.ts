import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTrustedRedirectDomains, validateRedirectURL } from "../src/url-validator.js";

test("original TRUSTED_REDIRECT_DOMAINS parsing trims, drops empties, lowercases", () => {
  assert.deepEqual(parseTrustedRedirectDomains(""), []);
  assert.deepEqual(parseTrustedRedirectDomains(undefined), []);
  assert.deepEqual(parseTrustedRedirectDomains(" example.com, Sub.Example.ORG ,"), ["example.com", "sub.example.org"]);
});

test("original ValidateRedirectURL JSON-adjacent error cases", () => {
  const trusted = ["example.com"];
  assert.equal(validateRedirectURL("https://example.com/success", trusted), null);
  assert.equal(validateRedirectURL("http://example.com/callback", trusted), null);
  assert.equal(validateRedirectURL("https://sub.example.com/success", trusted), null);
  assert.equal(validateRedirectURL("https://EXAMPLE.COM/success", trusted), null);

  const untrusted = validateRedirectURL("https://evil.com/phishing", trusted);
  assert.ok(untrusted);
  assert.match(untrusted.message, /not in the trusted domains list/);

  const suffix = validateRedirectURL("https://fakeexample.com/success", trusted);
  assert.ok(suffix);
  assert.match(suffix.message, /not in the trusted domains list/);

  const emptyList = validateRedirectURL("https://example.com/success", []);
  assert.ok(emptyList);
  assert.match(emptyList.message, /not in the trusted domains list/);

  const javascript = validateRedirectURL("javascript:alert('xss')", trusted);
  assert.ok(javascript);
  assert.match(javascript.message, /invalid URL scheme/);

  const data = validateRedirectURL("data:text/html,<script>alert('xss')</script>", trusted);
  assert.ok(data);
  assert.match(data.message, /invalid URL scheme/);

  const empty = validateRedirectURL("", trusted);
  assert.ok(empty);
  assert.match(empty.message, /invalid URL scheme/);
});
