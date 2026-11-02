//! Cryptographic primitives.
//!
//! ## About the requested "AES 512"
//!
//! AES is only defined for 128 / 192 / 256-bit keys; **AES-512 does not exist**. This
//! project reads the requirement as "as strong as possible, with 512-bit key material"
//! and implements it as:
//!
//! * Master key: 512-bit (64-byte) random material in `data/master.key`, mode 0600.
//! * Data key derivation: HKDF-SHA512 (512-bit PRK expansion), from which 256 bits are
//!   taken as the AES-256-GCM content-encryption key.
//! * Integrity: GCM brings a built-in 128-bit authentication tag, so any tampering
//!   fails decryption.
//!
//! This keeps the intent (512-bit entropy + SHA-512 derivation) while staying with a
//! standard AES implementation (`aes-gcm` from RustCrypto). All sensitive data written
//! to disk (TOTP seeds, CRDT snapshots) is encrypted with it.
//!
//! ## Authentication
//!
//! Users log in with an Ed25519 key pair via challenge-response, so no secret is ever
//! sent over the wire. The server stores only public keys, and private keys are handed
//! out once when a user is created or reset.

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signature, SigningKey, VerifyingKey};
use hmac::{Hmac, Mac};
use rand::Rng;
use sha1::Sha1;
use sha2::Sha512;
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha1 = Hmac<Sha1>;
type HmacSha512 = Hmac<Sha512>;

// ---------------------------------------------------------------- HKDF-SHA512

/// HKDF (RFC 5869) over SHA-512, which is why the intermediate key material is 512 bit.
fn hkdf_sha512(salt: &[u8], ikm: &[u8], info: &[u8], len: usize) -> Vec<u8> {
    let mut extract = HmacSha512::new_from_slice(salt).expect("HMAC 接受任意长度密钥");
    extract.update(ikm);
    let prk = extract.finalize().into_bytes();

    let mut okm = Vec::with_capacity(len);
    let mut previous: Vec<u8> = Vec::new();
    let mut counter: u8 = 1;
    while okm.len() < len {
        let mut expand = HmacSha512::new_from_slice(&prk).expect("HMAC 接受任意长度密钥");
        expand.update(&previous);
        expand.update(info);
        expand.update(&[counter]);
        previous = expand.finalize().into_bytes().to_vec();
        okm.extend_from_slice(&previous);
        counter = counter.wrapping_add(1);
    }
    okm.truncate(len);
    okm
}

// ---------------------------------------------------------------- AES-256-GCM

/// AEAD encryptor (AES-256-GCM) keyed from the 512-bit master key.
#[derive(Clone)]
pub struct Cipher {
    key: [u8; 32],
}

impl std::fmt::Debug for Cipher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Cipher(aes-256-gcm)")
    }
}

impl Cipher {
    pub fn from_master(master: &[u8]) -> Self {
        let derived = hkdf_sha512(b"md-coworker/aes512", master, b"aes-256-gcm/data-key", 32);
        let mut key = [0u8; 32];
        key.copy_from_slice(&derived);
        Self { key }
    }

    /// Encrypt. Output is `12-byte nonce || ciphertext || 16-byte tag`.
    pub fn seal(&self, aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
        let cipher = Aes256Gcm::new_from_slice(&self.key).context("初始化 AES-256-GCM 失败")?;
        let mut nonce_bytes = [0u8; 12];
        rand::rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::try_from(&nonce_bytes[..]).expect("nonce 长度固定为 12 字节");
        let ciphertext = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .map_err(|_| anyhow!("AES-256-GCM 加密失败"))?;
        let mut out = Vec::with_capacity(12 + ciphertext.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }

    pub fn open(&self, aad: &[u8], blob: &[u8]) -> Result<Vec<u8>> {
        if blob.len() < 12 + 16 {
            bail!("密文长度非法");
        }
        let (nonce_bytes, body) = blob.split_at(12);
        let nonce = Nonce::try_from(nonce_bytes).map_err(|_| anyhow!("密文 nonce 长度非法"))?;
        let cipher = Aes256Gcm::new_from_slice(&self.key).context("初始化 AES-256-GCM 失败")?;
        cipher
            .decrypt(&nonce, Payload { msg: body, aad })
            .map_err(|_| anyhow!("AES-256-GCM 解密或完整性校验失败"))
    }
}

// ---------------------------------------------------------------- randomness

pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    rand::rng().fill_bytes(&mut buf);
    buf
}

/// URL-safe session token (256 bit).
pub fn random_token() -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    URL_SAFE_NO_PAD.encode(random_bytes(32))
}

// ---------------------------------------------------------------- Ed25519

/// Generate an Ed25519 key pair as `(base64 seed, base64 public key)`.
/// The private key is just the 32-byte seed the client feeds to
/// `nacl.sign.keyPair.fromSeed`.
pub fn generate_keypair() -> (String, String) {
    let mut seed = [0u8; 32];
    rand::rng().fill_bytes(&mut seed);
    let signing = SigningKey::from_bytes(&seed);
    let public = signing.verifying_key();
    (B64.encode(seed), B64.encode(public.to_bytes()))
}

pub fn verifying_key_from_b64(public_key_b64: &str) -> Result<VerifyingKey> {
    let raw = B64
        .decode(public_key_b64.trim())
        .context("公钥 base64 非法")?;
    let bytes: [u8; 32] = raw
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("公钥长度必须是 32 字节"))?;
    VerifyingKey::from_bytes(&bytes).context("公钥不是合法的 Ed25519 曲线点")
}

/// Verify a signature; anything malformed simply yields `false`.
pub fn verify_signature(public_key_b64: &str, message: &[u8], signature_b64: &str) -> bool {
    let Ok(key) = verifying_key_from_b64(public_key_b64) else {
        return false;
    };
    let Ok(raw) = B64.decode(signature_b64.trim()) else {
        return false;
    };
    let Ok(bytes) = <[u8; 64]>::try_from(raw.as_slice()) else {
        return false;
    };
    let signature = Signature::from_bytes(&bytes);
    key.verify_strict(message, &signature).is_ok()
}

/// Sign with a base64-encoded seed. Only used by the unit tests, which need to
/// produce a signature the way the browser client does.
#[cfg(test)]
fn sign_with_seed_b64(seed_b64: &str, message: &[u8]) -> Result<String> {
    use ed25519_dalek::Signer;

    let raw = B64.decode(seed_b64.trim()).context("私钥 base64 非法")?;
    let seed: [u8; 32] = raw
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("私钥 seed 长度必须是 32 字节"))?;
    let signing = SigningKey::from_bytes(&seed);
    Ok(B64.encode(signing.sign(message).to_bytes()))
}

// ---------------------------------------------------------------- Base32 / TOTP

const BASE32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

pub fn base32_encode(data: &[u8]) -> String {
    let mut out = String::new();
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for &byte in data {
        buffer = (buffer << 8) | byte as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let index = ((buffer >> bits) & 0x1f) as usize;
            out.push(BASE32_ALPHABET[index] as char);
        }
    }
    if bits > 0 {
        let index = ((buffer << (5 - bits)) & 0x1f) as usize;
        out.push(BASE32_ALPHABET[index] as char);
    }
    out
}

pub fn base32_decode(text: &str) -> Result<Vec<u8>> {
    let cleaned: Vec<u8> = text
        .bytes()
        .filter(|b| !b.is_ascii_whitespace() && *b != b'=')
        .map(|b| b.to_ascii_uppercase())
        .collect();
    let mut out = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for byte in cleaned {
        let value = BASE32_ALPHABET
            .iter()
            .position(|c| *c == byte)
            .ok_or_else(|| anyhow!("非法 base32 字符: {}", byte as char))?
            as u32;
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

/// Generate a random 32-byte TOTP seed (base32, unpadded, 160 bit of entropy).
pub fn generate_totp_secret() -> String {
    base32_encode(&random_bytes(20))
}

/// RFC 6238 TOTP: SHA-1, 6 digits, 30-second steps.
pub fn totp_code(secret: &[u8], counter: u64) -> String {
    let mut mac = HmacSha1::new_from_slice(secret).expect("HMAC 接受任意长度密钥");
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[19] & 0x0f) as usize;
    let binary = ((digest[offset] as u32 & 0x7f) << 24)
        | ((digest[offset + 1] as u32) << 16)
        | ((digest[offset + 2] as u32) << 8)
        | (digest[offset + 3] as u32);
    format!("{:06}", binary % 1_000_000)
}

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Verify a TOTP code, tolerating one time step of clock skew (plus or minus 30s).
pub fn verify_totp(secret: &[u8], code: &str) -> bool {
    let code = code.trim();
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let step = now_unix() / 30;
    for delta in [-1i64, 0, 1] {
        let counter = (step as i64 + delta).max(0) as u64;
        let expected = totp_code(secret, counter);
        // Constant-time comparison, so there is no timing side channel.
        if expected
            .as_bytes()
            .iter()
            .zip(code.as_bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
        {
            return true;
        }
    }
    false
}

/// `otpauth://` URL for the client to render as a QR code.
pub fn otpauth_url(issuer: &str, account: &str, secret_b32: &str) -> String {
    format!(
        "otpauth://totp/{}:{}?secret={}&issuer={}&algorithm=SHA1&digits=6&period=30",
        urlencode(issuer),
        urlencode(account),
        secret_b32,
        urlencode(issuer)
    )
}

fn urlencode(input: &str) -> String {
    percent_encoding::utf8_percent_encode(input, percent_encoding::NON_ALPHANUMERIC).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hkdf_outputs_full_length() {
        let out = hkdf_sha512(b"salt", b"ikm", b"info", 64);
        assert_eq!(out.len(), 64);
        assert_ne!(out, hkdf_sha512(b"salt", b"ikm", b"other", 64));
    }

    #[test]
    fn aes_roundtrip_and_tamper_detection() {
        let cipher = Cipher::from_master(&[7u8; 64]);
        let sealed = cipher.seal(b"aad", b"hello world").unwrap();
        assert_eq!(cipher.open(b"aad", &sealed).unwrap(), b"hello world");
        assert!(cipher.open(b"other-aad", &sealed).is_err());
        let mut tampered = sealed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xff;
        assert!(cipher.open(b"aad", &tampered).is_err());
    }

    #[test]
    fn ed25519_sign_verify() {
        let (seed, public) = generate_keypair();
        let signature = sign_with_seed_b64(&seed, b"nonce").unwrap();
        assert!(verify_signature(&public, b"nonce", &signature));
        assert!(!verify_signature(&public, b"other", &signature));
    }

    #[test]
    fn base32_roundtrip() {
        let data = b"hello base32 world";
        let encoded = base32_encode(data);
        assert_eq!(base32_decode(&encoded).unwrap(), data);
    }

    #[test]
    fn totp_matches_rfc6238_vectors() {
        // RFC 6238 appendix B: secret "12345678901234567890" (SHA-1), T=59s -> 94287082
        let secret = b"12345678901234567890";
        assert_eq!(totp_code(secret, 59 / 30), "287082");
    }
}
