import express from 'express';
import next from 'next';
import { createServer } from 'http';
import { Server } from 'socket.io';
import WebSocket from 'ws';
import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';

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
const MIN_RETRY = 1000;
const MAX_RETRY = 20000;

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
const PUSH_MESSAGE = 4;

interface ChatMessage {
  id: string;
  event: 'chat_message' | 'raw_chat_html' | 'raw_chat_publication' | 'message' | 'parse_error' | 'raw_non_json' | 'command_error';
  timeISO: string;
  channel?: string;
  nickname?: string;
  message?: string;
  messageTime?: string;
  profile?: string;
  rawProfile?: string;
  avatar?: string;
  badge?: string;
  classes: string[];
  text?: string;
  raw?: unknown;
  data?: unknown;
  error?: string;
  payloadType?: unknown;
}

let messages: ChatMessage[] = [];
let siteBaseUrl = '';
let wsUrl = '';
let token = '';

// Reliability State
const state = {
  packets: 0,
  chatMessages: 0,
  raws: 0,
  lastChatText: '',
  lastPacketTime: Date.now(),
  lastPongTime: Date.now(),
  lastPingSent: 0,
  pendingPingId: 0,
  pendingPingTime: 0,
  lastConnectedTime: 0,
  plannedReconnectAt: 0,
  plannedReconnectAfter: 0,
  retryCount: 0,
  isDomainDead: false,
  reconnectReason: ''
};

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function getRetryInterval(retries: number) {
  const jitter = 0.5 * Math.random();
  const interval = Math.min(MAX_RETRY, MIN_RETRY * (2 ** (retries + 1)));
  return Math.max(1000, Math.floor((1 - jitter) * interval));
}

function shortSecret(value: string, count = 10) {
  const clean = cleanText(value);
  return clean.length <= count ? clean : `${clean.slice(0, count)}...`;
}

async function httpGetText(url: string, timeout = 25000) {
  const response = await axios.get(url, {
    httpsAgent,
    timeout,
    maxRedirects: 5,
    responseType: 'text',
    transformResponse: (data) => data,
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  return {
    text: String(response.data || ''),
    finalUrl: response.request?.res?.responseUrl || response.config.url || url,
  };
}

async function fetchActualDomain() {
  if (!configState.useAutoMirror && configState.customMirrorUrl) {
    const manualUrl = normalizeUrl(configState.customMirrorUrl);
    console.log('Using manual custom domain override:', manualUrl);
    return manualUrl;
  }

  console.log('Fetching domain from zref.pro...');

  const { text: page, finalUrl } = await httpGetText(MIRROR_URL, 25000);

  let match = page.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url\s*=\s*([^"';\s]+)/i);

  if (!match) {
    match = page.match(/URL\s*=\s*(https?:\/\/[^"'>\s]+)/i);
  }

  if (match) {
    const siteUrl = normalizeUrl(new URL(match[1].trim(), MIRROR_URL).toString());
    console.log(`Actual domain: ${siteUrl}`);
    return siteUrl;
  }

  if (finalUrl && finalUrl.startsWith('http')) {
    const siteUrl = normalizeUrl(finalUrl);
    console.log(`Actual domain: ${siteUrl}`);
    return siteUrl;
  }

  throw new Error('Could not find actual domain through zref.pro');
}

async function fetchCentrifugeConfig(forcedBaseUrl?: string) {
  const baseUrl = forcedBaseUrl ? normalizeUrl(forcedBaseUrl) : await fetchActualDomain();
  console.log('Fetching Centrifugo config from', baseUrl);

  const { text: html } = await httpGetText(baseUrl + '/', 25000);

  if (!html || html.length < MIN_ALIVE_HTML_SIZE) {
    throw new Error('Response too small or empty');
  }

  const wsMatch = html.match(/centrifugoSocket\s*=\s*['"]([^'"]+)['"]/);
  const tokenMatch = html.match(/centrifugoSecret\s*=\s*['"]([^'"]+)['"]/);

  if (!wsMatch || !tokenMatch) {
    throw new Error('Centrifugo config not found in HTML');
  }

  const fetchedWsUrl = cleanText(wsMatch[1]);
  const fetchedToken = cleanText(tokenMatch[1]);
  console.log(`Centrifugo config: url=${fetchedWsUrl}, token=${shortSecret(fetchedToken)}`);

  return {
    siteBaseUrl: baseUrl,
    wsUrl: fetchedWsUrl,
    token: fetchedToken
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

function parseChatHtml(html: string): ChatMessage | null {
  const $ = cheerio.load(html);
  const root = $('.rightBlockChatMessageBlock').first();
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
    event: 'chat_message' as const,
    timeISO: new Date().toISOString(),
    channel: 'chat',
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

function extractChatHtml(publication: any) {
  const data = publication?.data ?? publication;

  if (!data || typeof data !== 'object') {
    return { html: '', payloadType: undefined };
  }

  const payloadType = data.type;

  if (typeof data.html === 'string') {
    return { html: data.html, payloadType };
  }

  if (data.data && typeof data.data.html === 'string') {
    return { html: data.data.html, payloadType };
  }

  if (data.data?.data && typeof data.data.data.html === 'string') {
    return { html: data.data.data.html, payloadType: data.data.type ?? payloadType };
  }

  return { html: '', payloadType };
}

function rememberAndEmit(item: ChatMessage) {
  messages.push(item);
  if (messages.length > MAX_MESSAGES) messages.shift();
  io?.emit('chat_message', item);
}

function handleChatPublication(publicationData: unknown) {
  const { html, payloadType } = extractChatHtml(publicationData);

  if (html) {
    const parsed = parseChatHtml(html);

    if (parsed) {
      parsed.payloadType = payloadType;
      rememberAndEmit(parsed);
      state.chatMessages += 1;
      state.lastChatText = `${parsed.messageTime || '--:--'} | ${parsed.nickname || 'unknown'}: ${parsed.message || ''}`.slice(0, 200);
      console.log(`[CHAT] ${parsed.messageTime || '--:--'} | ${parsed.nickname || 'unknown'}: ${parsed.message || ''}`);
      return;
    }

    const rawItem: ChatMessage = {
      id: `raw-chat-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      event: 'raw_chat_html',
      timeISO: new Date().toISOString(),
      channel: 'chat',
      classes: [],
      payloadType,
      raw: publicationData,
      text: html,
    };
    rememberAndEmit(rawItem);
    state.raws += 1;
    return;
  }

  const rawItem: ChatMessage = {
    id: `raw-publication-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    event: 'raw_chat_publication',
    timeISO: new Date().toISOString(),
    channel: 'chat',
    classes: [],
    payloadType,
    raw: publicationData,
  };
  rememberAndEmit(rawItem);
  state.raws += 1;
}

let ws: WebSocket | null = null;
let io: Server | null = null;
let pingInterval: NodeJS.Timeout | null = null;
let watchdogInterval: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let isConnecting = false;
const intentionallyClosedSockets = new WeakSet<WebSocket>();

function clearConnectionTimers() {
  if (pingInterval) clearInterval(pingInterval);
  if (watchdogInterval) clearInterval(watchdogInterval);
  pingInterval = null;
  watchdogInterval = null;
}

function scheduleReconnect(reason: string, delay = getRetryInterval(state.retryCount)) {
  state.reconnectReason = reason;

  if (reconnectTimer) clearTimeout(reconnectTimer);

  console.log(`[RECONNECT] ${reason}, reconnect in ${(delay / 1000).toFixed(1)}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToCentrifugo();
  }, delay);
}

function closeCurrentSocket(reason: string) {
  state.reconnectReason = reason;
  if (!ws) return;
  intentionallyClosedSockets.add(ws);
  ws.terminate();
  ws = null;
}

async function isDomainAlive(baseUrl: string) {
  try {
    const host = baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '').split('/')[0];
    const checkUrl = `http://${host}`;
    const response = await axios.get(checkUrl, {
      timeout: 5000,
      maxRedirects: 5,
      responseType: 'arraybuffer',
      httpsAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      validateStatus: () => true,
    });

    const size = Buffer.isBuffer(response.data)
      ? response.data.length
      : Buffer.byteLength(String(response.data || ''));

    return response.status >= 200 && response.status < 300 && size > MIN_ALIVE_HTML_SIZE;
  } catch (err: any) {
    console.log('[DOMAIN CHECK ERROR]', err.message);
    return false;
  }
}

async function connectToCentrifugo() {
  if (isConnecting) {
    console.log('Centrifugo connect is already in progress, skipping duplicate call');
    return;
  }

  isConnecting = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (ws) {
    closeCurrentSocket('manual_reconnect');
  }

  try {
    const config = await fetchCentrifugeConfig();
    siteBaseUrl = config.siteBaseUrl;
    wsUrl = config.wsUrl;
    token = config.token;
    state.isDomainDead = false;
    state.reconnectReason = '';
    state.pendingPingId = 0;
    state.pendingPingTime = 0;
    state.lastPacketTime = 0;
    state.lastPongTime = 0;
    state.lastConnectedTime = 0;
    state.plannedReconnectAfter = Math.floor(Math.random() * (PLANNED_RECONNECT_MAX - PLANNED_RECONNECT_MIN) + PLANNED_RECONNECT_MIN);
    io?.emit('active_domain', siteBaseUrl);
  } catch (err: any) {
    console.error('Failed to get config:', err.message);
    const delay = getRetryInterval(state.retryCount);
    state.retryCount = Math.min(state.retryCount + 1, 10);
    isConnecting = false;
    scheduleReconnect('config_fetch_failed', delay);
    return;
  }

  console.log('Connecting to Centrifugo:', wsUrl);
  const socket = new WebSocket(wsUrl, {
    headers: {
      'Origin': siteBaseUrl,
      'User-Agent': 'Mozilla/5.0'
    },
    rejectUnauthorized: false
  });
  ws = socket;

  let messageId = 1;
  let connectId = 0;
  let connected = false;
  state.lastConnectedTime = Date.now();
  state.lastPacketTime = Date.now();
  state.lastPongTime = Date.now();
  state.plannedReconnectAt = Date.now() + state.plannedReconnectAfter;

  socket.on('open', () => {
    console.log('Connected to Centrifugo WS');
    isConnecting = false;
    state.retryCount = 0;
    connectId = messageId++;
    socket.send(JSON.stringify({
      id: connectId,
      method: METHOD_CONNECT,
      params: { token }
    }));
  });

  socket.on('message', (data) => {
    state.lastPacketTime = Date.now();
    state.packets += 1;
    const raw = data.toString();
    const lines = raw.split('\n').filter(l => l.trim());
    
    for (const line of lines) {
      try {
        const packet = JSON.parse(line);

        if (packet.id === connectId) {
          if (packet.error) {
            throw new Error(`CONNECT ERROR: ${JSON.stringify(packet.error)}`);
          }

          connected = true;
          const client = packet.result?.client || '';
          console.log('[OK] Centrifuge connected', client);

          socket.send(JSON.stringify({
            id: messageId++,
            method: METHOD_SUBSCRIBE,
            params: { channel: 'chat' }
          }));
          console.log('[OK] subscribed: chat');
          continue;
        }

        if (packet.id) {
          if (packet.id === state.pendingPingId) {
            state.pendingPingId = 0;
            state.pendingPingTime = 0;
            state.lastPongTime = Date.now();
            continue;
          }

          if (packet.error) {
            const item: ChatMessage = {
              id: `command-error-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              event: 'command_error',
              timeISO: new Date().toISOString(),
              classes: [],
              raw: packet.error,
            };
            rememberAndEmit(item);
            state.raws += 1;
            console.log('[COMMAND ERROR]', packet.error);
          }
          continue;
        }

        const result = packet.result;
        if (result && result.type === PUSH_PUBLICATION && result.channel === 'chat') {
          handleChatPublication(result.data);
        } else if (!result && packet.data) {
          handleChatPublication(packet);
        } else if (result && result.type === PUSH_MESSAGE) {
          const item: ChatMessage = {
            id: `message-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            event: 'message',
            timeISO: new Date().toISOString(),
            channel: result.channel,
            classes: [],
            data: result.data,
          };
          rememberAndEmit(item);
          state.raws += 1;
        }
      } catch (err: any) {
        const item: ChatMessage = {
          id: `parse-error-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          event: 'parse_error',
          timeISO: new Date().toISOString(),
          classes: [],
          error: err.message,
          raw: line,
        };
        rememberAndEmit(item);
        state.raws += 1;
        console.log('[PARSE ERROR]', err.message);
      }
    }
  });

  socket.on('error', (err) => {
    console.error('Centrifugo WS Error:', err.message);
  });

  socket.on('close', () => {
    isConnecting = false;
    clearConnectionTimers();

    if (ws === socket) {
      ws = null;
    }

    if (intentionallyClosedSockets.has(socket)) {
      console.log('Centrifugo WS closed intentionally');
      return;
    }

    if (!connected) {
      state.reconnectReason = 'closed_before_connect';
    }

    console.log('Centrifugo WS Closed. Reconnecting...');
    const delay = getRetryInterval(state.retryCount);
    state.retryCount = Math.min(state.retryCount + 1, 10);
    scheduleReconnect(state.reconnectReason || 'socket_closed', delay);
  });

  // Ping loop
  pingInterval = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN && connected) {
      const pingId = messageId++;
      state.pendingPingId = pingId;
      state.pendingPingTime = Date.now();
      state.lastPingSent = Date.now();
      socket.send(JSON.stringify({ id: pingId, method: METHOD_PING }));
    }
  }, 25000);

  // Watchdog loop
  watchdogInterval = setInterval(() => {
    const now = Date.now();

    if (socket.readyState !== WebSocket.OPEN) return;

    // PONG check
    if (state.pendingPingTime && now - state.pendingPingTime >= PONG_TIMEOUT) {
      console.log(`[WATCHDOG] No PONG for ${PONG_TIMEOUT / 1000}s, reconnecting...`);
      state.reconnectReason = 'ping_timeout';
      socket.terminate();
      return;
    }
    
    // Silent socket check
    if (now - state.lastPacketTime > SILENT_SOCKET_TIMEOUT) {
      console.log(`[WATCHDOG] No packets for ${SILENT_SOCKET_TIMEOUT / 1000}s, reconnecting...`);
      state.reconnectReason = 'silent_socket';
      socket.terminate();
      return;
    }

    // Planned reconnect
    if (now > state.plannedReconnectAt) {
      console.log(`[WATCHDOG] Planned reconnect after ${Math.round(state.plannedReconnectAfter / 1000)}s, reconnecting...`);
      state.reconnectReason = 'planned_refresh';
      socket.terminate();
      return;
    }
  }, 10000);
}

// Periodic domain check loop
setInterval(async () => {
  if (!siteBaseUrl) return;
  try {
    const alive = await isDomainAlive(siteBaseUrl);
    if (alive) return;

    console.log('[DOMAIN DEAD]', siteBaseUrl);
    state.isDomainDead = true;
    state.reconnectReason = 'domain_dead';

    if (ws) {
      ws.terminate();
    } else {
      scheduleReconnect('domain_dead', getRetryInterval(state.retryCount));
    }
  } catch (e: any) {
    console.log('[DOMAIN CHECK ERROR]', e.message);
  }
}, DOMAIN_CHECK_INTERVAL);

// Status logging loop
setInterval(() => {
  const wsStatus = ws?.readyState === WebSocket.OPEN ? 'ok' : (ws?.readyState === WebSocket.CONNECTING ? 'connecting' : 'нет подключения');
  const packetAge = state.lastPacketTime ? Math.floor((Date.now() - state.lastPacketTime) / 1000) : 0;
  const pongAge = state.lastPongTime ? Math.floor((Date.now() - state.lastPongTime) / 1000) : 0;
  console.log(
    `[STATUS] ws=${wsStatus}; domain=${siteBaseUrl || 'нет домена'}; ` +
    `packets=${state.packets}; chat=${state.chatMessages}; raw=${state.raws}; ` +
    `last=${state.lastChatText || 'пока не было'}; packet_age=${packetAge}s; pong_age=${pongAge}s`
  );
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
      connectToCentrifugo();
    }

    res.json({ success: true, config: configState });
  });

  server.post('/api/config', async (req, res) => {
    const { customMirror, customWsUrl, customToken } = req.body;
    if (customMirror) {
      console.log('Received manual mirror override:', customMirror);
      siteBaseUrl = customMirror;
      try {
        const config = await fetchCentrifugeConfig(customMirror);
        wsUrl = config.wsUrl;
        token = config.token;
        configState.useAutoMirror = false;
        configState.customMirrorUrl = normalizeUrl(customMirror);
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
