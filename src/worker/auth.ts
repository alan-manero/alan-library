// Session handling for the single-user password login.
//
// How it works, in plain terms:
// 1. You type the password (stored as the APP_PASSWORD secret).
// 2. If correct, the server gives your browser a signed "session token" cookie.
//    The signature is created with APP_AUTH_SECRET, so nobody can forge it.
// 3. Every later request checks that cookie. No database needed.

const COOKIE_NAME = "alan_session";
const SESSION_DAYS = 30;

function hexEncode(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function signExpiry(expiresAtMs: number, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`alan-session:${expiresAtMs}`)
  );
  return hexEncode(signature);
}

/** Constant-time string comparison to avoid leaking information via timing. */
export function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

export async function createSessionToken(secret: string): Promise<string> {
  const expiresAtMs = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const signature = await signExpiry(expiresAtMs, secret);
  return `${expiresAtMs}.${signature}`;
}

export async function isValidSessionToken(
  token: string | undefined,
  secret: string
): Promise<boolean> {
  if (!token) return false;
  const [expiresPart, signaturePart] = token.split(".");
  if (!expiresPart || !signaturePart) return false;
  const expiresAtMs = Number(expiresPart);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) return false;
  const expected = await signExpiry(expiresAtMs, secret);
  return safeEqual(signaturePart, expected);
}

export const SESSION_COOKIE = COOKIE_NAME;
export const SESSION_MAX_AGE_SECONDS = SESSION_DAYS * 24 * 60 * 60;
