/** RSA-2048 PKCS#8 / SPKI Base64 pair matching waffo-go key format. */
export async function generateWaffoTestKeyPair(): Promise<{ privateKey: string; publicKey: string }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  return {
    privateKey: Buffer.from(pkcs8).toString("base64"),
    publicKey: Buffer.from(spki).toString("base64"),
  };
}

/** Original pancake SDK `t=<millis>,v1=<base64>` webhook signature. */
export async function signPancakeWebhook(payload: string, privateKeyBase64: string, tsMillis = Date.now()): Promise<string> {
  const der = Buffer.from(privateKeyBase64, "base64");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${tsMillis}.${payload}`));
  return `t=${tsMillis},v1=${Buffer.from(sig).toString("base64")}`;
}
