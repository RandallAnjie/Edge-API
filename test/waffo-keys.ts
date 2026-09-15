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
