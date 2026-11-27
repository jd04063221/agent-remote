import crypto from "node:crypto";

const SSH_ED25519_TYPE = "ssh-ed25519";
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface Ed25519KeypairResult {
  privateKeyPem: string;
  publicKey: string;
  fingerprint: string;
}

function buildSshEd25519Blob(rawPub: Buffer): Buffer {
  if (rawPub.length !== 32) {
    throw new Error(`Expected 32-byte Ed25519 public key, got ${rawPub.length}`);
  }
  const typeBuf = Buffer.from(SSH_ED25519_TYPE, "ascii");
  const out = Buffer.alloc(4 + typeBuf.length + 4 + rawPub.length);
  out.writeUInt32BE(typeBuf.length, 0);
  typeBuf.copy(out, 4);
  out.writeUInt32BE(rawPub.length, 4 + typeBuf.length);
  rawPub.copy(out, 8 + typeBuf.length);
  return out;
}

function computeSshFingerprint(blob: Buffer): string {
  const hash = crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  return `SHA256:${hash}`;
}

function extractRawEd25519Pub(privKey: crypto.KeyObject): Buffer {
  if (privKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`Unsupported private key type "${privKey.asymmetricKeyType ?? "unknown"}" (expected Ed25519)`);
  }
  const spki = crypto.createPublicKey(privKey).export({ type: "spki", format: "der" }) as Buffer;
  return spki.subarray(spki.length - 32);
}

function readSshString(buf: Buffer, offset: number): { value: Buffer; next: number } {
  if (offset + 4 > buf.length) {
    throw new Error("Truncated OpenSSH key structure");
  }
  const len = buf.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + len;
  if (end > buf.length) {
    throw new Error("Invalid OpenSSH key field length");
  }
  return { value: buf.subarray(start, end), next: end };
}

function parseUnencryptedOpenSshEd25519(pem: string): {
  keyObj: crypto.KeyObject;
  embeddedComment?: string;
} {
  const b64 = pem
    .replace(/-----BEGIN OPENSSH PRIVATE KEY-----/g, "")
    .replace(/-----END OPENSSH PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const buf = Buffer.from(b64, "base64");
  const magic = "openssh-key-v1\0";
  if (buf.length < magic.length || buf.subarray(0, magic.length).toString("ascii") !== magic) {
    throw new Error("Invalid OpenSSH private key header");
  }
  let pos = magic.length;
  const cipher = readSshString(buf, pos);
  pos = cipher.next;
  if (cipher.value.toString("ascii") !== "none") {
    throw new Error(
      "Encrypted OpenSSH private keys with passphrases are not supported; use an unencrypted key or generate a dedicated Ed25519 keypair.",
    );
  }
  const kdf = readSshString(buf, pos);
  pos = kdf.next;
  const kdfOpts = readSshString(buf, pos);
  pos = kdfOpts.next;

  if (pos + 4 > buf.length) throw new Error("Truncated OpenSSH key count");
  const numKeys = buf.readUInt32BE(pos);
  pos += 4;
  if (numKeys < 1) throw new Error("OpenSSH key contains no key entries");

  // Skip public key blob
  const pubBlob = readSshString(buf, pos);
  pos = pubBlob.next;

  const privSec = readSshString(buf, pos).value;
  if (privSec.length < 8) throw new Error("Truncated OpenSSH private key section");
  const check1 = privSec.readUInt32BE(0);
  const check2 = privSec.readUInt32BE(4);
  if (check1 !== check2) {
    throw new Error("OpenSSH private key checksum mismatch");
  }
  let p = 8;
  const keyType = readSshString(privSec, p);
  p = keyType.next;
  if (keyType.value.toString("ascii") !== SSH_ED25519_TYPE) {
    throw new Error(
      `Unsupported OpenSSH key type "${keyType.value.toString("ascii")}" (expected ssh-ed25519)`,
    );
  }
  const pubRaw = readSshString(privSec, p);
  p = pubRaw.next;
  const privCombined = readSshString(privSec, p);
  p = privCombined.next;
  if (privCombined.value.length < 32) {
    throw new Error("Invalid OpenSSH Ed25519 private key length");
  }
  const commentStr = p + 4 <= privSec.length ? readSshString(privSec, p).value.toString("utf8").trim() : "";

  const seed = privCombined.value.subarray(0, 32);
  const pkcs8Der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const keyObj = crypto.createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
  return { keyObj, embeddedComment: commentStr || undefined };
}

function parseEd25519PrivateKey(input: string): {
  keyObj: crypto.KeyObject;
  embeddedComment?: string;
} {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Ed25519 private key is empty");
  }
  if (trimmed.includes("BEGIN OPENSSH PRIVATE KEY")) {
    return parseUnencryptedOpenSshEd25519(trimmed);
  }
  const keyObj = crypto.createPrivateKey(trimmed);
  if (keyObj.asymmetricKeyType !== "ed25519") {
    throw new Error(`Unsupported private key type "${keyObj.asymmetricKeyType ?? "unknown"}" (expected Ed25519)`);
  }
  return { keyObj };
}

function sanitizeComment(comment?: string): string {
  const cleaned = (comment ?? "").replace(/[\r\n;]+/g, " ").trim();
  return cleaned || "agent-remote";
}

/**
 * Generates a fresh Ed25519 keypair returning a PKCS#8 PEM private key and an
 * OpenSSH-compatible `ssh-ed25519 <base64> <comment>` public key line.
 */
export function generateEd25519Keypair(comment?: string): Ed25519KeypairResult {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const rawPub = extractRawEd25519Pub(privateKey);
  const blob = buildSshEd25519Blob(rawPub);
  const label = sanitizeComment(comment);
  return {
    privateKeyPem,
    publicKey: `${SSH_ED25519_TYPE} ${blob.toString("base64")} ${label}`,
    fingerprint: computeSshFingerprint(blob),
  };
}

/**
 * Validates and normalizes an imported Ed25519 private key (PKCS#8 PEM or
 * unencrypted OpenSSH PEM) and derives its OpenSSH-format public key line.
 */
export function deriveEd25519PublicKey(
  privateKeyInput: string,
  comment?: string,
): Ed25519KeypairResult {
  const { keyObj, embeddedComment } = parseEd25519PrivateKey(privateKeyInput);
  const privateKeyPem = keyObj.export({ type: "pkcs8", format: "pem" }).toString();
  const rawPub = extractRawEd25519Pub(keyObj);
  const blob = buildSshEd25519Blob(rawPub);
  const label = sanitizeComment(comment || embeddedComment);
  return {
    privateKeyPem,
    publicKey: `${SSH_ED25519_TYPE} ${blob.toString("base64")} ${label}`,
    fingerprint: computeSshFingerprint(blob),
  };
}

/**
 * Builds a single-use replay-protected `Authorization: AR-Ed25519 ...` header
 * matching `apps/remote-node/internal/auth/pubkey.go`.
 */
export function buildEd25519AuthHeader(
  privateKeyInput: string,
  method: string,
  urlPath: string,
  nowSec = Math.floor(Date.now() / 1000),
  nonceHex = crypto.randomBytes(16).toString("hex"),
): string {
  const { keyObj } = parseEd25519PrivateKey(privateKeyInput);
  const rawPub = extractRawEd25519Pub(keyObj);
  const pubB64Url = rawPub.toString("base64url");
  const tsStr = String(nowSec);
  const payload = `agent-remote-auth-v1\n${method.toUpperCase()}\n${urlPath}\n${tsStr}\n${nonceHex}\n${pubB64Url}`;
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), keyObj);
  const sigB64Url = sig.toString("base64url");
  return `AR-Ed25519 pub=${pubB64Url},ts=${tsStr},nonce=${nonceHex},sig=${sigB64Url}`;
}

/** Generates a cryptographically strong 256-bit Bearer API key (`ar_sk_...`). */
export function generateApiKey(): string {
  return `ar_sk_${crypto.randomBytes(32).toString("base64url")}`;
}
