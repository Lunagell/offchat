/* ═══════════════════════════════════════════════════════════════════
   offchat — E2E Encryption Module
   AES-256-GCM via Web Crypto API
   Key NEVER leaves the browser. Server is blind.
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Generate a new AES-256-GCM key
 * @returns {Promise<CryptoKey>}
 */
export async function generateKey() {
    return crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt'],
    );
}

/**
 * Export CryptoKey → base64url string (for URL fragment)
 * @param {CryptoKey} key
 * @returns {Promise<string>}
 */
export async function exportKey(key) {
    const raw = await crypto.subtle.exportKey('raw', key);
    const bytes = new Uint8Array(raw);
    return uint8ToBase64url(bytes);
}

/**
 * Import base64url string → CryptoKey
 * @param {string} base64url
 * @returns {Promise<CryptoKey>}
 */
export async function importKey(base64url) {
    const raw = base64urlToUint8(base64url);
    return crypto.subtle.importKey(
        'raw',
        raw,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

/**
 * Encrypt plaintext string → { encrypted, iv } (both base64)
 * @param {CryptoKey} key
 * @param {string} plaintext
 * @returns {Promise<{encrypted: string, iv: string}>}
 */
export async function encrypt(key, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encoded,
    );

    return {
        encrypted: uint8ToBase64(new Uint8Array(ciphertext)),
        iv: uint8ToBase64(iv),
    };
}

/**
 * Decrypt { encrypted, iv } → plaintext string
 * @param {CryptoKey} key
 * @param {string} encryptedB64
 * @param {string} ivB64
 * @returns {Promise<string>}
 */
export async function decrypt(key, encryptedB64, ivB64) {
    const encrypted = base64ToUint8(encryptedB64);
    const iv = base64ToUint8(ivB64);

    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        encrypted,
    );

    return new TextDecoder().decode(decrypted);
}

/* ─── Encoding Helpers ────────────────────────────────────────────── */

function uint8ToBase64(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function base64ToUint8(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function uint8ToBase64url(bytes) {
    return uint8ToBase64(bytes)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function base64urlToUint8(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    return base64ToUint8(b64);
}
