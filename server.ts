<!DOCTYPE html>
<html>
<head>
    <title>Chat Monitor</title>
    <meta charset="utf-8">
    <style>
        * { box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; 
            padding: 20px; 
            background: #0f0f1a; 
            color: #e0e0e0;
            margin: 0;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        
        /* Stats panel */
        .stats-panel {
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
            display: flex;
            gap: 30px;
            flex-wrap: wrap;
            box-shadow: 0 4px 6px rgba(0,0,0,0.3);
        }
        .stat {
            flex: 1;
            min-width: 120px;
            text-align: center;
            padding: 10px;
            background: rgba(0,0,0,0.3);
            border-radius: 8px;
        }
        .stat-label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
        .stat-value { font-size: 28px; font-weight: bold; color: #4ecdc4; }
        .stat-value.connected { color: #4ecdc4; }
        .stat-value.disconnected { color: #ff6b6b; }
        
        /* Search */
        .search-box {
            background: #1a1a2e;
            border-radius: 8px;
            padding: 15px;
            margin-bottom: 20px;
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }
        .search-box input {
            flex: 1;
            padding: 10px 15px;
            background: #0f0f1a;
            border: 1px solid #2a2a3e;
            border-radius: 6px;
            color: #e0e0e0;
            font-size: 14px;
        }
        .search-box button {
            padding: 10px 20px;
            background: #4ecdc4;
            border: none;
            border-radius: 6px;
            color: #1a1a2e;
            font-weight: bold;
            cursor: pointer;
        }
        .search-box button:hover { opacity: 0.9; }
        
        /* Tabs */
        .tabs {
            display: flex;
            gap: 5px;
            margin-bottom: 20px;
            border-bottom: 1px solid #2a2a3e;
        }
        .tab {
            padding: 10px 20px;
            background: none;
            border: none;
            color: #888;
            cursor: pointer;
            font-size: 14px;
        }
        .tab.active {
            color: #4ecdc4;
            border-bottom: 2px solid #4ecdc4;
        }
        
        /* Chat messages */
        .chat-container {
            background: #1a1a2e;
            border-radius: 12px;
            overflow: hidden;
        }
        .messages {
            height: 500px;
            overflow-y: auto;
            padding: 15px;
            display: flex;
            flex-direction: column-reverse;
        }
        .message {
            padding: 8px 12px;
            border-bottom: 1px solid #2a2a3e;
            font-size: 13px;
        }
        .message:hover { background: #22223b; }
        .message-rain {
            background: #2a1a3e;
            border-left: 3px solid #ff6b6b;
        }
        .time { color: #666; font-size: 11px; margin-right: 10px; }
        .nick { 
            color: #4ecdc4; 
            font-weight: bold;
            cursor: pointer;
        }
        .nick:hover { text-decoration: underline; }
        .status-vip { color: #ffd700; font-size: 10px; margin-left: 5px; }
        .status-admin { color: #ff6b6b; font-size: 10px; margin-left: 5px; }
        .text { color: #e0e0e0; word-break: break-word; }
        .rain-icon { color: #ff6b6b; margin-right: 5px; }
        
        /* Users list */
        .users-list {
            max-height: 400px;
            overflow-y: auto;
        }
        .user-item {
            padding: 10px;
            border-bottom: 1px solid #2a2a3e;
            cursor: pointer;
        }
        .user-item:hover { background: #22223b; }
        .user-nick { font-weight: bold; color: #4ecdc4; }
        .user-status { font-size: 10px; color: #888; }
        .user-last { font-size: 11px; color: #666; margin-top: 4px; }
        
        /* User messages */
        .user-messages {
            margin-top: 20px;
            border-top: 1px solid #2a2a3e;
            padding-top: 15px;
        }
        .back-btn {
            background: #2a2a3e;
            border: none;
            color: #e0e0e0;
            padding: 5px 10px;
            border-radius: 6px;
            cursor: pointer;
            margin-bottom: 10px;
        }
    </style>
</head>
<body>
<div class="container">
    <div class="stats-panel">
        <div class="stat">
            <div class="stat-label">Статус</div>
            <div class="stat-value" id="wsStatus">⏳</div>
        </div>
        <div class="stat">
            <div class="stat-label">Домен</div>
            <div class="stat-value" id="domain" style="font-size: 14px;">-</div>
        </div>
        <div class="stat">
            <div class="stat-label">Сообщений</div>
            <div class="stat-value" id="msgCount">0</div>
        </div>
        <div class="stat">
            <div class="stat-label">Дождей</div>
            <div class="stat-value" id="rainCount">0</div>
        </div>
        <div class="stat">
            <div class="stat-label">Пакетов</div>
            <div class="stat-value" id="packets">0</div>
        </div>
    </div>
    
    <div class="search-box">
        <input type="text" id="userSearch" placeholder="Поиск по нику или ID пользователя...">
        <button onclick="searchUser()">Найти</button>
    </div>
    
    <div class="tabs">
        <button class="tab active" onclick="showTab('chat')">💬 Чат</button>
        <button class="tab" onclick="showTab('users')">👥 Пользователи</button>
        <button class="tab" onclick="showTab('rains')">🌧️ Дожди</button>
    </div>
    
    <div id="chatTab" class="chat-container">
        <div class="messages" id="messages"></div>
    </div>
    
    <div id="usersTab" style="display: none;">
        <div class="users-list" id="usersList"></div>
        <div id="userMessagesPanel" style="display: none;">
            <button class="back-btn" onclick="closeUserMessages()">← Назад к списку</button>
            <div class="chat-container">
                <div class="messages" id="userMessages"></div>
            </div>
        </div>
    </div>
    
    <div id="rainsTab" style="display: none;">
        <div class="messages" id="rainsList" style="height: 400px; overflow-y: auto;"></div>
    </div>
</div>

<script>
    let currentUser = null;
    let messages = [];
    let rains = [];
    
    const eventSource = new EventSource('/events');
    
    eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.type === 'status') {
            updateStatus(data.data);
        } else if (data.type === 'message') {
            addMessage(data.data);
        } else if (data.type === 'rain') {
            addRain(data.data);
        }
    };
    
    function updateStatus(statusData) {
        const wsSpan = document.getElementById('wsStatus');
        wsSpan.textContent = statusData.connected ? '✅' : '❌';
        wsSpan.className = `stat-value ${statusData.connected ? 'connected' : 'disconnected'}`;
        
        document.getElementById('domain').textContent = statusData.domain || '-';
        if (statusData.stats) {
            document.getElementById('msgCount').textContent = statusData.stats.chat_messages || 0;
            document.getElementById('rainCount').textContent = statusData.stats.rains || 0;
            document.getElementById('packets').textContent = statusData.stats.packets || 0;
        }
    }
    
    function addMessage(msg) {
        const messagesDiv = document.getElementById('messages');
        const div = createMessageElement(msg);
        messagesDiv.insertBefore(div, messagesDiv.firstChild);
        
        // Ограничиваем количество сообщений
        while (messagesDiv.children.length > 500) {
            messagesDiv.removeChild(messagesDiv.lastChild);
        }
        
        // Если открыты сообщения пользователя
        if (currentUser && (msg.userId === currentUser.userId || msg.nickname === currentUser.nickname)) {
            const userMessagesDiv = document.getElementById('userMessages');
            const userDiv = createMessageElement(msg);
            userMessagesDiv.insertBefore(userDiv, userMessagesDiv.firstChild);
        }
    }
    
    function createMessageElement(msg) {
        const div = document.createElement('div');
        div.className = 'message';
        
        const statusBadge = msg.status === 'VIP' ? '<span class="status-vip">👑</span>' : 
                           (msg.status === 'ADMIN' ? '<span class="status-admin">⚡</span>' : '');
        
        div.innerHTML = `
            <span class="time">[${msg.messageTime || '--:--'}]</span>
            <span class="nick" onclick="showUserMessages('${msg.userId || ''}', '${escapeHtml(msg.nickname || '')}')">
                ${escapeHtml(msg.nickname || '?')}${statusBadge}
            </span>
            <span class="text">${escapeHtml(msg.message || '')}</span>
        `;
        return div;
    }
    
    function addRain(rain) {
        const rainsDiv = document.getElementById('rainsList');
        const div = document.createElement('div');
        div.className = 'message message-rain';
        div.innerHTML = `
            <span class="time">[${rain.messageTime || '--:--'}]</span>
            <span class="rain-icon">🌧️</span>
            <span class="nick">${escapeHtml(rain.launcher || '?')}</span>
            <span class="text">💰 ${rain.totalAmount || '?'} | 🏆 ${rain.prizesCount || 0} победителей</span>
        `;
        rainsDiv.insertBefore(div, rainsDiv.firstChild);
        
        rains.unshift(rain);
        document.getElementById('rainCount').textContent = rains.length;
    }
    
    async function showUserMessages(userId, nickname) {
        currentUser = { userId, nickname };
        
        try {
            const response = await fetch(`/user/${userId}/messages`);
            const userMessages = await response.json();
            
            document.getElementById('usersList').style.display = 'none';
            document.getElementById('userMessagesPanel').style.display = 'block';
            
            const container = document.getElementById('userMessages');
            container.innerHTML = '';
            container.innerHTML = `<div style="padding: 10px; background: #2a2a3e; margin-bottom: 10px;">💬 Сообщения пользователя: <strong>${escapeHtml(nickname)}</strong></div>`;
            
            for (const msg of userMessages.reverse()) {
                const div = createMessageElement(msg);
                container.appendChild(div);
            }
            
            if (userMessages.length === 0) {
                container.innerHTML += '<div style="padding: 20px; text-align: center; color: #666;">Нет сообщений от этого пользователя</div>';
            }
        } catch (error) {
            console.error('Failed to load user messages:', error);
        }
    }
    
    function closeUserMessages() {
        currentUser = null;
        document.getElementById('usersList').style.display = 'block';
        document.getElementById('userMessagesPanel').style.display = 'none';
        loadUsers();
    }
    
    async function loadUsers() {
        try {
            const response = await fetch('/users');
            const users = await response.json();
            
            const container = document.getElementById('usersList');
            container.innerHTML = '';
            
            for (const user of users) {
                const div = document.createElement('div');
                div.className = 'user-item';
                div.onclick = () => showUserMessages(user.userId, user.nickname);
                div.innerHTML = `
                    <div class="user-nick">${escapeHtml(user.nickname)}</div>
                    <div class="user-status">${user.status || 'обычный'} • ID: ${user.userId}</div>
                    <div class="user-last">Последнее: ${user.lastSeen || '—'}</div>
                `;
                container.appendChild(div);
            }
            
            if (users.length === 0) {
                container.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">Пользователи не найдены</div>';
            }
        } catch (error) {
            console.error('Failed to load users:', error);
        }
    }
    
    async function searchUser() {
        const query = document.getElementById('userSearch').value.trim().toLowerCase();
        if (!query) return;
        
        try {
            const response = await fetch('/users');
            const users = await response.json();
            
            const user = users.find(u => 
                u.nickname.toLowerCase().includes(query) || 
                u.userId === query
            );
            
            if (user) {
                showUserMessages(user.userId, user.nickname);
                showTab('users');
                document.getElementById('userSearch').value = '';
            } else {
                alert('Пользователь не найден');
            }
        } catch (error) {
            alert('Ошибка поиска');
        }
    }
    
    function showTab(tab) {
        document.getElementById('chatTab').style.display = tab === 'chat' ? 'block' : 'none';
        document.getElementById('usersTab').style.display = tab === 'users' ? 'block' : 'none';
        document.getElementById('rainsTab').style.display = tab === 'rains' ? 'block' : 'none';
        
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        event.target.classList.add('active');
        
        if (tab === 'users') {
            loadUsers();
        }
    }
    
    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // Загрузка истории
    async function loadHistory() {
        try {
            const response = await fetch('/chat');
            const history = await response.json();
            
            const messagesDiv = document.getElementById('messages');
            messagesDiv.innerHTML = '';
            
            for (const msg of history.reverse()) {
                const div = createMessageElement(msg);
                messagesDiv.appendChild(div);
            }
        } catch (error) {
            console.error('Failed to load history:', error);
        }
    }
    
    loadHistory();
</script>
</body>
</html>
