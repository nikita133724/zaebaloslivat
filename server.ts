const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// =========================
// CONFIG
// =========================

const MIRROR_URL = 'https://zref.pro';
const PORT = process.env.PORT || 3000;

// Centrifugo константы
const METHOD_CONNECT = 0;
const METHOD_SUBSCRIBE = 1;
const METHOD_PING = 7;
const PUSH_PUBLICATION = 0;

// Таймауты
const DOMAIN_CHECK_INTERVAL = 60000; // 60 секунд
const PONG_TIMEOUT = 90000; // 90 секунд
const SILENT_SOCKET_TIMEOUT = 240000; // 4 минуты

let activeDomain = null;
let centrifugoConfig = null;
let wsConnection = null;
let reconnectTimer = null;
let pingInterval = null;
let watchdogInterval = null;
let reconnectAttempts = 0;
let domainWatchInterval = null;

// Состояние
let state = {
    site_base_url: null,
    domain_dead: false,
    ws: null,
    packets: 0,
    chat_messages: 0,
    rains: 0,
    raws: 0,
    last_chat_text: '',
    last_packet_time: null,
    last_pong_time: null,
    last_connected_time: null,
    pending_ping_id: null,
    pending_ping_time: null,
    reconnect_reason: ''
};

// Клиенты SSE
const clients = new Set();

// =========================
// HTTP HELPER с редиректами
// =========================

async function httpGetText(url, timeout = 25000) {
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        },
        timeout: timeout,
        maxRedirects: 10,
        validateStatus: null
    });
    
    if (response.status >= 400) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return { text: response.data, url: response.request.res.responseUrl };
}

// =========================
// ПРОВЕРКА ЖИВНОСТИ ДОМЕНА
// =========================

async function isDomainAlive(siteBaseUrl) {
    try {
        // Извлекаем хост
        const host = siteBaseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '').split('/')[0];
        
        // Пробуем и HTTPS, и HTTP
        for (const proto of ['https', 'http']) {
            try {
                const checkUrl = `${proto}://${host}`;
                const response = await axios.get(checkUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    },
                    timeout: 5000,
                    maxRedirects: 3,
                    validateStatus: null
                });
                
                const size = (response.data || '').length;
                if (response.status >= 200 && response.status < 300 && size > 1000) {
                    return true;
                }
            } catch (e) {
                // Пробуем следующий протокол
            }
        }
        return false;
    } catch (error) {
        console.log('[DOMAIN CHECK ERROR]', error.message);
        return false;
    }
}

// =========================
// ПОЛУЧЕНИЕ АКТУАЛЬНОГО ДОМЕНА (КАК В ПИТОНЕ)
// =========================

async function fetchActualDomain() {
    console.log('[DOMAIN] Fetching from', MIRROR_URL);
    
    try {
        const { text, url } = await httpGetText(MIRROR_URL);
        
        // 1. Ищем meta refresh (основной способ)
        let match = text.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url\s*=\s*([^"'\s;>]+)/i);
        
        if (!match) {
            // 2. Ищем URL в тексте
            match = text.match(/URL\s*=\s*(https?:\/\/[^"'\s>]+)/i);
        }
        
        if (match) {
            let siteUrl = match[1].trim();
            // Относительный путь
            if (siteUrl.startsWith('/')) {
                siteUrl = 'https://zref.pro' + siteUrl;
            }
            siteUrl = siteUrl.replace(/\/$/, '');
            console.log('[DOMAIN] Found via redirect:', siteUrl);
            return siteUrl;
        }
        
        // 3. Используем конечный URL после редиректов
        if (url && url.startsWith('http')) {
            const siteUrl = url.replace(/\/$/, '');
            console.log('[DOMAIN] Using final URL:', siteUrl);
            return siteUrl;
        }
        
        throw new Error('Could not find actual domain');
        
    } catch (error) {
        console.error('[DOMAIN ERROR]', error.message);
        throw error;
    }
}

// =========================
// ПОЛУЧЕНИЕ CONFIG С АКТУАЛЬНОГО ДОМЕНА
// =========================

async function fetchCentrifugeConfig() {
    const siteBaseUrl = await fetchActualDomain();
    activeDomain = siteBaseUrl;
    state.site_base_url = siteBaseUrl;
    
    console.log('[CONFIG] Fetching from', siteBaseUrl);
    
    const { text } = await httpGetText(siteBaseUrl + '/');
    
    // Сохраняем HTML для отладки (если нужно)
    // fs.writeFileSync('debug.html', text);
    
    // Ищем centrifugoSocket (основной паттерн)
    let wsMatch = text.match(/centrifugoSocket\s*=\s*['"]([^'"]+)['"]/);
    
    // Альтернативные паттерны
    if (!wsMatch) {
        wsMatch = text.match(/centrifugoSocket:\s*['"]([^'"]+)['"]/);
    }
    if (!wsMatch) {
        wsMatch = text.match(/socketUrl\s*=\s*['"]([^'"]+)['"]/);
    }
    
    // Ищем centrifugoSecret
    let tokenMatch = text.match(/centrifugoSecret\s*=\s*['"]([^'"]+)['"]/);
    
    if (!tokenMatch) {
        tokenMatch = text.match(/centrifugoSecret:\s*['"]([^'"]+)['"]/);
    }
    
    // Ищем в window.__INITIAL_STATE__
    if (!tokenMatch) {
        const initStateMatch = text.match(/__INITIAL_STATE__\s*=\s*({[^;]+})/);
        if (initStateMatch) {
            try {
                const initState = JSON.parse(initStateMatch[1]);
                if (initState.centrifugoSecret) {
                    tokenMatch = [null, initState.centrifugoSecret];
                }
                if (!wsMatch && initState.centrifugoSocket) {
                    wsMatch = [null, initState.centrifugoSocket];
                }
            } catch(e) {}
        }
    }
    
    if (!wsMatch) {
        console.error('[CONFIG] centrifugoSocket not found!');
        throw new Error('centrifugoSocket not found in HTML');
    }
    
    if (!tokenMatch) {
        console.error('[CONFIG] centrifugoSecret not found!');
        throw new Error('centrifugoSecret not found in HTML');
    }
    
    let wsUrl = wsMatch[1].trim();
    const token = tokenMatch[1].trim();
    
    // Преобразуем ws:// в wss:// если нужно
    if (wsUrl.startsWith('ws://')) {
        wsUrl = wsUrl.replace('ws://', 'wss://');
    }
    
    console.log('[CONFIG] WS URL:', wsUrl);
    console.log('[CONFIG] Token:', token.substring(0, 10) + '...');
    
    centrifugoConfig = {
        siteBaseUrl,
        origin: siteBaseUrl,
        wsUrl,
        token
    };
    
    return centrifugoConfig;
}

// =========================
// ВОССТАНОВЛЕНИЕ ДОМЕНА ПРИ СМЕРТИ
// =========================

async function domainWatchLoop() {
    while (true) {
        await new Promise(resolve => setTimeout(resolve, DOMAIN_CHECK_INTERVAL));
        
        if (!state.site_base_url) continue;
        
        try {
            const alive = await isDomainAlive(state.site_base_url);
            
            if (alive) {
                state.last_domain_check_ok = Date.now();
                if (state.domain_dead) {
                    console.log('[DOMAIN] Domain is alive again!');
                    state.domain_dead = false;
                }
                continue;
            }
            
            console.log('[DOMAIN DEAD]', state.site_base_url);
            state.domain_dead = true;
            state.reconnect_reason = 'domain_dead';
            
            // Закрываем WebSocket
            if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
                wsConnection.close();
            }
            
            // Пытаемся получить новый домен
            try {
                const newDomain = await fetchActualDomain();
                if (newDomain !== state.site_base_url) {
                    console.log('[DOMAIN] New domain found:', newDomain);
                    state.site_base_url = newDomain;
                    activeDomain = newDomain;
                    state.domain_dead = false;
                    // Переподключаемся с новым доменом
                    if (wsConnection) wsConnection.close();
                }
            } catch (e) {
                console.log('[DOMAIN] Failed to get new domain:', e.message);
            }
            
        } catch (error) {
            console.log('[DOMAIN WATCH ERROR]', error.message);
        }
    }
}

// =========================
// WEBSOCKET WATCHDOG
// =========================

function startWatchdog() {
    if (watchdogInterval) clearInterval(watchdogInterval);
    
    watchdogInterval = setInterval(() => {
        if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) return;
        
        const now = Date.now();
        
        // 1. Проверка PONG
        if (state.pending_ping_time && (now - state.pending_ping_time) >= PONG_TIMEOUT) {
            console.log('[WATCHDOG] No PONG, reconnecting...');
            state.reconnect_reason = 'ping_timeout';
            wsConnection.close();
            return;
        }
        
        // 2. Проверка тишины
        if (state.last_packet_time && (now - state.last_packet_time) >= SILENT_SOCKET_TIMEOUT) {
            console.log('[WATCHDOG] Silent socket, reconnecting...');
            state.reconnect_reason = 'silent_socket';
            wsConnection.close();
            return;
        }
        
        // 3. Проверка домена
        if (state.domain_dead) {
            console.log('[WATCHDOG] Domain dead, reconnecting...');
            wsConnection.close();
            return;
        }
        
    }, 10000);
}

// =========================
// CENTRIFUGO WEBSOCKET
// =========================

function sendWsMessage(ws, message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

async function connectCentrifugo() {
    if (!centrifugoConfig) {
        await fetchCentrifugeConfig();
    }
    
    if (wsConnection && (wsConnection.readyState === WebSocket.OPEN || wsConnection.readyState === WebSocket.CONNECTING)) {
        console.log('[WS] Already connected');
        return wsConnection;
    }
    
    console.log('[WS] Connecting to', centrifugoConfig.wsUrl);
    
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(centrifugoConfig.wsUrl, {
            headers: {
                'Origin': centrifugoConfig.origin,
                'User-Agent': 'Mozilla/5.0'
            }
        });
        
        const timeout = setTimeout(() => {
            if (ws.readyState !== WebSocket.OPEN) {
                ws.close();
                reject(new Error('WebSocket connection timeout'));
            }
        }, 10000);
        
        ws.on('open', async () => {
            clearTimeout(timeout);
            console.log('[WS] Connected');
            wsConnection = ws;
            state.ws = true;
            state.last_connected_time = Date.now();
            state.last_packet_time = Date.now();
            state.last_pong_time = Date.now();
            
            // Отправляем CONNECT с токеном
            const connectMsg = {
                id: 1,
                method: METHOD_CONNECT,
                params: { token: centrifugoConfig.token }
            };
            sendWsMessage(ws, connectMsg);
            console.log('[WS] Sent CONNECT');
        });
        
        ws.on('message', (data) => {
            handleWsMessage(data.toString());
        });
        
        ws.on('error', (error) => {
            console.error('[WS ERROR]', error.message);
            clearTimeout(timeout);
        });
        
        ws.on('close', (code, reason) => {
            console.log('[WS] Closed:', code, reason?.toString() || '');
            wsConnection = null;
            state.ws = false;
            if (pingInterval) {
                clearInterval(pingInterval);
                pingInterval = null;
            }
            scheduleReconnect();
        });
        
        // Ждем подтверждение CONNECT и SUBSCRIBE
        let connected = false;
        
        const messageHandler = (data) => {
            try {
                const packet = JSON.parse(data.toString());
                
                // CONNECT ответ
                if (packet.id === 1) {
                    if (packet.error) {
                        ws.removeListener('message', messageHandler);
                        reject(new Error(`CONNECT error: ${JSON.stringify(packet.error)}`));
                    } else {
                        console.log('[WS] CONNECT success, client:', packet.result?.client);
                        
                        // Отправляем SUBSCRIBE на канал chat
                        const subscribeMsg = {
                            id: 2,
                            method: METHOD_SUBSCRIBE,
                            params: { channel: 'chat' }
                        };
                        sendWsMessage(ws, subscribeMsg);
                        console.log('[WS] Sent SUBSCRIBE to chat');
                    }
                }
                
                // SUBSCRIBE ответ
                if (packet.id === 2) {
                    if (packet.error) {
                        console.error('[WS] SUBSCRIBE error:', packet.error);
                    } else {
                        console.log('[WS] SUBSCRIBE success');
                        connected = true;
                        ws.removeListener('message', messageHandler);
                        
                        // Запускаем PING интервал
                        if (pingInterval) clearInterval(pingInterval);
                        pingInterval = setInterval(() => {
                            if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
                                const pingId = Date.now();
                                state.pending_ping_id = pingId;
                                state.pending_ping_time = Date.now();
                                sendWsMessage(wsConnection, {
                                    id: pingId,
                                    method: METHOD_PING
                                });
                            }
                        }, 25000);
                        
                        startWatchdog();
                        resolve(ws);
                    }
                }
                
                // PONG ответ
                if (packet.id && packet.id === state.pending_ping_id) {
                    state.pending_ping_id = null;
                    state.pending_ping_time = null;
                    state.last_pong_time = Date.now();
                }
                
            } catch(e) {}
        };
        
        ws.on('message', messageHandler);
    });
}

// =========================
// HTML PARSING (ЧАТ И ПОЛЬЗОВАТЕЛИ)
// =========================

function cleanText(text) {
    if (!text) return '';
    return String(text).replace(/\s+/g, ' ').trim();
}

function parseChatHtml(htmlText, rawPayload) {
    try {
        const $ = cheerio.load(htmlText);
        const root = $('.rightBlockChatMessageBlock').first();
        
        if (!root.length) {
            return {
                timeISO: new Date().toISOString(),
                event: 'raw_chat_html',
                raw: rawPayload
            };
        }
        
        const classes = root.attr('class') || '';
        const nickname = cleanText(root.find('.rightBlockChatMessageNick').text());
        const message = cleanText(root.find('.rightBlockChatMessageText').text());
        const messageTime = cleanText(root.find('.rightBlockChatMessageTimeBlock').text());
        const profileLink = root.find('a[href^="/user/"]').attr('href') || '';
        
        // Извлекаем ID пользователя из profileLink
        let userId = null;
        const userMatch = profileLink.match(/\/user\/(\d+)/);
        if (userMatch) userId = userMatch[1];
        
        // Извлекаем статус (VIP, ADMIN и т.д.)
        let status = null;
        if (classes.includes('vip')) status = 'VIP';
        if (classes.includes('admin')) status = 'ADMIN';
        if (classes.includes('moderator')) status = 'MODERATOR';
        
        const isRain = classes.includes('rainDropChat');
        
        if (isRain) {
            const rainId = root.attr('id');
            const launcher = cleanText(root.find('.rainDropChat__author, .rainDropChat__nick, .rightBlockChatMessageNick').first().text()) || 'Неизвестно';
            
            let totalAmount = '';
            const text = root.text();
            const amountMatch = text.match(/(\d[\d\s]*(?:[.,]\d+)?)\s*₽/);
            if (amountMatch) totalAmount = amountMatch[0];
            
            const winners = [];
            root.find('.rainDropChat__winnersList a[href^="/user/"], .rainDropChat__winnerLink[href^="/user/"]').each((i, el) => {
                const href = $(el).attr('href');
                const name = cleanText($(el).text()) || cleanText($(el).find('img').attr('alt'));
                if (href && name) {
                    winners.push({ nickname: name, profile: href });
                }
            });
            
            state.rains++;
            broadcastToClients({
                type: 'rain',
                data: {
                    messageTime,
                    launcher,
                    totalAmount,
                    prizesCount: winners.length,
                    winners
                }
            });
            
            return {
                timeISO: new Date().toISOString(),
                event: 'rain_drop_chat',
                messageTime,
                rainId,
                launcher,
                totalAmount,
                prizesCount: winners.length,
                winners
            };
        }
        
        if (nickname || message || messageTime) {
            state.chat_messages++;
            state.last_chat_text = `${messageTime} | ${nickname}: ${message.substring(0, 100)}`;
            
            const chatData = {
                messageTime,
                nickname,
                message,
                profile: profileLink,
                userId,
                status
            };
            
            // Отправляем всем SSE клиентам
            broadcastToClients({
                type: 'message',
                data: chatData
            });
            
            console.log(`[CHAT] ${messageTime} | ${nickname}: ${message}`);
            
            return {
                timeISO: new Date().toISOString(),
                event: 'chat_message',
                messageTime,
                nickname,
                message,
                userId,
                profile: profileLink,
                status
            };
        }
        
        return {
            timeISO: new Date().toISOString(),
            event: 'raw_chat_html',
            text: cleanText($.text()),
            raw: rawPayload
        };
        
    } catch (error) {
        console.error('[PARSE ERROR]', error.message);
        return {
            timeISO: new Date().toISOString(),
            event: 'parse_error',
            error: error.message,
            raw: rawPayload
        };
    }
}

function parseChatPublication(publication) {
    const data = publication.data || publication;
    
    if (data && typeof data === 'object') {
        const inner = data.data || data;
        if (inner && inner.html && typeof inner.html === 'string') {
            return parseChatHtml(inner.html, data);
        }
    }
    
    return {
        timeISO: new Date().toISOString(),
        event: 'raw_chat_publication',
        raw: data
    };
}

function handleWsMessage(rawData) {
    state.packets++;
    state.last_packet_time = Date.now();
    
    try {
        const packet = JSON.parse(rawData);
        
        // Пропускаем command responses
        if (packet.id) return;
        
        const result = packet.result;
        if (!result || typeof result !== 'object') return;
        
        const pushType = result.type;
        const channel = result.channel;
        
        if (pushType === PUSH_PUBLICATION && channel === 'chat') {
            const publication = result.data || {};
            parseChatPublication(publication);
        }
        
    } catch (error) {
        console.error('[WS PARSE ERROR]', error.message);
        state.raws++;
    }
}

// =========================
// ПЕРЕПОДКЛЮЧЕНИЕ
// =========================

function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    
    // Экспоненциальная задержка
    const delay = Math.min(30, Math.pow(2, reconnectAttempts)) * 1000;
    reconnectAttempts++;
    
    console.log(`[RECONNECT] Attempt ${reconnectAttempts} in ${delay/1000}s (${state.reconnect_reason || 'unknown'})`);
    
    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        try {
            // Обновляем конфиг (домен мог измениться)
            await fetchCentrifugeConfig();
            await connectCentrifugo();
            reconnectAttempts = 0;
            state.reconnect_reason = '';
            broadcastToClients({ type: 'status', data: { connected: true, stats: state } });
        } catch (error) {
            console.error('[RECONNECT ERROR]', error.message);
            scheduleReconnect();
        }
    }, delay);
}

// =========================
// SSE (Server-Sent Events)
// =========================

function broadcastToClients(data) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    clients.forEach(client => {
        try {
            client.write(message);
        } catch (error) {
            clients.delete(client);
        }
    });
}

// =========================
// API ENDPOINTS
// =========================

app.get('/events', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });
    
    clients.add(res);
    
    // Отправляем текущий статус
    res.write(`data: ${JSON.stringify({ 
        type: 'status', 
        data: {
            connected: wsConnection && wsConnection.readyState === WebSocket.OPEN,
            domain: activeDomain,
            stats: {
                packets: state.packets,
                chat_messages: state.chat_messages,
                rains: state.rains,
                raws: state.raws
            }
        } 
    })}\n\n`);
    
    req.on('close', () => {
        clients.delete(res);
    });
});

app.get('/status', (req, res) => {
    res.json({
        connected: wsConnection && wsConnection.readyState === WebSocket.OPEN,
        domain: activeDomain,
        domain_dead: state.domain_dead,
        stats: {
            packets: state.packets,
            chat_messages: state.chat_messages,
            rains: state.rains,
            raws: state.raws,
            last_chat: state.last_chat_text
        },
        reconnect_attempts: reconnectAttempts,
        last_reconnect_reason: state.reconnect_reason
    });
});

// Поиск сообщений по пользователю
app.get('/user/:userId/messages', (req, res) => {
    const userId = req.params.userId;
    try {
        const messages = [];
        if (fs.existsSync('chatlog.jsonl')) {
            const content = fs.readFileSync('chatlog.jsonl', 'utf8');
            const lines = content.trim().split('\n');
            for (const line of lines.slice(-200)) {
                if (line.trim()) {
                    try {
                        const msg = JSON.parse(line);
                        if (msg.userId === userId || msg.profile?.includes(`/user/${userId}`)) {
                            messages.push(msg);
                        }
                    } catch(e) {}
                }
            }
        }
        res.json(messages.reverse());
    } catch (error) {
        res.json([]);
    }
});

app.get('/users', (req, res) => {
    const users = new Map();
    try {
        if (fs.existsSync('chatlog.jsonl')) {
            const content = fs.readFileSync('chatlog.jsonl', 'utf8');
            const lines = content.trim().split('\n');
            for (const line of lines.slice(-1000)) {
                if (line.trim()) {
                    try {
                        const msg = JSON.parse(line);
                        if (msg.userId && msg.nickname) {
                            if (!users.has(msg.userId)) {
                                users.set(msg.userId, {
                                    userId: msg.userId,
                                    nickname: msg.nickname,
                                    status: msg.status,
                                    lastSeen: msg.messageTime,
                                    lastMessage: msg.message
                                });
                            }
                        }
                    } catch(e) {}
                }
            }
        }
    } catch (error) {}
    res.json(Array.from(users.values()));
});

app.get('/chat', (req, res) => {
    try {
        const messages = [];
        if (fs.existsSync('chatlog.jsonl')) {
            const content = fs.readFileSync('chatlog.jsonl', 'utf8');
            const lines = content.trim().split('\n');
            for (const line of lines.slice(-200)) {
                if (line.trim()) {
                    try {
                        const msg = JSON.parse(line);
                        if (msg.event === 'chat_message') {
                            messages.push(msg);
                        }
                    } catch(e) {}
                }
            }
        }
        res.json(messages.reverse());
    } catch (error) {
        res.json([]);
    }
});

app.use(express.static('public'));

// =========================
// ЗАПУСК
// =========================

async function start() {
    console.log('[START] Initializing...');
    
    // Запускаем фоновую проверку домена
    domainWatchLoop();
    
    try {
        await fetchCentrifugeConfig();
        await connectCentrifugo();
    } catch (error) {
        console.error('[START ERROR]', error.message);
        scheduleReconnect();
    }
    
    server.listen(PORT, () => {
        console.log(`[SERVER] Running on http://localhost:${PORT}`);
    });
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN] Closing...');
    if (pingInterval) clearInterval(pingInterval);
    if (watchdogInterval) clearInterval(watchdogInterval);
    if (domainWatchInterval) clearInterval(domainWatchInterval);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (wsConnection) wsConnection.close();
    server.close(() => process.exit(0));
});

start();
