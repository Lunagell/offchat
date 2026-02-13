/* ═══════════════════════════════════════════════════════════════════
   offchat — Landing Page Logic
   Navigate to room — password & duration stored in sessionStorage
   ═══════════════════════════════════════════════════════════════════ */

const input = document.getElementById('room-input');
const goBtn = document.getElementById('go-btn');
const container = document.getElementById('input-container');
const passwordToggle = document.getElementById('password-toggle');
const passwordToggleText = document.getElementById('password-toggle-text');
const passwordField = document.getElementById('password-field');
const passwordInput = document.getElementById('password-input');
const passwordVisibility = document.getElementById('password-visibility');
const eyeOpen = document.getElementById('eye-open');
const eyeClosed = document.getElementById('eye-closed');
const durationBtns = document.querySelectorAll('.duration-btn');

const ROOM_RE = /^[a-zA-Z0-9_-]+$/;
let passwordEnabled = false;
let selectedDuration = 10; // default 10 minutes

function goToRoom() {
    const roomName = input.value.trim();
    if (!roomName || !ROOM_RE.test(roomName)) return;

    const password = passwordEnabled ? passwordInput.value : '';

    // Store password in sessionStorage (per-tab, never persisted, never sent to server)
    if (password) {
        sessionStorage.setItem(`offchat_pwd_${roomName}`, password);
    } else {
        sessionStorage.removeItem(`offchat_pwd_${roomName}`);
    }

    // Store selected duration
    sessionStorage.setItem(`offchat_ttl_${roomName}`, String(selectedDuration));

    // Navigate — encryption key will be derived from room name + password
    location.href = `/${roomName}`;
}

// Duration buttons
durationBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        durationBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedDuration = parseInt(btn.dataset.duration, 10);
    });
});

// Toggle password field
passwordToggle.addEventListener('click', () => {
    passwordEnabled = !passwordEnabled;
    passwordField.hidden = !passwordEnabled;

    if (passwordEnabled) {
        passwordToggleText.textContent = 'remove password';
        passwordToggle.classList.add('active');
        passwordField.classList.add('visible');
        passwordInput.focus();
    } else {
        passwordToggleText.textContent = 'add password';
        passwordToggle.classList.remove('active');
        passwordField.classList.remove('visible');
        passwordInput.value = '';
    }
});

// Toggle password visibility
passwordVisibility.addEventListener('click', () => {
    const isPassword = passwordInput.type === 'password';
    passwordInput.type = isPassword ? 'text' : 'password';
    eyeOpen.hidden = !isPassword;
    eyeClosed.hidden = isPassword;
});

// Input validation
input.addEventListener('input', () => {
    input.value = input.value.replace(/[^a-zA-Z0-9_-]/g, '');
    goBtn.disabled = input.value.trim().length === 0;
});

// Enter to submit on room input
input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goToRoom();
});

// Enter to submit on password input
passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goToRoom();
});

// Button click
goBtn.addEventListener('click', goToRoom);
