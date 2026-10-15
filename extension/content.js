// Content Script: Bridges webpage video player with Socket.io WatchParty Server

let socket = null;
let currentRoomId = null;
let isHost = false;
let ignoreLocal = false;
let serverBaseUrl = 'http://localhost:4000';

// Inject main-world script for Netflix / complex sites
function injectScript(file) {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL(file);
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
}

if (window.location.hostname.includes('netflix.com')) {
  injectScript('injected.js');
}

// Receive messages from injected.js (Netflix Main World)
window.addEventListener('message', (event) => {
  if (event.data?.source === 'WATCHPARTY_PAGE' && socket && currentRoomId) {
    if (isHost && !ignoreLocal) {
      socket.emit('host_heartbeat', {
        time: event.data.currentTime,
        state: event.data.paused ? 'paused' : 'playing'
      });
    }
  }
});

// Setup floating UI bar on streaming sites
function injectWatchPartyFloatingBar() {
  if (document.getElementById('watchparty-floating-bar')) return;

  const bar = document.createElement('div');
  bar.id = 'watchparty-floating-bar';
  bar.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 9999999;
    background: rgba(9, 13, 22, 0.95);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(56, 189, 248, 0.4);
    border-radius: 12px;
    padding: 10px 14px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.8);
    display: flex;
    align-items: center;
    gap: 10px;
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
  `;

  bar.innerHTML = `
    <span style="font-weight: 800; color: #38bdf8; letter-spacing: 0.5px;">W2G SYNC</span>
    <input type="text" id="wp-room-id" placeholder="Oda Kodu (örn: oda-1)" style="background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: #fff; padding: 4px 8px; border-radius: 6px; font-size: 12px; width: 110px; outline: none;">
    <button id="wp-connect-btn" style="background: #0284c7; color: #fff; border: none; padding: 5px 12px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer;">Bağlan</button>
    <span id="wp-sync-pill" style="display: none; background: rgba(52, 211, 153, 0.2); color: #34d399; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 600;">● Senkron</span>
  `;

  document.body.appendChild(bar);

  document.getElementById('wp-connect-btn').onclick = () => {
    const roomId = document.getElementById('wp-room-id').value.trim() || 'default-room';
    connectToWatchParty(roomId);
  };
}

// Watch for DOM changes to find `<video>` and inject UI
const observer = new MutationObserver(() => {
  if (document.querySelector('video') || window.location.hostname.includes('netflix.com')) {
    injectWatchPartyFloatingBar();
    hookHTML5Video();
  }
});
observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

let hookedVideo = null;

function hookHTML5Video() {
  const video = document.querySelector('video');
  if (!video || video === hookedVideo) return;
  hookedVideo = video;

  video.addEventListener('play', () => {
    if (ignoreLocal || !socket) return;
    socket.emit('video_play', { time: video.currentTime });
  });

  video.addEventListener('pause', () => {
    if (ignoreLocal || !socket) return;
    socket.emit('video_pause', { time: video.currentTime });
  });

  video.addEventListener('seeking', () => {
    if (ignoreLocal || !socket) return;
    socket.emit('video_seek', { time: video.currentTime });
  });
}

function sendToPlayer(action, time) {
  // If Netflix
  if (window.location.hostname.includes('netflix.com')) {
    window.postMessage({ source: 'WATCHPARTY_EXT', action, time }, '*');
    return;
  }

  // Standard HTML5 video tag
  const video = document.querySelector('video');
  if (!video) return;

  if (action === 'SEEK') {
    video.currentTime = time;
  } else if (action === 'PLAY') {
    if (typeof time === 'number' && Math.abs(video.currentTime - time) > 1) {
      video.currentTime = time;
    }
    video.play().catch(() => {});
  } else if (action === 'PAUSE') {
    if (typeof time === 'number') video.currentTime = time;
    video.pause();
  }
}

function connectToWatchParty(roomId) {
  currentRoomId = roomId;

  if (socket) {
    socket.disconnect();
  }

  socket = io(serverBaseUrl);

  socket.on('connect', () => {
    console.log('[WatchParty] Connected to sync server');
    socket.emit('join_room', {
      roomId: currentRoomId,
      username: 'Browser_' + Math.floor(Math.random() * 899 + 100)
    });
    document.getElementById('wp-connect-btn').innerText = 'Bağlandı';
    document.getElementById('wp-connect-btn').style.background = '#10b981';
    document.getElementById('wp-sync-pill').style.display = 'inline-block';
  });

  socket.on('sync_init', (data) => {
    isHost = data.isHost;
    if (data.currentTime > 0) {
      ignoreLocal = true;
      sendToPlayer('SEEK', data.currentTime);
      if (data.state === 'playing') sendToPlayer('PLAY', data.currentTime);
      setTimeout(() => { ignoreLocal = false; }, 600);
    }
  });

  socket.on('sync_play', ({ time }) => {
    ignoreLocal = true;
    sendToPlayer('PLAY', time);
    setTimeout(() => { ignoreLocal = false; }, 600);
  });

  socket.on('sync_pause', ({ time }) => {
    ignoreLocal = true;
    sendToPlayer('PAUSE', time);
    setTimeout(() => { ignoreLocal = false; }, 600);
  });

  socket.on('sync_seek', ({ time, state }) => {
    ignoreLocal = true;
    sendToPlayer('SEEK', time);
    if (state === 'playing') sendToPlayer('PLAY', time);
    setTimeout(() => { ignoreLocal = false; }, 600);
  });

  socket.on('sync_heartbeat', ({ serverTime, state }) => {
    if (isHost) return;
    const video = document.querySelector('video');
    if (video) {
      const drift = Math.abs(video.currentTime - serverTime);
      if (drift > 1.2) {
        ignoreLocal = true;
        sendToPlayer('SEEK', serverTime);
        if (state === 'playing') sendToPlayer('PLAY', serverTime);
        setTimeout(() => { ignoreLocal = false; }, 600);
      }
    }
  });
}
