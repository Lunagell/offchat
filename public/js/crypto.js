/* ═══════════════════════════════════════════════════════════════════
   offchat — E2E Encryption Module
   AES-256-GCM via Web Crypto API
   Key derived from room name + optional password — NEVER touches the server.
   ═══════════════════════════════════════════════════════════════════ */

const SALT = 'offchat-e2e-v1'; // fixed salt for key derivation
const ITERATIONS = 100_000;

/**
 * Derive AES-256-GCM key from room name + optional password using PBKDF2
 * Same room name + password → same key (both sides can encrypt/decrypt)
 * @param {string} roomName
 * @param {string} [password='']
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(roomName, password = '') {
    const encoder = new TextEncoder();

    // Combine room name and password for key material
    const keySource = password ? `${roomName}:${password}` : roomName;

    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(keySource),
        'PBKDF2',
        false,
        ['deriveKey'],
    );

    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: encoder.encode(SALT),
            iterations: ITERATIONS,
            hash: 'SHA-256',
        },
        keyMaterial,
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

/**
 * Encrypt binary file → { encrypted, iv } (both base64)
 * @param {CryptoKey} key
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<{encrypted: string, iv: string}>}
 */
export async function encryptFile(key, arrayBuffer) {
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        arrayBuffer,
    );

    return {
        encrypted: uint8ToBase64(new Uint8Array(ciphertext)),
        iv: uint8ToBase64(iv),
    };
}

/**
 * Decrypt → ArrayBuffer (for file download)
 * @param {CryptoKey} key
 * @param {string} encryptedB64
 * @param {string} ivB64
 * @returns {Promise<ArrayBuffer>}
 */
export async function decryptFile(key, encryptedB64, ivB64) {
    const encrypted = base64ToUint8(encryptedB64);
    const iv = base64ToUint8(ivB64);

    return crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        encrypted,
    );
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
