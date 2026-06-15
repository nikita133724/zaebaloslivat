'use client';

import { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { format, differenceInSeconds, parseISO } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';
import { Clock, User, MessageCircle, ExternalLink, Activity, Globe } from 'lucide-react';

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

interface AppConfigState {
  targetUserId: string;
  useAutoMirror: boolean;
  customMirrorUrl: string;
  onlyTargetUser: boolean;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [localTime, setLocalTime] = useState<Date | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [activeDomain, setActiveDomain] = useState<string>('');
  
  const [config, setConfig] = useState<AppConfigState>({
    targetUserId: '25945',
    useAutoMirror: true,
    customMirrorUrl: '',
    onlyTargetUser: true,
  });
  
  const socketRef = useRef<Socket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Initial config fetch
    fetch('/api/domen-settings')
      .then((res) => res.json())
      .then((data: AppConfigState) => {
        setConfig(data);
      })
      .catch((e) => console.error('Failed to load initial configuration:', e));

    // Defer state update to avoid synchronous state transitions during rendering
    setTimeout(() => {
      setMounted(true);
      setLocalTime(new Date());
    }, 0);

    // Socket initialization
    socketRef.current = io();

    socketRef.current.on('connect', () => {
      setIsConnected(true);
    });

    socketRef.current.on('disconnect', () => {
      setIsConnected(false);
    });

    socketRef.current.on('init_messages', (initialMessages: ChatMessage[]) => {
      setMessages(initialMessages);
    });

    socketRef.current.on('chat_message', (message: ChatMessage) => {
      setMessages((prev) => [...prev, message].slice(-100));
    });

    socketRef.current.on('active_domain', (domain: string) => {
      setActiveDomain(domain);
    });

    socketRef.current.on('config_update', (updatedConfig: AppConfigState) => {
      console.log('Main page received dynamic config update:', updatedConfig);
      setConfig(updatedConfig);
    });

    // Time update loop
    const timer = setInterval(() => {
      setLocalTime(new Date());
    }, 1000);

    return () => {
      socketRef.current?.disconnect();
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    // Scroll to bottom when messages update
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, config.onlyTargetUser]);

  const getTimeInterval = (current: string, previous?: string) => {
    if (!previous) return null;
    const diff = differenceInSeconds(parseISO(current), parseISO(previous));
    if (diff < 0) return null;

    const d = Math.floor(diff / (3600 * 24));
    const h = Math.floor((diff % (3600 * 24)) / 3600);
    const m = Math.floor((diff % 3600) / 60);
    const s = diff % 60;

    let parts = [];
    if (d > 0) parts.push(`${d}д`);
    if (h > 0) parts.push(`${h}ч`);
    if (m > 0) parts.push(`${m}м`);
    if (s > 0 || parts.length === 0) parts.push(`${s}с`);

    return parts.join(' ');
  };

  // Filter messages dynamically based on server config settings
  const filteredMessages = config.onlyTargetUser
    ? messages.filter(
        (msg) =>
          msg.rawProfile?.includes(config.targetUserId) ||
          msg.profile?.includes(config.targetUserId)
      )
    : messages;

  return (
    <div className="min-h-screen bg-[#0e0f1e] bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(120,119,198,0.15),rgba(255,255,255,0))] text-slate-200 font-sans selection:bg-purple-500/30 flex flex-col justify-between">
      
      {/* Top Header */}
      <header className="sticky top-0 z-10 border-b border-white/5 bg-[#0e0f1e]/80 backdrop-blur-md px-4 py-4 md:px-8">
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-purple-500/10 rounded-xl border border-purple-500/20">
              <Activity className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-lg md:text-xl font-bold tracking-tight text-white">Мониторинг чата</h1>
                <div className="flex items-center gap-1 bg-white/5 border border-white/10 px-2 py-0.5 rounded-full">
                  <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                  <span className="text-[10px] font-mono font-medium uppercase tracking-wider text-slate-300">
                    {isConnected ? 'Активен' : 'Отключен'}
                  </span>
                </div>
              </div>
              <p className="text-xs text-slate-400 mt-0.5 font-mono">
                Пользователь {config.targetUserId}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="bg-[#16182e] border border-white/5 rounded-xl px-4 py-1.5 flex items-center gap-3 shadow-inner">
              <Clock className="w-4 h-4 text-purple-400/80" />
              <div className="flex flex-col">
                <span className="text-[8px] text-slate-500 uppercase tracking-widest leading-none">ЛОКАЛЬНОЕ ВРЕМЯ</span>
                <span className="text-purple-300 font-mono text-sm font-semibold tracking-tight leading-normal mt-0.5 min-w-[70px]">
                  {mounted && localTime ? format(localTime, 'HH:mm:ss') : '--:--:--'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Container - Pristine centered column suited for mobile and wide PC layout */}
      <main className="max-w-4xl mx-auto px-4 py-6 md:py-8 w-full flex-1 flex flex-col justify-center">
        
        {/* Chat Thread */}
        <div className="bg-[#13152a] ring-1 ring-white/5 border border-white/5 rounded-3xl p-4 md:p-6 shadow-xl flex flex-col flex-1">
          <div className="flex items-center justify-between border-b border-white/5 pb-4 mb-4">
            <div className="flex items-center gap-2">
              <MessageCircle className="w-4 h-4 text-purple-400" />
              <h2 className="text-sm font-bold text-white uppercase tracking-wider">
                Поток сообщений
              </h2>
            </div>
          </div>

          {/* Messages list container */}
          <div 
            ref={scrollRef}
            className="space-y-4 overflow-y-auto max-h-[550px] lg:max-h-[600px] h-full pr-1.5 custom-scrollbar min-h-[350px] flex-1"
          >
            {filteredMessages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 text-slate-500 space-y-4 h-full">
                <MessageCircle className="w-16 h-16 opacity-10 animate-bounce" />
                <div className="text-center">
                  <p className="font-semibold text-slate-400 text-sm">В настоящий момент сообщений нет</p>
                  <p className="text-xs text-slate-500 mt-1.5 max-w-sm mx-auto leading-relaxed">
                    Ожидание первого сообщения от пользователя {config.targetUserId} после запуска мониторинга чата...
                  </p>
                </div>
              </div>
            ) : (
              <AnimatePresence initial={false}>
                {filteredMessages.map((msg, index) => {
                  const isTargetUser = msg.rawProfile?.includes(config.targetUserId) || msg.profile?.includes(config.targetUserId);
                  
                  return (
                    <div key={msg.id} className="flex flex-col space-y-2">
                      {index > 0 && (
                        <div className="flex justify-center">
                          <span className="px-2.5 py-0.5 rounded-full bg-white/[0.03] border border-white/[0.04] text-[9px] text-slate-500 font-mono">
                            +{getTimeInterval(msg.timeISO, filteredMessages[index - 1].timeISO)}
                          </span>
                        </div>
                      )}
                      
                      <motion.div
                        initial={{ opacity: 0, y: 15 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={`relative group border p-4 rounded-2xl transition-all duration-300 overflow-hidden ${
                          isTargetUser 
                            ? 'bg-purple-950/15 border-purple-500/25 shadow-lg shadow-purple-950/10 ring-1 ring-purple-500/10' 
                            : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.04]'
                        }`}
                      >
                        {/* Targets highlight line glow */}
                        {isTargetUser && (
                          <div className="absolute top-0 bottom-0 left-0 w-1 bg-gradient-to-b from-purple-500 to-pink-500" />
                        )}

                        <div className="flex gap-4">
                          {/* Avatar & Badge */}
                          <div className="relative shrink-0 select-none">
                            <div className={`w-11 h-11 rounded-xl overflow-hidden ring-2 transition-all ${
                              isTargetUser 
                                ? 'ring-purple-500/40 group-hover:ring-purple-400' 
                                : 'ring-white/5 group-hover:ring-white/10'
                            }`}>
                              {msg.avatar ? (
                                <img 
                                  src={msg.avatar} 
                                  alt={msg.nickname}
                                  referrerPolicy="no-referrer"
                                  className="w-full h-full object-cover"
                                />
                              ) : (
                                <div className="w-full h-full bg-slate-800 flex items-center justify-center">
                                  <User className="w-5 h-5 text-slate-600" />
                                </div>
                              )}
                            </div>
                            {msg.badge && (
                              <div className={`absolute -bottom-1.5 -left-1 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase shadow-lg ${
                                msg.badge === 'VIP' ? 'bg-gradient-to-r from-pink-600 to-purple-600 text-white' : 'bg-slate-700 text-slate-300'
                              }`}>
                                {msg.badge}
                              </div>
                            )}
                          </div>

                          {/* Content layout */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2 mb-1.5">
                              <div className="flex items-center gap-2">
                                <span className={`font-semibold truncate max-w-[170px] ${
                                  isTargetUser ? 'text-purple-300' : 'text-white'
                                }`}>
                                  {msg.nickname}
                                </span>
                                {isTargetUser && (
                                  <span className="text-[8px] font-mono font-bold bg-purple-500 text-white px-1.5 py-0.5 rounded uppercase tracking-widest leading-none">
                                    ЦЕЛЬ
                                  </span>
                                )}
                                <a 
                                  href={msg.profile} 
                                  target="_blank" 
                                  rel="noreferrer" 
                                  className="p-1 rounded-md hover:bg-white/10 text-slate-500 hover:text-slate-300 transition-colors"
                                  title="Профиль на сайте"
                                >
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              </div>
                              <div className="flex items-center gap-1 text-[11px] font-mono text-slate-400">
                                <Clock className="w-3 h-3 text-slate-600" />
                                <span>{msg.messageTime || '--:--'}</span>
                              </div>
                            </div>
                            <p className={`text-sm leading-relaxed break-words font-sans selection:bg-purple-500/20 ${
                              isTargetUser ? 'text-purple-100 font-medium' : 'text-slate-300'
                            }`}>
                              {msg.message}
                            </p>
                            
                            {/* Metadata footer */}
                            {!config.onlyTargetUser && (
                              <div className="mt-2.5 pt-2 border-t border-white/[0.03] flex items-center justify-between text-[9px] font-mono text-slate-500">
                                <span>ID сообщения: {msg.id}</span>
                                <span>Получено: {format(parseISO(msg.timeISO), 'HH:mm:ss')}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    </div>
                  );
                })}
              </AnimatePresence>
            )}
          </div>
        </div>
      </main>

      {/* Footer bar displaying the computed active Centrifugo mirror URL */}
      <footer className="w-full border-t border-white/5 py-4 px-4 bg-[#0a0b16]">
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-blue-400/80 shrink-0" />
            <span className="font-medium">Активный домен:</span>
            <span className="font-mono text-blue-400 select-all truncate max-w-[280px]">
              {activeDomain || 'Поиск зеркала зеркалами zref.pro...'}
            </span>
          </div>
        </div>
      </footer>

      <style jsx global>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 5px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.05);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.12);
        }
      `}</style>
    </div>
  );
}
