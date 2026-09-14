import assert from "node:assert/strict";
import { test } from "node:test";
import { PasskeyDomainError, normalizePasskeyRPID } from "../src/passkey-domains.js";
import { effectiveTLDPlusOne, publicSuffix } from "../src/passkey-publicsuffix.js";

function invalid(value: string, origins: string[] = []): void {
  assert.throws(
    () => normalizePasskeyRPID(value, origins),
    (err: unknown) => err instanceof PasskeyDomainError && err.code === "PASSKEY_RP_ID_INVALID",
  );
}

test("golang.org/x/net publicsuffix matches original EffectiveTLDPlusOne cases", () => {
  const cases: { domain: string; suffix: string; icann: boolean; etld: string | null }[] = [
    { domain: "co.uk", suffix: "co.uk", icann: true, etld: null },
    { domain: "example.co.uk", suffix: "co.uk", icann: true, etld: "example.co.uk" },
    { domain: "www.example.co.uk", suffix: "co.uk", icann: true, etld: "example.co.uk" },
    { domain: "github.io", suffix: "github.io", icann: false, etld: null },
    { domain: "foo.github.io", suffix: "github.io", icann: false, etld: "foo.github.io" },
    { domain: "pages.dev", suffix: "pages.dev", icann: false, etld: null },
    { domain: "foo.pages.dev", suffix: "pages.dev", icann: false, etld: "foo.pages.dev" },
    { domain: "com", suffix: "com", icann: true, etld: null },
    { domain: "intranet", suffix: "intranet", icann: false, etld: null },
    { domain: "localhost", suffix: "localhost", icann: false, etld: null },
    { domain: "example.com", suffix: "com", icann: true, etld: "example.com" },
    { domain: "www.example.com", suffix: "com", icann: true, etld: "example.com" },
    { domain: "xn--mnchen-3ya.de", suffix: "de", icann: true, etld: "xn--mnchen-3ya.de" },
    { domain: "child.intranet", suffix: "intranet", icann: false, etld: "child.intranet" },
    { domain: "blogspot.com", suffix: "blogspot.com", icann: false, etld: null },
    { domain: "foo.blogspot.com", suffix: "blogspot.com", icann: false, etld: "foo.blogspot.com" },
    { domain: "com.au", suffix: "com.au", icann: true, etld: null },
    { domain: "example.com.au", suffix: "com.au", icann: true, etld: "example.com.au" },
    { domain: "kobe.jp", suffix: "jp", icann: true, etld: "kobe.jp" },
    { domain: "city.kobe.jp", suffix: "kobe.jp", icann: true, etld: "city.kobe.jp" },
    { domain: "foo.kobe.jp", suffix: "foo.kobe.jp", icann: true, etld: null },
    { domain: "uk.com", suffix: "uk.com", icann: false, etld: null },
    { domain: "example.uk.com", suffix: "uk.com", icann: false, etld: "example.uk.com" },
  ];
  for (const tc of cases) {
    const got = publicSuffix(tc.domain);
    assert.equal(got.suffix, tc.suffix, tc.domain + " suffix");
    assert.equal(got.icann, tc.icann, tc.domain + " icann");
    assert.equal(effectiveTLDPlusOne(tc.domain), tc.etld, tc.domain + " etld");
  }
});

test("original NormalizePasskeyRPID publicsuffix and IDNA JSON cases", () => {
  assert.equal(normalizePasskeyRPID("example.com"), "example.com");
  assert.equal(normalizePasskeyRPID("www.example.com"), "www.example.com");
  assert.equal(normalizePasskeyRPID("example.co.uk"), "example.co.uk");
  assert.equal(normalizePasskeyRPID("foo.github.io"), "foo.github.io");
  assert.equal(normalizePasskeyRPID("child.intranet"), "child.intranet");
  assert.equal(normalizePasskeyRPID("localhost"), "localhost");
  assert.equal(normalizePasskeyRPID("localhost", ["http://localhost:3000"]), "localhost");
  assert.equal(normalizePasskeyRPID("intranet", ["https://intranet:8443"]), "intranet");
  assert.equal(normalizePasskeyRPID("münchen.de"), "xn--mnchen-3ya.de");
  assert.equal(normalizePasskeyRPID("München.DE"), "xn--mnchen-3ya.de");
  assert.equal(normalizePasskeyRPID("city.kobe.jp"), "city.kobe.jp");
  assert.equal(normalizePasskeyRPID("kobe.jp"), "kobe.jp");

  invalid("co.uk");
  invalid("github.io");
  invalid("pages.dev");
  invalid("com");
  invalid("com", ["https://com"]);
  invalid("blogspot.com");
  invalid("uk.com");
  invalid("foo.kobe.jp");
  invalid("ab--cd.com");
  invalid("foo_bar.com");
  invalid("127.0.0.1", ["https://127.0.0.1"]);
  invalid("intranet:8443", ["https://intranet:8443"]);
  invalid("https://example.com");
  invalid("localhost:3000");
  invalid("intranet", ["https://child.intranet"]);
  invalid("intranet", ["http://intranet"]);
  invalid("intranet");
});
