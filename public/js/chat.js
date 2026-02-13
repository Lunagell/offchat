/* ═══════════════════════════════════════════════════════════════════
   offchat — Chat Room Logic
   WebSocket + E2E encryption + file sharing
   Key derived from room name — URL is clean
   ═══════════════════════════════════════════════════════════════════ */

import { deriveKey, encrypt, decrypt, encryptFile, decryptFile } from './crypto.js';

// ─── Constants ───────────────────────────────────────────────────────
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

// ─── Extract room info from URL ──────────────────────────────────────
const roomName = decodeURIComponent(location.pathname.slice(1));

// ─── DOM References ──────────────────────────────────────────────────
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('msg-input');
const timerEl = document.getElementById('timer');
const participantsEl = document.getElementById('participants');
const codenameEl = document.getElementById('codename');
const roomNameEl = document.getElementById('room-name');
const copyLinkBtn = document.getElementById('copy-link');
const emptyState = document.querySelector('.messages__empty');
const fileInput = document.getElementById('file-input');
const fileBtn = document.getElementById('file-btn');

// Set room name in header
roomNameEl.textContent = roomName;

// ─── Derive encryption key from room name ────────────────────────────
const cryptoKey = await deriveKey(roomName);

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

        case 'file':
            try {
                const metaJson = await decrypt(cryptoKey, data.meta, data.metaIv);
                const meta = JSON.parse(metaJson);
                const fileBuffer = await decryptFile(cryptoKey, data.data, data.dataIv);
                addFileMessage(data.codename, meta, fileBuffer, data.timestamp);
            } catch {
                addSystemMessage('⚠ file decryption failed');
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

// ─── Send Text Message ───────────────────────────────────────────────
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

    addMessage(myCodename, text, Date.now(), true);
    inputEl.value = '';
});

// ─── File Upload ─────────────────────────────────────────────────────
fileBtn.addEventListener('click', () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    fileInput.click();
});

fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    fileInput.value = '';

    if (file.size > MAX_FILE_SIZE) {
        showToast(`file too large — max ${MAX_FILE_SIZE / 1024 / 1024}MB`);
        return;
    }

    fileBtn.classList.add('uploading');
    addSystemMessage(`encrypting ${file.name}...`);

    try {
        const arrayBuffer = await file.arrayBuffer();
        const { encrypted: encData, iv: dataIv } = await encryptFile(cryptoKey, arrayBuffer);

        const metaStr = JSON.stringify({
            name: file.name,
            type: file.type || 'application/octet-stream',
            size: file.size,
        });
        const { encrypted: encMeta, iv: metaIv } = await encrypt(cryptoKey, metaStr);

        ws.send(JSON.stringify({
            type: 'file',
            data: encData,
            dataIv,
            meta: encMeta,
            metaIv,
        }));

        const meta = { name: file.name, type: file.type, size: file.size };
        addFileMessage(myCodename, meta, arrayBuffer, Date.now(), true);

    } catch (err) {
        addSystemMessage(`⚠ failed to send file: ${err.message}`);
    } finally {
        fileBtn.classList.remove('uploading');
    }
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

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(type) {
    if (type.startsWith('image/')) return '🖼';
    if (type.startsWith('video/')) return '🎥';
    if (type.startsWith('audio/')) return '🎵';
    if (type.includes('pdf')) return '📄';
    if (type.includes('zip') || type.includes('rar') || type.includes('tar') || type.includes('7z')) return '📦';
    if (type.includes('text') || type.includes('json') || type.includes('xml')) return '📝';
    return '📎';
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
    textSpan.textContent = text;

    el.append(timeSpan, nameSpan, textSpan);
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addFileMessage(codename, meta, fileBuffer, timestamp, isSelf = false) {
    clearEmptyState();

    const el = document.createElement('div');
    el.className = `message file-msg${isSelf ? ' self' : ''}`;

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

    const card = document.createElement('div');
    card.className = 'file-card';

    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = getFileIcon(meta.type || '');

    const info = document.createElement('div');
    info.className = 'file-info';

    const fileName = document.createElement('span');
    fileName.className = 'file-name';
    fileName.textContent = meta.name;

    const fileSize = document.createElement('span');
    fileSize.className = 'file-size';
    fileSize.textContent = formatSize(meta.size);

    info.append(fileName, fileSize);

    const dlBtn = document.createElement('button');
    dlBtn.className = 'file-download';
    dlBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M8 2v8M4 7l4 4 4-4M3 13h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
    dlBtn.title = 'Download';

    dlBtn.addEventListener('click', () => {
        const blob = new Blob([fileBuffer], { type: meta.type || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = meta.name;
        a.click();
        URL.revokeObjectURL(url);
    });

    card.append(icon, info, dlBtn);

    if (meta.type?.startsWith('image/')) {
        const preview = document.createElement('img');
        preview.className = 'file-preview';
        const blob = new Blob([fileBuffer], { type: meta.type });
        preview.src = URL.createObjectURL(blob);
        preview.alt = meta.name;
        card.appendChild(preview);
    }

    el.append(timeSpan, nameSpan, card);
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
