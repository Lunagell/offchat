/* ═══════════════════════════════════════════════════════════════════
   offchat — Chat Room Logic
   WebSocket + E2E encryption + file sharing + password protection
   + typing indicator + tab notifications + drag & drop + destroy + QR
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
const lockIndicator = document.getElementById('lock-indicator');
const chatContainer = document.getElementById('chat-container');

// Password modal
const passwordModal = document.getElementById('password-modal');
const modalPasswordInput = document.getElementById('modal-password-input');
const modalPasswordVisibility = document.getElementById('modal-password-visibility');
const modalEyeOpen = document.getElementById('modal-eye-open');
const modalEyeClosed = document.getElementById('modal-eye-closed');
const modalSubmit = document.getElementById('modal-submit');
const modalError = document.getElementById('modal-error');

// Typing indicator
const typingIndicator = document.getElementById('typing-indicator');
const typingText = document.getElementById('typing-text');

// Destroy room
const destroyBtn = document.getElementById('destroy-btn');

// QR code
const qrBtn = document.getElementById('qr-btn');
const qrModal = document.getElementById('qr-modal');
const qrBackdrop = document.getElementById('qr-backdrop');
const qrContainer = document.getElementById('qr-container');
const qrUrl = document.getElementById('qr-url');
const qrClose = document.getElementById('qr-close');

// Drag & drop
const dragOverlay = document.getElementById('drag-overlay');

// Set room name in header
roomNameEl.textContent = roomName;

// ─── State ───────────────────────────────────────────────────────────
let myCodename = '';
let hasMessages = false;
let cryptoKey = null;
let ws = null;
let roomPassword = '';

// Typing state
let lastTypingSent = 0;
const typingUsers = new Map(); // codename → timeout

// Tab notification state
let unreadCount = 0;
let isTabHidden = false;

// Drag counter (needed because dragenter/dragleave fire on children)
let dragCounter = 0;

// Destroy confirm state
let destroyConfirmTimeout = null;

// ─── Password & TTL from sessionStorage ──────────────────────────────
const storedPassword = sessionStorage.getItem(`offchat_pwd_${roomName}`);
const storedTTL = sessionStorage.getItem(`offchat_ttl_${roomName}`) || '10';

// ═══════════════════════════════════════════════════════════════════
//  TAB NOTIFICATIONS & RECONNECTION
// ═══════════════════════════════════════════════════════════════════
document.addEventListener('visibilitychange', () => {
    isTabHidden = document.hidden;
    if (!isTabHidden) {
        unreadCount = 0;
        document.title = 'offchat';

        // Auto-reconnect if visible and disconnected
        if (!ws || ws.readyState === WebSocket.CLOSED) {
            reconnectDelay = 1000;
            connect();
        }
    }
});

function notifyUnread() {
    if (isTabHidden) {
        unreadCount++;
        document.title = `(${unreadCount}) offchat`;
    }
}

// ═══════════════════════════════════════════════════════════════════
//  TYPING INDICATOR
// ═══════════════════════════════════════════════════════════════════
function sendTyping() {
    const now = Date.now();
    if (now - lastTypingSent > 2000 && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'typing' }));
        lastTypingSent = now;
    }
}

function showTyping(codename) {
    if (typingUsers.has(codename)) {
        clearTimeout(typingUsers.get(codename));
    }

    const timeout = setTimeout(() => {
        typingUsers.delete(codename);
        updateTypingUI();
    }, 3000);

    typingUsers.set(codename, timeout);
    updateTypingUI();
}

function updateTypingUI() {
    const names = Array.from(typingUsers.keys());
    if (names.length === 0) {
        typingIndicator.hidden = true;
    } else {
        typingIndicator.hidden = false;
        const text = names.length === 1
            ? `${names[0]} is typing`
            : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are typing`;
        typingText.textContent = text;
    }
}

// ═══════════════════════════════════════════════════════════════════
//  DRAG & DROP
// ═══════════════════════════════════════════════════════════════════
chatContainer.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter++;
    if (dragCounter === 1) dragOverlay.hidden = false;
});

chatContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
});

chatContainer.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter--;
    if (dragCounter === 0) dragOverlay.hidden = true;
});

chatContainer.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    dragOverlay.hidden = true;

    const file = e.dataTransfer?.files?.[0];
    if (file && ws && ws.readyState === WebSocket.OPEN) {
        await handleFileUpload(file);
    }
});

// ═══════════════════════════════════════════════════════════════════
//  DESTROY ROOM
// ═══════════════════════════════════════════════════════════════════
destroyBtn.addEventListener('click', () => {
    if (destroyBtn.classList.contains('confirming')) {
        clearTimeout(destroyConfirmTimeout);
        destroyBtn.classList.remove('confirming');

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'destroy' }));
        }
    } else {
        destroyBtn.classList.add('confirming');
        destroyConfirmTimeout = setTimeout(() => {
            destroyBtn.classList.remove('confirming');
        }, 3000);
    }
});

function shatterAndRedirect() {
    // Create shatter overlay
    const overlay = document.createElement('div');
    overlay.className = 'shatter-overlay';
    document.body.appendChild(overlay);

    // Flash effect
    const flash = document.createElement('div');
    flash.className = 'shatter-flash';
    overlay.appendChild(flash);

    // Create crack lines radiating from center
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const numCracks = 20;
    const maxLen = Math.hypot(window.innerWidth, window.innerHeight);

    for (let i = 0; i < numCracks; i++) {
        const crack = document.createElement('div');
        crack.className = 'shatter-crack';
        const angle = (360 / numCracks) * i + (Math.random() * 10 - 5);
        crack.style.left = cx + 'px';
        crack.style.top = cy + 'px';
        crack.style.width = maxLen + 'px';
        crack.style.setProperty('--angle', `${angle}deg`);
        crack.style.animationDelay = `${i * 0.02}s`;
        overlay.appendChild(crack);
    }

    // Distort page content
    setTimeout(() => {
        chatContainer.classList.add('shattering');
    }, 150);

    // Show destroyed text
    setTimeout(() => {
        const text = document.createElement('div');
        text.className = 'shatter-text';
        text.innerHTML = '<span>room destroyed</span><span class="shatter-sub">all data purged</span>';
        overlay.appendChild(text);
    }, 500);

    // Redirect
    setTimeout(() => {
        location.href = '/';
    }, 2000);
}

// ═══════════════════════════════════════════════════════════════════
//  QR CODE MODAL
// ═══════════════════════════════════════════════════════════════════
qrBtn.addEventListener('click', async () => {
    qrModal.hidden = false;
    qrUrl.textContent = location.href;

    try {
        const res = await fetch(`/api/qr?room=${encodeURIComponent(roomName)}`);
        const svg = await res.text();
        qrContainer.innerHTML = svg;
    } catch {
        qrContainer.textContent = 'failed to generate QR code';
    }
});

qrClose.addEventListener('click', () => {
    qrModal.hidden = true;
});

qrBackdrop.addEventListener('click', () => {
    qrModal.hidden = true;
});

// ═══════════════════════════════════════════════════════════════════
//  PASSWORD MODAL
// ═══════════════════════════════════════════════════════════════════
async function checkRoomAndConnect() {
    try {
        const res = await fetch(`/api/room-info?room=${encodeURIComponent(roomName)}`);
        const info = await res.json();

        if (info.hasPassword && !storedPassword) {
            showPasswordModal();
        } else {
            roomPassword = storedPassword || '';
            await initChat();
        }
    } catch {
        roomPassword = storedPassword || '';
        await initChat();
    }
}

function showPasswordModal() {
    passwordModal.hidden = false;
    chatContainer.style.filter = 'blur(8px)';
    chatContainer.style.pointerEvents = 'none';
    modalPasswordInput.focus();
}

function hidePasswordModal() {
    passwordModal.hidden = true;
    chatContainer.style.filter = '';
    chatContainer.style.pointerEvents = '';
}

modalPasswordVisibility.addEventListener('click', () => {
    const isPassword = modalPasswordInput.type === 'password';
    modalPasswordInput.type = isPassword ? 'text' : 'password';
    modalEyeOpen.hidden = !isPassword;
    modalEyeClosed.hidden = isPassword;
});

modalSubmit.addEventListener('click', async () => {
    const pwd = modalPasswordInput.value;
    if (!pwd) {
        modalError.hidden = false;
        modalError.textContent = 'please enter a password';
        shakeModal();
        return;
    }

    roomPassword = pwd;
    sessionStorage.setItem(`offchat_pwd_${roomName}`, pwd);
    hidePasswordModal();
    await initChat();
});

modalPasswordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') modalSubmit.click();
});

function shakeModal() {
    const card = document.querySelector('.password-modal__card');
    card.classList.add('shake');
    setTimeout(() => card.classList.remove('shake'), 500);
}

// ═══════════════════════════════════════════════════════════════════
//  INITIALIZE CHAT & RECONNECTION
// ═══════════════════════════════════════════════════════════════════
let reconnectTimer = null;
let reconnectDelay = 1000;

async function initChat() {
    cryptoKey = await deriveKey(roomName, roomPassword);

    if (roomPassword) {
        lockIndicator.hidden = false;
    }

    loadHistory();
    setInterval(updateTimestamps, 60000);

    connect();
}

function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    updateConnectionStatus('reconnecting');

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const hasPassword = roomPassword ? '1' : '0';

    hashPassword(roomPassword || '').then(pwdHash => {
        const ttl = storedTTL;
        const wsUrl = `${protocol}//${location.host}?room=${encodeURIComponent(roomName)}&hasPassword=${hasPassword}&pwdHash=${encodeURIComponent(pwdHash)}&ttl=${ttl}`;

        ws = new WebSocket(wsUrl);
        ws.addEventListener('open', onOpen);
        ws.addEventListener('message', onMessage);
        ws.addEventListener('close', onClose);
        ws.addEventListener('error', onError);
    });
}

function onOpen() {
    inputEl.disabled = false;
    inputEl.focus();
    reconnectDelay = 1000;
    updateConnectionStatus('connected');

    const recMsg = document.querySelector('.msg-system.reconnecting');
    if (recMsg) {
        recMsg.remove();
        addSystemMessage('connected');
    }
}

async function onMessage(event) {
    const data = JSON.parse(event.data);

    switch (data.type) {
        case 'init':
            myCodename = data.codename;
            codenameEl.textContent = data.codename;
            participantsEl.textContent = data.participants;
            startTimer(data.expiresAt);
            if (!hasMessages) addSystemMessage(`you joined as ${data.codename}`);
            if (data.hasPassword) {
                lockIndicator.hidden = false;
            }
            break;

        case 'join':
            participantsEl.textContent = data.participants;
            addSystemMessage(`${data.codename} connected`);
            notifyUnread();
            break;

        case 'leave':
            participantsEl.textContent = data.participants;
            addSystemMessage(`${data.codename} disconnected`);
            if (typingUsers.has(data.codename)) {
                clearTimeout(typingUsers.get(data.codename));
                typingUsers.delete(data.codename);
                updateTypingUI();
            }
            break;

        case 'message':
            try {
                const plaintext = await decrypt(cryptoKey, data.encrypted, data.iv);
                addMessage(data.codename, plaintext, data.timestamp);
                playNotification();
                notifyUnread();
            } catch {
                addSystemMessage('⚠ decryption failed — wrong password?');
            }
            if (typingUsers.has(data.codename)) {
                clearTimeout(typingUsers.get(data.codename));
                typingUsers.delete(data.codename);
                updateTypingUI();
            }
            break;

        case 'file':
            try {
                const metaJson = await decrypt(cryptoKey, data.meta, data.metaIv);
                const meta = JSON.parse(metaJson);
                const fileBuffer = await decryptFile(cryptoKey, data.data, data.dataIv);
                addFileMessage(data.codename, meta, fileBuffer, data.timestamp);
                playNotification();
                notifyUnread();
            } catch {
                addSystemMessage('⚠ file decryption failed — wrong password?');
            }
            break;

        case 'typing':
            showTyping(data.codename);
            break;

        case 'auth_error':
            showPasswordModal();
            modalError.hidden = false;
            modalError.textContent = 'wrong password — try again';
            shakeModal();
            sessionStorage.removeItem(`offchat_pwd_${roomName}`);
            // ws will be closed by server with 4003, which we handle in onClose
            break;

        case 'destroyed':
            if (data.manual) {
                shatterAndRedirect();
            } else {
                addSystemMessage('room destroyed — all data purged');
                inputEl.disabled = true;
                inputEl.placeholder = 'room expired';
                updateConnectionStatus('disconnected');
            }
            break;
    }
}

function onClose(e) {
    updateConnectionStatus('disconnected');
    if (e.code === 4003 || e.code === 4001) {
        if (e.code === 4003 && !modalError.hidden) {
            // Already showing modal
        } else {
            addSystemMessage('connection closed (fatal)');
            inputEl.disabled = true;
        }
    } else {
        if (!chatContainer.classList.contains('shattering')) {
            if (!document.querySelector('.msg-system.reconnecting')) {
                addSystemMessage('connection lost — reconnecting...', 'reconnecting');
            }
            inputEl.disabled = true;
            scheduleReconnect();
        }
    }
}

function onError() {
    // Error usually precedes close, so we rely on onClose for logic
}

function scheduleReconnect() {
    if (reconnectTimer) return;

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectDelay = Math.min(reconnectDelay * 2, 8000); // cap at 8s
        connect();
    }, reconnectDelay);
}
// ─── Hash password ───────────────────────────────────────────────────
async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password + ':offchat-salt-v1');
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ═══════════════════════════════════════════════════════════════════
//  SEND TEXT MESSAGE
// ═══════════════════════════════════════════════════════════════════
inputEl.addEventListener('input', sendTyping);

inputEl.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;

    const text = inputEl.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

    const { encrypted, iv } = await encrypt(cryptoKey, text);

    ws.send(JSON.stringify({
        type: 'message',
        encrypted,
        iv,
    }));

    addMessage(myCodename, text, Date.now(), true);
    inputEl.value = '';
});

// ═══════════════════════════════════════════════════════════════════
//  FILE UPLOAD (shared by button and drag & drop)
// ═══════════════════════════════════════════════════════════════════
async function handleFileUpload(file) {
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
}

fileBtn.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    fileInput.click();
});

fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileInput.value = '';
    await handleFileUpload(file);
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

// ═══════════════════════════════════════════════════════════════════
//  UI HELPERS
// ═══════════════════════════════════════════════════════════════════

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

function shouldAutoScroll() {
    const threshold = 100;
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
}

function addMessage(codename, text, timestamp, isSelf = false, fromHistory = false) {
    if (!fromHistory) {
        saveMessageToHistory({ type: 'text', codename, text, timestamp, isSelf });
    }

    clearEmptyState();
    const doScroll = shouldAutoScroll();

    const el = document.createElement('div');
    el.className = `message${isSelf ? ' self' : ''}`;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    timeSpan.dataset.timestamp = timestamp;
    timeSpan.textContent = formatTimeRelative(timestamp);
    timeSpan.title = new Date(timestamp).toLocaleTimeString();

    const nameSpan = document.createElement('span');
    nameSpan.className = `msg-name${isSelf ? ' self' : ''}`;
    nameSpan.textContent = codename;

    const textSpan = document.createElement('span');
    textSpan.className = 'msg-text';
    textSpan.innerHTML = linkify(text);

    el.append(timeSpan, nameSpan, textSpan);
    messagesEl.appendChild(el);
    if (doScroll || isSelf || fromHistory) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addFileMessage(codename, meta, fileBuffer, timestamp, isSelf = false) {
    clearEmptyState();
    const doScroll = shouldAutoScroll();

    const el = document.createElement('div');
    el.className = `message file-msg${isSelf ? ' self' : ''}`;

    const time = new Date(timestamp).toLocaleTimeString('en-US', {
        hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
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
    if (doScroll || isSelf) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addSystemMessage(text) {
    clearEmptyState();
    const doScroll = shouldAutoScroll();

    const el = document.createElement('div');
    el.className = 'message system';

    const span = document.createElement('span');
    span.className = 'msg-system';
    span.textContent = `› ${text}`;

    el.appendChild(span);
    messagesEl.appendChild(el);
    if (doScroll) messagesEl.scrollTop = messagesEl.scrollHeight;
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

//  QoL HELPERS
// ═══════════════════════════════════════════════════════════════════
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const connectionStatus = document.getElementById('connection-status');

function updateConnectionStatus(status) {
    if (!connectionStatus) return;
    connectionStatus.className = 'connection-status ' + status;
    connectionStatus.title = status;
}

function playNotification() {
    if (document.hidden && audioCtx.state === 'suspended') audioCtx.resume();
    if (audioCtx.state === 'suspended') return;

    try {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);

        osc.frequency.setValueAtTime(800, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(400, audioCtx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.05, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);

        osc.start();
        osc.stop(audioCtx.currentTime + 0.15);
    } catch (e) {
        console.warn('Audio play failed', e);
    }
}

function linkify(text) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return text.replace(urlRegex, (url) => {
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });
}

function formatTimeRelative(timestamp) {
    const diff = Math.floor((Date.now() - timestamp) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return new Date(timestamp).toLocaleDateString();
}

function updateTimestamps() {
    document.querySelectorAll('.msg-time').forEach(el => {
        const ts = parseInt(el.dataset.timestamp);
        if (ts) el.textContent = formatTimeRelative(ts);
    });
}

function saveMessageToHistory(msg) {
    try {
        const history = JSON.parse(sessionStorage.getItem(`offchat_hist_${roomName}`) || '[]');
        history.push(msg);
        if (history.length > 50) history.shift();
        sessionStorage.setItem(`offchat_hist_${roomName}`, JSON.stringify(history));
    } catch (e) {
        console.error('History save failed', e);
    }
}

function loadHistory() {
    try {
        const history = JSON.parse(sessionStorage.getItem(`offchat_hist_${roomName}`) || '[]');
        history.forEach(msg => {
            if (msg.type === 'text') {
                addMessage(msg.codename, msg.text, msg.timestamp, msg.isSelf, true);
            }
        });
        setTimeout(() => {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }, 10);
    } catch (e) {
        console.error('History load failed', e);
    }
}

// Audio Unlock
document.addEventListener('click', () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
}, { once: true });
document.addEventListener('keydown', () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
}, { once: true });

// ─── Start ───────────────────────────────────────────────────────────
checkRoomAndConnect();
