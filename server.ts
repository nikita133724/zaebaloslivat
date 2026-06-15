import express from 'express';
import next from 'next';
import { createServer } from 'http';
import { Server } from 'socket.io';
import WebSocket from 'ws';
import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import { formatISO } from 'date-fns';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const PORT = Number(process.env.PORT) || 3000;

// Configuration
const MIRROR_URL = 'https://zref.pro';

const normalizeUrl = (u: string) => u ? u.replace(/\/$/, '').trim() : '';
const MAX_MESSAGES = 100;

export interface AppConfigState {
  targetUserId: string;
  useAutoMirror: boolean;
  customMirrorUrl: string;
  onlyTargetUser: boolean;
}

const configState: AppConfigState = {
  targetUserId: '25945',
  useAutoMirror: true,
  customMirrorUrl: '',
  onlyTargetUser: true,
};

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
  rawProfile?: string;
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
  if (!configState.useAutoMirror && configState.customMirrorUrl) {
    const manualUrl = normalizeUrl(configState.customMirrorUrl);
    console.log('Using manual custom domain override:', manualUrl);
    return manualUrl;
  }

  console.log('Fetching domain from zref.pro...');
  
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'python-requests/2.31.0',
    'Mozilla/5.0',
    ''
  ];

  let lastError: any = null;

  for (const ua of userAgents) {
    try {
      console.log(`Trying domain fetch with User-Agent: "${ua || 'Default'}"`);
      
      const config: any = {
        httpsAgent,
        timeout: 15000,
        validateStatus: (status: number) => status < 500
      };

      if (ua) {
        config.headers = {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        };
      }

      const response = await axios.get(MIRROR_URL, config);
      const html = response.data;
      
      if (response.status === 403) {
        console.warn(`Fetch returned 403 status with UA: "${ua}"`);
        continue; // Try next UA
      }

      if (typeof html !== 'string') {
        console.warn('Response is not a string, type is:', typeof html);
        continue;
      }

      const finalUrl = response.request?.res?.responseUrl || '';
      console.log(`Success! Response status: ${response.status}, body size: ${html.length}, final redirect URL: ${finalUrl}`);

      const normalizedFinal = normalizeUrl(finalUrl);
      const normalizedMirror = normalizeUrl(MIRROR_URL);

      if (normalizedFinal && normalizedFinal !== normalizedMirror && normalizedFinal.startsWith('http')) {
        return normalizedFinal;
      }

      // 1. Enhanced Meta Refresh Regex (support more variations including Python-style)
      let match = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url\s*=\s*([^"';\s]+)/i);
      
      if (!match) {
        match = html.match(/content=['"][^'"]*url\s*=\s*([^'"]+)/i);
      }

      if (!match) {
        match = html.match(/(?:window\.location|location\.href|location)\s*=\s*['"]([^'"]+)['"]/i);
      }

      if (!match) {
        match = html.match(/location\.replace\(['"]([^'"]+)['"]\)/i);
      }

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

      // Scan HTML for emergency backups
      const urlRegex = /https?:\/\/[^\s"'<>]+/g;
      const urls = html.match(urlRegex) || [];
      for (const u of urls) {
        if (!u.includes('zref.pro') && !u.includes('w3.org') && !u.includes('schema.org') && !u.includes('google')) {
          console.log('Emergency fallback: found valid URL inside body:', u);
          return u.replace(/\/$/, '');
        }
      }

      // Check for links
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

      if (html.length > 0) {
        console.warn('HTML Debug (fragment matching failed). Full body is:', html);
      }
    } catch (err: any) {
      console.warn(`Fetch error with UA "${ua}":`, err.message);
      lastError = err;
    }
  }

  throw lastError || new Error('Could not find actual domain using any User-Agent configurations.');
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
  
  const nickEl = $('.rightBlockChatMessageNick');
  const nickname = cleanText(nickEl.attr('data-chat-quote-name') || nickEl.text());
  const message = cleanText($('.rightBlockChatMessageText').text());
  const messageTime = cleanText($('.rightBlockChatMessageTimeBlock').text());
  const rawAvatar = $('img').first().attr('src') || '';
  const badge = cleanText($('.rightBlockHeaderAvatarFlag').text());
  const classes = (root.attr('class') || '').split(/\s+/).filter(Boolean);

  const messageId = root.attr('data-message-id') || Math.random().toString(36).substring(7);

  return {
    id: messageId,
    timeISO: new Date().toISOString(),
    nickname,
    message,
    messageTime,
    profile: joinUrl(siteBaseUrl, rawProfile),
    rawProfile,
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
    io?.emit('active_domain', siteBaseUrl);
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
    socket.emit('active_domain', siteBaseUrl);
    socket.emit('config_update', configState);
    
    socket.on('disconnect', () => {
      console.log('Client disconnected');
    });
  });

  // Server time endpoint (optional, but good for sync)
  server.get('/api/server-time', (req, res) => {
    res.json({ time: new Date().toISOString() });
  });

  // Allowed manual configuration input from frontend
  server.use(express.json());

  server.get('/api/domen-settings', (req, res) => {
    res.json(configState);
  });

  server.post('/api/domen-settings', async (req, res) => {
    const { targetUserId, useAutoMirror, customMirrorUrl, onlyTargetUser } = req.body;
    
    const prevUseAuto = configState.useAutoMirror;
    const prevCustomUrl = configState.customMirrorUrl;

    if (typeof targetUserId === 'string') configState.targetUserId = targetUserId.trim();
    if (typeof useAutoMirror === 'boolean') configState.useAutoMirror = useAutoMirror;
    if (typeof customMirrorUrl === 'string') configState.customMirrorUrl = customMirrorUrl.trim();
    if (typeof onlyTargetUser === 'boolean') configState.onlyTargetUser = onlyTargetUser;

    console.log('Updated configuration settings:', configState);

    // Notify all active clients in real-time
    io?.emit('config_update', configState);

    // Reconnect to Centrifugo if mirror settings changed
    if (prevUseAuto !== configState.useAutoMirror || prevCustomUrl !== configState.customMirrorUrl) {
      console.log('Mirror configuration changed. Recalculating domain connection...');
      try {
        connectToCentrifugo();
      } catch (err: any) {
        console.error('Reconnection to custom Centrifugo failed:', err.message);
      }
    }

    res.json({ success: true, config: configState });
  });

  server.post('/api/config', async (req, res) => {
    const { customMirror, customWsUrl, customToken } = req.body;
    if (customMirror) {
      console.log('Received manual mirror override:', customMirror);
      siteBaseUrl = customMirror;
      try {
        const config = await fetchCentrifugeConfig();
        wsUrl = config.wsUrl;
        token = config.token;
        connectToCentrifugo();
        return res.json({ success: true, siteBaseUrl, wsUrl });
      } catch (e: any) {
        return res.status(400).json({ success: false, error: e.message });
      }
    }
    if (customWsUrl && customToken) {
      console.log('Received manual centrifuge config override');
      wsUrl = customWsUrl;
      token = customToken;
      if (customMirror) siteBaseUrl = customMirror;
      connectToCentrifugo();
      return res.json({ success: true, wsUrl });
    }
    res.status(400).json({ error: 'Invalid config' });
  });

  server.all(/.*/, (req, res) => {
    return handle(req, res);
  });

  httpServer.listen(PORT, () => {
    console.log(`> Ready on http://localhost:${PORT}`);
  });
});
