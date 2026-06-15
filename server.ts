import express from 'express';
import next from 'next';
import { createServer } from 'http';
import { Server } from 'socket.io';
import WebSocket from 'ws';
import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import { formatISO } from 'date-fns';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const PORT = 3000;

// Configuration
const MIRROR_URL = 'https://zref.pro';
const TARGET_USER = '/user/124646';
const MAX_MESSAGES = 100;

// Watchdog / Reliability constants (from Python)
const PONG_TIMEOUT = 90000;
const SILENT_SOCKET_TIMEOUT = 240000;
const DOMAIN_CHECK_INTERVAL = 60000;
const PLANNED_RECONNECT_MIN = 3600000;
const PLANNED_RECONNECT_MAX = 5400000;
const MIN_ALIVE_HTML_SIZE = 1000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

// Centrifuge Constants
const METHOD_CONNECT = 0;
const METHOD_SUBSCRIBE = 1;
const METHOD_PING = 7;

const PUSH_PUBLICATION = 0;

interface ChatMessage {
  id: string;
  timeISO: string;
  nickname: string;
  message: string;
  messageTime: string;
  profile: string;
  avatar: string;
  badge: string;
  classes: string[];
}

let messages: ChatMessage[] = [];
let siteBaseUrl = '';
let wsUrl = '';
let token = '';

// Reliability State
const state = {
  lastPacketTime: Date.now(),
  lastConnectedTime: 0,
  plannedReconnectAt: 0,
  retryCount: 0,
  isDomainDead: false
};

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function fetchActualDomain() {
  console.log('Fetching domain from zref.pro...');
  try {
    const response = await axios.get(MIRROR_URL, {
      httpsAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      maxRedirects: 10,
      timeout: 30000,
      validateStatus: (status) => status < 500
    });
    
    const html = response.data;
    if (typeof html !== 'string') {
      console.warn('Response is not a string, type is:', typeof html);
      throw new Error('Response is not HTML string');
    }

    const finalUrl = response.request?.res?.responseUrl || '';
    console.log(`Initial domain fetch response status: ${response.status}, body size: ${html.length}, final redirect URL: ${finalUrl}`);

    // If Axios finished on a different domain, automatically treat it as the actual domain
    if (finalUrl && finalUrl !== MIRROR_URL && finalUrl.startsWith('http')) {
      return finalUrl.replace(/\/$/, '');
    }

    // 1. Enhanced Meta Refresh Regex (support more variations including Python-style)
    let match = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url\s*=\s*([^"';\s]+)/i);
    
    // 2. Simple content-url pattern
    if (!match) {
        match = html.match(/content=['"][^'"]*url\s*=\s*([^'"]+)/i);
    }

    // 3. JS Redirect Detection (window.location, location.href, location.replace)
    if (!match) {
      match = html.match(/(?:window\.location|location\.href|location)\s*=\s*['"]([^'"]+)['"]/i);
    }

    // 4. Look for location.replace('...') or location.replace("...")
    if (!match) {
      match = html.match(/location\.replace\(['"]([^'"]+)['"]\)/i);
    }

    // 5. Look for the pattern URL=... (from user's python code)
    if (!match) {
      match = html.match(/URL\s*=\s*(https?:\/\/[^"'>\s]+)/i);
    }

    if (match) {
      let url = match[1].replace(/['"]/g, '').trim();
      if (!url.startsWith('http')) {
        try {
          url = new URL(url, MIRROR_URL).toString();
        } catch (e) {}
      }
      if (url.startsWith('http')) {
        console.log('Found redirected URL from regex pattern:', url);
        return url.replace(/\/$/, '');
      }
    }

    // 6. Generic emergency backup finder: scan the HTML response for any absolute URL that isn't zref.pro, w3, etc.
    const urlRegex = /https?:\/\/[^\s"'<>]+/g;
    const urls = html.match(urlRegex) || [];
    for (const u of urls) {
      if (!u.includes('zref.pro') && !u.includes('w3.org') && !u.includes('schema.org') && !u.includes('google')) {
        console.log('Emergency fallback: found a valid target URL inside body:', u);
        return u.replace(/\/$/, '');
      }
    }

    // Check for bridges (if page contains a link to another site)
    const $ = cheerio.load(html);
    const externalLinks = $('a[href^="http"]').filter((i, el) => {
        const href = $(el).attr('href');
        return !!href && !href.includes('zref.pro');
    });

    if (externalLinks.length > 0) {
        const link = externalLinks.first().attr('href')!;
        console.log('Found alternative bridge link in external links:', link);
        return link.replace(/\/$/, '');
    }

    if (html.length > 50) {
        console.warn('HTML Debug (fragment matching failed):', html.substring(0, 500));
    }
    throw new Error(`Could not find actual domain. Body size: ${html.length}`);
  } catch (err: any) {
    console.error('Error fetching domain:', err.message);
    throw err;
  }
}

async function fetchCentrifugeConfig() {
  const baseUrl = await fetchActualDomain();
  console.log('Fetching Centrifugo config from', baseUrl);
  
  const response = await axios.get(baseUrl + '/', {
    httpsAgent,
    headers: HEADERS,
    timeout: 25000
  });
  const html = response.data;

  if (!html || html.length < MIN_ALIVE_HTML_SIZE) {
    throw new Error('Response too small or empty');
  }

  const wsMatch = html.match(/centrifugoSocket\s*=\s*['"]([^'"]+)['"]/);
  const tokenMatch = html.match(/centrifugoSecret\s*=\s*['"]([^'"]+)['"]/);

  if (!wsMatch || !tokenMatch) {
    throw new Error('Centrifugo config not found in HTML');
  }

  return {
    siteBaseUrl: baseUrl,
    wsUrl: wsMatch[1],
    token: tokenMatch[1]
  };
}

function cleanText(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function joinUrl(base: string, path: string) {
  if (!path) return '';
  if (path.startsWith('http')) return path;
  const baseUrl = base || 'https://zref.pro';
  return baseUrl.replace(/\/$/, '') + (path.startsWith('/') ? '' : '/') + path;
}

function parseChatHtml(html: string) {
  const $ = cheerio.load(html);
  const root = $('.rightBlockChatMessageBlock');
  if (root.length === 0) return null;

  const profileLink = $('a.rightBlockChatAvatarLink, a[href^="/user/"]').first();
  const rawProfile = profileLink.attr('href') || '';
  
  // We only care about TARGET_USER
  if (rawProfile !== TARGET_USER) return null;

  const nickname = cleanText($('.rightBlockChatMessageNick').text());
  const message = cleanText($('.rightBlockChatMessageText').text());
  const messageTime = cleanText($('.rightBlockChatMessageTimeBlock').text());
  const rawAvatar = $('img').first().attr('src') || '';
  const badge = cleanText($('.rightBlockHeaderAvatarFlag').text());
  const classes = (root.attr('class') || '').split(/\s+/).filter(Boolean);

  return {
    id: Math.random().toString(36).substring(7),
    timeISO: new Date().toISOString(),
    nickname,
    message,
    messageTime,
    profile: joinUrl(siteBaseUrl, rawProfile),
    avatar: joinUrl(siteBaseUrl, rawAvatar),
    badge,
    classes
  };
}

let ws: WebSocket | null = null;
let io: Server | null = null;
let pingInterval: NodeJS.Timeout | null = null;
let watchdogInterval: NodeJS.Timeout | null = null;

async function connectToCentrifugo() {
  if (ws) {
    ws.terminate();
  }

  try {
    const config = await fetchCentrifugeConfig();
    siteBaseUrl = config.siteBaseUrl;
    wsUrl = config.wsUrl;
    token = config.token;
    state.isDomainDead = false;
  } catch (err) {
    console.error('Failed to get config, retrying in 10s...');
    setTimeout(connectToCentrifugo, 10000);
    return;
  }

  console.log('Connecting to Centrifugo:', wsUrl);
  ws = new WebSocket(wsUrl, {
    headers: {
      'Origin': siteBaseUrl,
      'User-Agent': 'Mozilla/5.0'
    },
    rejectUnauthorized: false
  });

  let messageId = 1;
  state.lastConnectedTime = Date.now();
  state.lastPacketTime = Date.now();
  state.plannedReconnectAt = Date.now() + Math.floor(Math.random() * (PLANNED_RECONNECT_MAX - PLANNED_RECONNECT_MIN) + PLANNED_RECONNECT_MIN);

  ws.on('open', () => {
    console.log('Connected to Centrifugo WS');
    state.retryCount = 0;
    ws?.send(JSON.stringify({
      id: messageId++,
      method: METHOD_CONNECT,
      params: { token }
    }));
  });

  ws.on('message', (data) => {
    state.lastPacketTime = Date.now();
    const raw = data.toString();
    const lines = raw.split('\n').filter(l => l.trim());
    
    for (const line of lines) {
      try {
        const packet = JSON.parse(line);

        if (packet.id === 1 && !packet.error) {
          ws?.send(JSON.stringify({
            id: messageId++,
            method: METHOD_SUBSCRIBE,
            params: { channel: 'chat' }
          }));
        }

        const result = packet.result;
        if (result && result.type === PUSH_PUBLICATION && result.channel === 'chat') {
          const publicationData = result.data;
          if (publicationData && publicationData.data && publicationData.data.html) {
            const parsed = parseChatHtml(publicationData.data.html);
            if (parsed) {
              messages.push(parsed);
              if (messages.length > MAX_MESSAGES) messages.shift();
              io?.emit('chat_message', parsed);
            }
          }
        }
      } catch (err) {}
    }
  });

  ws.on('error', (err) => {
    console.error('Centrifugo WS Error:', err.message);
  });

  ws.on('close', () => {
    console.log('Centrifugo WS Closed. Reconnecting...');
    if (pingInterval) clearInterval(pingInterval);
    if (watchdogInterval) clearInterval(watchdogInterval);
    
    const delay = Math.min(30000, 1000 * Math.pow(2, state.retryCount++));
    setTimeout(connectToCentrifugo, delay);
  });

  // Ping loop
  pingInterval = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ id: messageId++, method: METHOD_PING }));
    }
  }, 25000);

  // Watchdog loop
  watchdogInterval = setInterval(() => {
    const now = Date.now();
    
    // Silent socket check
    if (now - state.lastPacketTime > SILENT_SOCKET_TIMEOUT) {
      console.log('Watchdog: Socket silent, forcing reconnect...');
      ws?.terminate();
      return;
    }

    // Planned reconnect
    if (now > state.plannedReconnectAt) {
      console.log('Watchdog: Planned reconnect...');
      ws?.terminate();
      return;
    }
  }, 10000);
}

// Periodic domain check loop
setInterval(async () => {
  if (!siteBaseUrl) return;
  try {
    const freshDomain = await fetchActualDomain();
    if (freshDomain !== siteBaseUrl) {
      console.log('Mirror changed:', siteBaseUrl, '->', freshDomain);
      ws?.terminate();
    }
  } catch (e) {}
}, DOMAIN_CHECK_INTERVAL);

// Status logging loop
setInterval(() => {
  const wsStatus = ws?.readyState === WebSocket.OPEN ? 'OK' : (ws?.readyState === WebSocket.CONNECTING ? 'Connecting' : 'Closed');
  console.log(`[STATUS] WS: ${wsStatus}, Messages: ${messages.length}, Mirror: ${siteBaseUrl || 'None'}, Retry: ${state.retryCount}`);
}, 60000);

app.prepare().then(async () => {
  const server = express();
  const httpServer = createServer(server);
  io = new Server(httpServer);

  try {
    connectToCentrifugo();
  } catch (err) {
    console.error('Initial connection failed:', err);
  }

  // Socket.io connection
  io.on('connection', (socket) => {
    console.log('New client connected');
    socket.emit('init_messages', messages);
    
    socket.on('disconnect', () => {
      console.log('Client disconnected');
    });
  });

  // Server time endpoint (optional, but good for sync)
  server.get('/api/server-time', (req, res) => {
    res.json({ time: new Date().toISOString() });
  });

  server.all('*', (req, res) => {
    return handle(req, res);
  });

  httpServer.listen(PORT, () => {
    console.log(`> Ready on http://localhost:${PORT}`);
  });
});
