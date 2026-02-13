/* ═══════════════════════════════════════════════════════════════════
   offchat — Landing Page Logic
   Navigate to room — key is derived from room name (no URL hash)
   ═══════════════════════════════════════════════════════════════════ */

const input = document.getElementById('room-input');
const goBtn = document.getElementById('go-btn');
const container = document.getElementById('input-container');

const ROOM_RE = /^[a-zA-Z0-9_-]+$/;

function goToRoom() {
    const roomName = input.value.trim();
    if (!roomName || !ROOM_RE.test(roomName)) return;

    // Navigate — encryption key will be derived from room name
    location.href = `/${roomName}`;
}

// Input validation
input.addEventListener('input', () => {
    input.value = input.value.replace(/[^a-zA-Z0-9_-]/g, '');
    goBtn.disabled = input.value.trim().length === 0;
});

// Enter to submit
input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goToRoom();
});

// Button click
goBtn.addEventListener('click', goToRoom);
