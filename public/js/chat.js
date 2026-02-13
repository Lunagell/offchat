/* ═══════════════════════════════════════════════════════════════════
   offchat — Chat Room Logic
   WebSocket connection + E2E encryption + UI management
   ═══════════════════════════════════════════════════════════════════ */

import { importKey, encrypt, decrypt } from './crypto.js';

// ─── Extract room info from URL ──────────────────────────────────────
const roomName = decodeURIComponent(location.pathname.slice(1));

// Read hash — retry to handle edge cases where hash isn't ready
function getKeyFragment() {
    const raw = window.location.hash;
    return raw ? raw.slice(1) : '';
}

const keyFragment = getKeyFragment();

// ─── DOM References ──────────────────────────────────────────────────
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('msg-input');
const timerEl = document.getElementById('timer');
const participantsEl = document.getElementById('participants');
const codenameEl = document.getElementById('codename');
const roomNameEl = document.getElementById('room-name');
const copyLinkBtn = document.getElementById('copy-link');
const errorOverlay = document.getElementById('error-overlay');
const emptyState = document.querySelector('.messages__empty');

// Set room name in header
roomNameEl.textContent = roomName;

// ─── Validate encryption key ────────────────────────────────────────
if (!keyFragment) {
    errorOverlay.hidden = false;
    inputEl.disabled = true;
    throw new Error('[offchat] no encryption key in URL fragment');
}

// Hide error overlay explicitly (in case it was shown)
errorOverlay.hidden = true;

// ─── Import encryption key ──────────────────────────────────────────
let cryptoKey;
try {
    cryptoKey = await importKey(keyFragment);
} catch (err) {
    errorOverlay.hidden = false;
    inputEl.disabled = true;
    throw new Error(`[offchat] invalid encryption key: ${err.message}`);
}

// ─── State ───────────────────────────────────────────────────────────
let myCodename = '';
let hasMessages = false;

// ─── WebSocket Connection ────────────────────────────────────────────
const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${protocol}//${location.host}?room=${encodeURIComponent(roomName)}`;
const ws = new WebSocket(wsUrl);

ws.addEventListener('open', () => {
    inputEl.focus();
});

ws.addEventListener('message', async (event) => {
    const data = JSON.parse(event.data);

    switch (data.type) {
        case 'init':
            myCodename = data.codename;
            codenameEl.textContent = data.codename;
            participantsEl.textContent = data.participants;
            startTimer(data.expiresAt);
            addSystemMessage(`you joined as ${data.codename}`);
            break;

        case 'join':
            participantsEl.textContent = data.participants;
            addSystemMessage(`${data.codename} connected`);
            break;

        case 'leave':
            participantsEl.textContent = data.participants;
            addSystemMessage(`${data.codename} disconnected`);
            break;

        case 'message':
            try {
                const plaintext = await decrypt(cryptoKey, data.encrypted, data.iv);
                addMessage(data.codename, plaintext, data.timestamp);
            } catch {
                addSystemMessage('⚠ decryption failed');
            }
            break;

        case 'destroyed':
            addSystemMessage('room destroyed — all data purged');
            inputEl.disabled = true;
            inputEl.placeholder = 'room expired';
            break;
    }
});

ws.addEventListener('close', () => {
    addSystemMessage('connection closed');
    inputEl.disabled = true;
});

ws.addEventListener('error', () => {
    addSystemMessage('⚠ connection error');
});

// ─── Send Message ────────────────────────────────────────────────────
inputEl.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;

    const text = inputEl.value.trim();
    if (!text || ws.readyState !== WebSocket.OPEN) return;

    const { encrypted, iv } = await encrypt(cryptoKey, text);

    ws.send(JSON.stringify({
        type: 'message',
        encrypted,
        iv,
    }));

    // Display own message locally
    addMessage(myCodename, text, Date.now(), true);
    inputEl.value = '';
});

// ─── Copy Link ───────────────────────────────────────────────────────
copyLinkBtn.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(location.href);
        copyLinkBtn.classList.add('copied');
        showToast('link copied — share it privately');
        setTimeout(() => copyLinkBtn.classList.remove('copied'), 2000);
    } catch {
        showToast('failed to copy');
    }
});

// ─── UI Helpers ──────────────────────────────────────────────────────

function clearEmptyState() {
    if (!hasMessages && emptyState) {
        emptyState.remove();
        hasMessages = true;
    }
}

function addMessage(codename, text, timestamp, isSelf = false) {
    clearEmptyState();

    const el = document.createElement('div');
    el.className = `message${isSelf ? ' self' : ''}`;

    const time = new Date(timestamp).toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });

    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    timeSpan.textContent = time;

    const nameSpan = document.createElement('span');
    nameSpan.className = `msg-name${isSelf ? ' self' : ''}`;
    nameSpan.textContent = codename;

    const textSpan = document.createElement('span');
    textSpan.className = 'msg-text';
    textSpan.textContent = text; // textContent = safe from XSS

    el.append(timeSpan, nameSpan, textSpan);
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addSystemMessage(text) {
    clearEmptyState();

    const el = document.createElement('div');
    el.className = 'message system';

    const span = document.createElement('span');
    span.className = 'msg-system';
    span.textContent = `› ${text}`;

    el.appendChild(span);
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showToast(text) {
    let toast = document.querySelector('.toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.className = 'toast';
        document.body.appendChild(toast);
    }

    toast.textContent = text;
    toast.classList.add('show');

    setTimeout(() => toast.classList.remove('show'), 2000);
}

// ─── Countdown Timer ─────────────────────────────────────────────────
function startTimer(expiresAt) {
    const tick = () => {
        const remaining = Math.max(0, expiresAt - Date.now());
        const min = Math.floor(remaining / 60_000);
        const sec = Math.floor((remaining % 60_000) / 1_000);

        timerEl.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

        // Urgency classes
        if (remaining < 60_000) {
            timerEl.classList.remove('warning');
            timerEl.classList.add('critical');
        } else if (remaining < 180_000) {
            timerEl.classList.add('warning');
        }

        if (remaining > 0) {
            requestAnimationFrame(tick);
        } else {
            timerEl.textContent = '00:00';
            addSystemMessage('room expired — all data purged');
            inputEl.disabled = true;
            inputEl.placeholder = 'room expired';
        }
    };

    tick();
}
