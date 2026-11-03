// Base64 <-> bytes helpers shared by crypto, Yjs transport and file IO.

const CHUNK = 0x8000;

/** @param {Uint8Array} bytes */
export function bytesToB64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** @param {string} b64 */
export function b64ToBytes(b64) {
  const bin = atob(String(b64).trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Prefix of the printable key format: `mc1-<base64 seed>-<crc32>`. */
const KEY_TEXT_PREFIX = "mc1-";

/** CRC-32 (IEEE) over the seed bytes; same algorithm as the server. */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** @param {Uint8Array} seed */
function checksum(seed) {
  return crc32(seed).toString(16).padStart(8, "0");
}

/** Format a 32 byte seed as the `mc1-…` text users copy around. */
export function formatKeyTextLines(seed) {
  return `${KEY_TEXT_PREFIX}${bytesToB64(seed)}-${checksum(seed)}`;
}

/**
 * Normalize a pasted key file into a 32 byte Seed.
 * Tolerates surrounding whitespace/newlines, url-safe base64 and `data:` prefixes.
 * @param {string} raw
 * @returns {Uint8Array} 32 bytes
 */
export function parseSeed(raw) {
  let text = String(raw ?? "")
    .replace(/^\s*data:[^,]*,/i, "")
    .trim();
  // The printable form carries a checksum: verify it before anything else, so a key that
  // was cut short while copying is reported as such instead of as a bad signature.
  if (text.startsWith(KEY_TEXT_PREFIX)) {
    const body = text.slice(KEY_TEXT_PREFIX.length);
    const cut = body.lastIndexOf("-");
    if (cut < 0) throw new Error("私钥格式不正确：应为 mc1-<base64>-<校验码>");
    const seedPart = body.slice(0, cut);
    const expected = body
      .slice(cut + 1)
      .trim()
      .toLowerCase();
    let bytes;
    try {
      bytes = b64ToBytes(seedPart.replace(/-/g, "+").replace(/_/g, "/"));
    } catch {
      throw new Error("私钥格式不正确：无法按 base64 解码");
    }
    if (bytes.length !== 32) {
      throw new Error(
        `私钥长度不正确：期望 32 字节，实际 ${bytes.length} 字节`,
      );
    }
    if (expected !== checksum(bytes)) {
      throw new Error("私钥校验码不匹配：复制可能不完整，请重新复制");
    }
    return bytes;
  }
  const cleaned = text
    .replace(/^\s*data:[^,]*,/i, "")
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  if (!cleaned) throw new Error("请填写私钥");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned))
    throw new Error("私钥格式不正确：应为 base64 编码的 32 字节 seed");
  let bytes;
  try {
    bytes = b64ToBytes(cleaned);
  } catch {
    throw new Error("私钥格式不正确：无法按 base64 解码");
  }
  if (bytes.length !== 32) {
    throw new Error(`私钥长度不正确：期望 32 字节，实际 ${bytes.length} 字节`);
  }
  return bytes;
}
