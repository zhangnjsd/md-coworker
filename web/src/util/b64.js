// Base64 <-> bytes helpers shared by crypto, Yjs transport and file IO.

const CHUNK = 0x8000

/** @param {Uint8Array} bytes */
export function bytesToB64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ''
  for (let i = 0; i < arr.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** @param {string} b64 */
export function b64ToBytes(b64) {
  const bin = atob(String(b64).trim())
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Normalize a pasted key file into a 32 byte Seed.
 * Tolerates surrounding whitespace/newlines, url-safe base64 and `data:` prefixes.
 * @param {string} raw
 * @returns {Uint8Array} 32 bytes
 */
export function parseSeed(raw) {
  const cleaned = String(raw ?? '')
    .replace(/^\s*data:[^,]*,/i, '')
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  if (!cleaned) throw new Error('请填写私钥')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) throw new Error('私钥格式不正确：应为 base64 编码的 32 字节 seed')
  let bytes
  try {
    bytes = b64ToBytes(cleaned)
  } catch {
    throw new Error('私钥格式不正确：无法按 base64 解码')
  }
  if (bytes.length !== 32) {
    throw new Error(`私钥长度不正确：期望 32 字节，实际 ${bytes.length} 字节`)
  }
  return bytes
}
