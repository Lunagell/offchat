/* ═══════════════════════════════════════════════════════════════════
   offchat — Landing Page Logic
   Generate encryption key + navigate to room
   ═══════════════════════════════════════════════════════════════════ */

import { generateKey, exportKey } from './crypto.js';

const input = document.getElementById('room-input');
const goBtn = document.getElementById('go-btn');
const container = document.getElementById('input-container');

// Valid room name chars only
const ROOM_RE = /^[a-zA-Z0-9_-]+$/;

async function createRoom() {
    const roomName = input.value.trim();
    if (!roomName || !ROOM_RE.test(roomName)) return;

    // Disable input during key generation
    input.disabled = true;
    goBtn.disabled = true;
    container.style.opacity = '0.5';

    // Generate AES-256 encryption key
    const key = await generateKey();
    const keyStr = await exportKey(key);

    // Navigate — key goes in fragment (never sent to server)
    location.href = `/${roomName}#${keyStr}`;
}

// Input validation
input.addEventListener('input', () => {
    // Strip invalid characters
    input.value = input.value.replace(/[^a-zA-Z0-9_-]/g, '');
    goBtn.disabled = input.value.trim().length === 0;
});

// Enter to submit
input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createRoom();
});

// Button click
goBtn.addEventListener('click', createRoom);
