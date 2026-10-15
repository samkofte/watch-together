const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Global state for rooms
// room_id -> {
//   id,
//   videoType: 'youtube' | 'direct' | 'hls',
//   videoUrl: string,
//   videoId: string,
//   state: 'playing' | 'paused',
//   currentTime: number,
//   lastUpdated: number,
//   playbackRate: number,
//   users: { [socketId]: { name, avatar, isHost } },
//   chat: []
// }
const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      videoType: 'youtube',
      videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      videoId: 'dQw4w9WgXcQ',
      state: 'paused',
      currentTime: 0,
      lastUpdated: Date.now(),
      playbackRate: 1,
      users: {},
      chat: []
    });
  }
  return rooms.get(roomId);
}

function calculateCurrentTime(room) {
  if (room.state === 'playing') {
    const elapsedSeconds = (Date.now() - room.lastUpdated) / 1000;
    return room.currentTime + (elapsedSeconds * (room.playbackRate || 1));
  }
  return room.currentTime;
}

// REST helper to inspect room status
app.get('/api/room/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    ...room,
    currentTime: calculateCurrentTime(room)
  });
});

const axios = require('axios');
const cheerio = require('cheerio');

const { spawn } = require('child_process');

function runPythonBridge(url) {
  return new Promise((resolve) => {
    const py = spawn('python', ['resolve_bridge.py', url], { cwd: __dirname });
    let output = '';
    py.stdout.on('data', (d) => { output += d.toString(); });
    py.on('close', (code) => {
      try {
        const json = JSON.parse(output.trim());
        resolve(json);
      } catch (e) {
        resolve({ success: false, error: 'Bridge execution error' });
      }
    });
    py.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

const m3u8Cache = new Map();


// Serve m3u8 playlist directly to players
app.get('/api/proxy/m3u8/:cacheId', (req, res) => {
  const content = m3u8Cache.get(req.params.cacheId);
  if (!content) return res.status(404).send('Playlist not found or expired');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(content);
});

// Proxy for video chunks (.ts / .png) with MolySTREAM headers
app.get('/api/proxy/chunk', async (req, res) => {
  const chunkUrl = req.query.url;
  if (!chunkUrl) return res.status(400).send('Missing chunk url');

  try {
    const resp = await axios.get(chunkUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://dbx.molystream.org/'
      },
      timeout: 10000
    });

    res.setHeader('Content-Type', 'video/MP2T');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(resp.data));
  } catch (err) {
    res.status(500).send('Chunk proxy error: ' + err.message);
  }
});

function fetchWithCurlImpersonate(url) {
  return new Promise((resolve) => {
    const py = spawn('python', ['fetch_page.py', url], { cwd: __dirname });
    let output = '';
    py.stdout.on('data', (d) => { output += d.toString(); });
    py.on('close', () => {
      try {
        resolve(JSON.parse(output.trim()));
      } catch (e) {
        resolve({ error: 'Failed to parse python curl output' });
      }
    });
    py.on('error', (err) => resolve({ error: err.message }));
  });
}

// Universal Unblocker Proxy (Strips X-Frame-Options, CSP, and CORP headers)
// Allows ANY video website or player to be safely embedded without browser ERR_BLOCKED_BY_RESPONSE errors
app.get('/api/proxy/unblock', async (req, res) => {
  let target = req.query.url;
  if (!target) return res.status(400).send('Missing url param');

  // Strip duplicate nested proxy calls if any
  while (target.includes('/api/proxy/unblock?url=')) {
    target = decodeURIComponent(target.split('/api/proxy/unblock?url=')[1]);
  }

  try {
    let targetUrlObj;
    try {
      targetUrlObj = new URL(target);
    } catch (e) {
      return res.status(400).send('Invalid target URL');
    }

    let html = '';
    let contentType = 'text/html; charset=utf-8';

    // 1. Try axios standard request
    try {
      const resp = await axios.get(target, {
        responseType: 'text',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer': targetUrlObj.origin,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        timeout: 8000
      });
      html = resp.data;
    } catch (axiosErr) {
      // 2. If blocked by Cloudflare (403), use curl_cffi Chrome TLS impersonation
      const pyResp = await fetchWithCurlImpersonate(target);
      if (pyResp && pyResp.text && pyResp.status === 200) {
        html = pyResp.text;
        contentType = pyResp.content_type || contentType;
      } else {
        throw new Error(axiosErr.message || pyResp?.error || 'Target blocked access');
      }
    }

    // Inject <base href="..."> so relative paths (images, scripts, stylesheets) load from original domain
    if (typeof html === 'string') {
      const baseTag = `<base href="${targetUrlObj.origin}/">`;
      if (html.includes('<head>')) {
        html = html.replace('<head>', `<head>${baseTag}`);
      } else if (html.includes('<HEAD>')) {
        html = html.replace('<HEAD>', `<HEAD>${baseTag}`);
      } else {
        html = baseTag + html;
      }
    }

    // Set permissive CORS and remove framing blocks
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('Cross-Origin-Resource-Policy');
    res.removeHeader('Cross-Origin-Embedder-Policy');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', contentType);
    res.send(html);
  } catch (err) {
    res.status(500).send(`Unblock proxy error: ${err.message}`);
  }
});


const { sniffStream } = require('./sniffer');

// Universal Media & Webpage Stream Resolver (Zero-extension needed for mobile & desktop)
app.get('/api/resolve-url', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing url param' });


  // 1. YouTube direct handling if client already supports YouTube Iframe
  if (targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be')) {
    let videoId = '';
    const match = targetUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
    if (match) videoId = match[1];
    return res.json({ type: 'youtube', url: targetUrl, videoId });
  }

  // 2. Direct HLS (.m3u8 or master.txt)
  if (targetUrl.endsWith('.m3u8') || targetUrl.includes('.m3u8') || targetUrl.includes('master.txt')) {
    return res.json({ type: 'hls', url: targetUrl });
  }

  // 3. Direct Video file (.mp4, .webm)
  if (/\.(mp4|webm|mkv|mov)(\?.*)?$/i.test(targetUrl)) {
    return res.json({ type: 'direct', url: targetUrl });
  }

  // 4. Universal Python Bridge (yt-dlp, Dean Edwards Unpacker, MolySTREAM AES, VidMoly, Iframe Extraction)
  const bridgeRes = await runPythonBridge(targetUrl);
  if (bridgeRes.success) {
    if (bridgeRes.m3u8_body) {
      const cacheId = 'm3u8_' + Math.random().toString(36).substring(2, 10);
      m3u8Cache.set(cacheId, bridgeRes.m3u8_body);
      return res.json({
        type: 'hls',
        url: `/api/proxy/m3u8/${cacheId}`,
        title: bridgeRes.title,
        provider: bridgeRes.provider
      });
    }
    return res.json({
      type: bridgeRes.type || 'hls',
      url: bridgeRes.stream_url,
      title: bridgeRes.title,
      provider: bridgeRes.provider
    });
  }


  // 4. Direct Video file (.mp4, .webm)
  if (/\.(mp4|webm|mkv|mov)(\?.*)?$/i.test(targetUrl)) {
    return res.json({ type: 'direct', url: targetUrl });
  }

  // 5. Generic Webpage Scraping / Reverse Extraction

  try {
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': targetUrl
      },
      timeout: 8000
    });

    const html = response.data;
    if (typeof html === 'string') {
      // Regex search for .m3u8 in scripts
      const m3u8Match = html.match(/(?:file|source|src)\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i) ||
                        html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
      if (m3u8Match) {
        return res.json({
          type: 'hls',
          url: m3u8Match[1].replace(/\\/g, ''),
          sourcePage: targetUrl
        });
      }

      // Regex search for .mp4 in scripts
      const mp4Match = html.match(/(?:file|source|src)\s*:\s*["']([^"']+\.mp4[^"']*)["']/i) ||
                       html.match(/["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
      if (mp4Match) {
        return res.json({
          type: 'direct',
          url: mp4Match[1].replace(/\\/g, ''),
          sourcePage: targetUrl
        });
      }

      // Check DOM video/source tags
      const $ = cheerio.load(html);
      const srcTag = $('video source[src], video[src]').attr('src');
      if (srcTag) {
        const fullUrl = srcTag.startsWith('http') ? srcTag : new URL(srcTag, targetUrl).href;
        return res.json({
          type: fullUrl.includes('.m3u8') ? 'hls' : 'direct',
          url: fullUrl,
          sourcePage: targetUrl
        });
      }

      // Check for generic iframe embed player (VidMoly, Sibnet, Doodstream, YouTube, etc.)
      const iframeSrc = $('iframe[src]').attr('src');
      if (iframeSrc) {
        const fullIframe = iframeSrc.startsWith('http') ? iframeSrc : (iframeSrc.startsWith('//') ? 'https:' + iframeSrc : new URL(iframeSrc, targetUrl).href);
        return res.json({
          type: 'iframe',
          url: fullIframe,
          title: $('title').text().trim() || 'Embed Video',
          sourcePage: targetUrl
        });
      }
    }
  } catch (err) {
    console.warn(`[Resolve] Could not scrape stream from ${targetUrl}:`, err.message);
  }

  // 6. Puppeteer Headless Network Sniffer (Intercepts hidden .m3u8 / .mp4 streams from ANY unknown site)
  try {
    const sniffRes = await sniffStream(targetUrl, 7000);
    if (sniffRes && sniffRes.success && sniffRes.url) {
      return res.json({
        type: sniffRes.type || 'direct',
        url: sniffRes.url,
        title: sniffRes.title || 'Video Stream',
        provider: 'headless_sniffer'
      });
    }
  } catch (err) {
    console.warn(`[Sniffer] Could not sniff media:`, err.message);
  }

  // 7. Universal Fallback: Unblock Proxy (Strips X-Frame-Options, CSP, and CORP headers)
  // This ensures the site or player loads inside the room without ERR_BLOCKED_BY_RESPONSE
  return res.json({
    type: 'iframe',
    url: `/api/proxy/unblock?url=${encodeURIComponent(targetUrl)}`,
    originalUrl: targetUrl,
    title: 'Web Player (Unblocked)'
  });
});



io.on('connection', (socket) => {
  let currentRoomId = null;

  socket.on('join_room', ({ roomId, username }) => {
    currentRoomId = roomId || 'default-room';
    socket.join(currentRoomId);

    const room = getOrCreateRoom(currentRoomId);
    const isFirstUser = Object.keys(room.users).length === 0;

    room.users[socket.id] = {
      id: socket.id,
      name: username || `User_${socket.id.substring(0, 4)}`,
      isHost: isFirstUser
    };

    // Send current sync state to newcomer
    socket.emit('sync_init', {
      videoType: room.videoType,
      videoUrl: room.videoUrl,
      videoId: room.videoId,
      state: room.state,
      currentTime: calculateCurrentTime(room),
      playbackRate: room.playbackRate,
      users: Object.values(room.users),
      chat: room.chat,
      isHost: isFirstUser
    });

    // Notify others
    socket.to(currentRoomId).emit('user_joined', {
      user: room.users[socket.id],
      users: Object.values(room.users)
    });

    // Broadcast system message
    const sysMsg = {
      id: Date.now(),
      sender: 'System',
      text: `${room.users[socket.id].name} odaya katıldı.`,
      system: true,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    room.chat.push(sysMsg);
    io.to(currentRoomId).emit('chat_message', sysMsg);
  });

  // Play Event
  socket.on('video_play', ({ time }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.state = 'playing';
    room.currentTime = typeof time === 'number' ? time : calculateCurrentTime(room);
    room.lastUpdated = Date.now();

    socket.to(currentRoomId).emit('sync_play', {
      time: room.currentTime,
      sender: socket.id,
      timestamp: Date.now()
    });
  });

  // Pause Event
  socket.on('video_pause', ({ time }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.state = 'paused';
    room.currentTime = typeof time === 'number' ? time : calculateCurrentTime(room);
    room.lastUpdated = Date.now();

    socket.to(currentRoomId).emit('sync_pause', {
      time: room.currentTime,
      sender: socket.id,
      timestamp: Date.now()
    });
  });

  // Seek Event
  socket.on('video_seek', ({ time }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.currentTime = time;
    room.lastUpdated = Date.now();

    socket.to(currentRoomId).emit('sync_seek', {
      time: room.currentTime,
      state: room.state,
      sender: socket.id,
      timestamp: Date.now()
    });
  });

  // Change Media Source (YouTube, HLS m3u8, MP4, etc.)
  socket.on('change_video', ({ url, type, videoId }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.videoUrl = url;
    room.videoType = type || 'youtube';
    room.videoId = videoId || '';
    room.currentTime = 0;
    room.state = 'playing';
    room.lastUpdated = Date.now();

    const senderName = room.users[socket.id]?.name || 'Biri';

    io.to(currentRoomId).emit('sync_change_video', {
      videoUrl: room.videoUrl,
      videoType: room.videoType,
      videoId: room.videoId,
      currentTime: 0,
      state: 'playing',
      senderName
    });

    const sysMsg = {
      id: Date.now(),
      sender: 'System',
      text: `${senderName} yeni video yükledi.`,
      system: true,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    room.chat.push(sysMsg);
    io.to(currentRoomId).emit('chat_message', sysMsg);
  });

  // Heartbeat / Periodic Drift Correction (Host sends time every 3-5 seconds)
  socket.on('host_heartbeat', ({ time, state }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.users[socket.id]?.isHost) return;

    room.currentTime = time;
    room.state = state;
    room.lastUpdated = Date.now();

    // Broadcast soft sync to peers
    socket.to(currentRoomId).emit('sync_heartbeat', {
      serverTime: room.currentTime,
      state: room.state,
      timestamp: Date.now()
    });
  });

  // Real-time Chat
  socket.on('send_message', ({ text }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const user = room.users[socket.id];
    const msg = {
      id: Date.now(),
      senderId: socket.id,
      sender: user ? user.name : 'Anonim',
      text,
      system: false,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    room.chat.push(msg);
    if (room.chat.length > 100) room.chat.shift();

    io.to(currentRoomId).emit('chat_message', msg);
  });

  // Reaction / Emoji
  socket.on('send_reaction', ({ emoji }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    const userName = room?.users[socket.id]?.name || 'Anonim';
    io.to(currentRoomId).emit('show_reaction', { emoji, userName });
  });

  socket.on('disconnect', () => {
    if (currentRoomId && rooms.has(currentRoomId)) {
      const room = rooms.get(currentRoomId);
      const departingUser = room.users[socket.id];
      delete room.users[socket.id];

      // Reassign host if host left
      if (departingUser?.isHost) {
        const remainingIds = Object.keys(room.users);
        if (remainingIds.length > 0) {
          room.users[remainingIds[0]].isHost = true;
          io.to(currentRoomId).emit('new_host', { hostId: remainingIds[0] });
        }
      }

      socket.to(currentRoomId).emit('user_left', {
        userId: socket.id,
        users: Object.values(room.users)
      });

      if (departingUser) {
        const sysMsg = {
          id: Date.now(),
          sender: 'System',
          text: `${departingUser.name} odadan ayrıldı.`,
          system: true,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        room.chat.push(sysMsg);
        io.to(currentRoomId).emit('chat_message', sysMsg);
      }

      // Cleanup room if empty after 10 mins
      if (Object.keys(room.users).length === 0) {
        setTimeout(() => {
          if (rooms.has(currentRoomId) && Object.keys(rooms.get(currentRoomId).users).length === 0) {
            rooms.delete(currentRoomId);
          }
        }, 600000);
      }
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  🎬 WatchTogether & WatchParty Real-Time Server`);
  console.log(`  Listening at: http://localhost:${PORT}`);
  console.log(`  Engineered with WebSocket Sync & Multi-Provider Support`);
  console.log(`======================================================\n`);
});
