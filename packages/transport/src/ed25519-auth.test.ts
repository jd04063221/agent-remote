import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildEd25519AuthHeader,
  deriveEd25519PublicKey,
  generateApiKey,
  generateEd25519Keypair,
} from "./ed25519-auth.js";
import { normalizeTailnetEndpoint } from "./tailnet-client.js";

function sshStr(buf: Buffer | string): Buffer {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length, 0);
  return Buffer.concat([len, b]);
}

function buildFakeUnencryptedOpenSshEd25519(seed: Buffer, rawPub: Buffer, comment: string): string {
  const pubBlob = Buffer.concat([sshStr("ssh-ed25519"), sshStr(rawPub)]);
  const check = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  let privSec = Buffer.concat([
    check,
    check,
    sshStr("ssh-ed25519"),
    sshStr(rawPub),
    sshStr(Buffer.concat([seed, rawPub])),
    sshStr(comment),
  ]);
  // Pad to 8-byte boundary (OpenSSH padding 1,2,3...)
  let pad = 1;
  while (privSec.length % 8 !== 0) {
    privSec = Buffer.concat([privSec, Buffer.from([pad++])]);
  }
  const count = Buffer.alloc(4);
  count.writeUInt32BE(1, 0);
  const full = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "ascii"),
    sshStr("none"),
    sshStr("none"),
    sshStr(Buffer.alloc(0)),
    count,
    sshStr(pubBlob),
    sshStr(privSec),
  ]);
  const b64 = full.toString("base64").replace(/(.{70})/g, "$1\n");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

describe("Ed25519 keypair auth & LAN/VPN endpoint normalization", () => {
  it("generates Ed25519 keypairs, signs canonical upgrade headers, and derives identical pubkey from OpenSSH PEM", () => {
    const kp = generateEd25519Keypair("office-lan");
    expect(kp.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(kp.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/=]+ office-lan$/);
    expect(kp.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);

    // Derive from PKCS#8 PEM matches identically
    const derived = deriveEd25519PublicKey(kp.privateKeyPem, "office-lan");
    expect(derived.publicKey).toBe(kp.publicKey);
    expect(derived.fingerprint).toBe(kp.fingerprint);

    // Build an unencrypted OpenSSH private key from the same seed & verify import
    const keyObj = crypto.createPrivateKey(kp.privateKeyPem);
    const pkcs8Der = keyObj.export({ type: "pkcs8", format: "der" }) as Buffer;
    const spkiDer = crypto.createPublicKey(keyObj).export({ type: "spki", format: "der" }) as Buffer;
    const seed = pkcs8Der.subarray(pkcs8Der.length - 32);
    const rawPub = spkiDer.subarray(spkiDer.length - 32);
    const openSshPem = buildFakeUnencryptedOpenSshEd25519(seed, rawPub, "imported-laptop");

    const fromOpenSsh = deriveEd25519PublicKey(openSshPem);
    expect(fromOpenSsh.fingerprint).toBe(kp.fingerprint);
    expect(fromOpenSsh.publicKey).toContain("imported-laptop");
    expect(fromOpenSsh.privateKeyPem).toBe(kp.privateKeyPem);

    // Signed Authorization header verifies with Node crypto.verify
    const header = buildEd25519AuthHeader(
      kp.privateKeyPem,
      "GET",
      "/v1/ws",
      1_795_000_000,
      "0123456789abcdef0123456789abcdef",
    );
    expect(header.startsWith("AR-Ed25519 ")).toBe(true);
    const params = Object.fromEntries(
      header
        .slice("AR-Ed25519 ".length)
        .split(",")
        .map((p) => p.split("=")),
    );
    const canonical = `agent-remote-auth-v1\nGET\n/v1/ws\n${params.ts}\n${params.nonce}\n${params.pub}`;
    const ok = crypto.verify(
      null,
      Buffer.from(canonical, "utf8"),
      crypto.createPublicKey(keyObj),
      Buffer.from(params.sig!, "base64url"),
    );
    expect(ok).toBe(true);
  });

  it("generates 256-bit API keys with ar_sk_ prefix", () => {
    const k1 = generateApiKey();
    const k2 = generateApiKey();
    expect(k1).toMatch(/^ar_sk_[A-Za-z0-9_-]{43}$/);
    expect(k1).not.toBe(k2);
  });

  it("normalizes LAN / OpenVPN IP:port endpoints to ws:// while keeping Tailnet hostnames on wss://", () => {
    expect(normalizeTailnetEndpoint("192.168.1.50:19420")).toBe("ws://192.168.1.50:19420/v1/ws");
    expect(normalizeTailnetEndpoint("10.8.0.2:19420")).toBe("ws://10.8.0.2:19420/v1/ws");
    expect(normalizeTailnetEndpoint("127.0.0.1:19420")).toBe("ws://127.0.0.1:19420/v1/ws");
    expect(normalizeTailnetEndpoint("192.168.1.50:443")).toBe("wss://192.168.1.50/v1/ws");
    expect(normalizeTailnetEndpoint("https://192.168.1.50:19420")).toBe("wss://192.168.1.50:19420/v1/ws");
    expect(normalizeTailnetEndpoint("box.tail123.ts.net")).toBe("wss://box.tail123.ts.net/v1/ws");
  });
});
