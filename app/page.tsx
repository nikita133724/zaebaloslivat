'use client';

import { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { format, differenceInSeconds, parseISO } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { motion, AnimatePresence } from 'motion/react';
import { Clock, User, MessageCircle, ExternalLink, Activity } from 'lucide-react';

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

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [localTime, setLocalTime] = useState(new Date());
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
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
    // Scroll to bottom on new messages
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

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

  const getSiteTime = (date: Date) => {
    return toZonedTime(date, 'Etc/GMT-3');
  };

  const getServerTime = (date: Date) => {
    return toZonedTime(date, 'UTC');
  };

  return (
    <div className="min-h-screen bg-[#1a1b2e] text-slate-200 font-sans selection:bg-purple-500/30">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-white/5 bg-[#1a1b2e]/80 backdrop-blur-md px-6 py-4">
        <div className="max-w-4xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-500/10 rounded-lg">
              <Activity className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight text-white">Chat Monitor</h1>
                <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
              </div>
              <p className="text-xs text-slate-400 font-mono">Target: user/124646</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-4 text-xs font-mono">
            <div className="flex flex-col">
              <span className="text-slate-500 uppercase tracking-widest text-[10px]">Local</span>
              <span className="text-purple-300">{format(localTime, 'HH:mm:ss')}</span>
            </div>
            <div className="flex flex-col border-l border-white/10 pl-4">
              <span className="text-slate-500 uppercase tracking-widest text-[10px]">Site (UTC+3)</span>
              <span className="text-blue-300">{format(getSiteTime(localTime), 'HH:mm:ss')}</span>
            </div>
            <div className="flex flex-col border-l border-white/10 pl-4">
              <span className="text-slate-500 uppercase tracking-widest text-[10px]">Server (UTC)</span>
              <span className="text-emerald-300">{format(getServerTime(localTime), 'HH:mm:ss')}</span>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8">
        <div 
          ref={scrollRef}
          className="space-y-6 overflow-y-auto max-h-[calc(100vh-200px)] pr-2 custom-scrollbar"
        >
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-slate-500 space-y-4">
              <MessageCircle className="w-12 h-12 opacity-20" />
              <p className="animate-pulse">Waiting for messages from target user...</p>
            </div>
          ) : (
            <AnimatePresence initial={false}>
              {messages.map((msg, index) => (
                <div key={msg.id} className="flex flex-col space-y-2">
                  {index > 0 && (
                    <div className="flex justify-center">
                      <span className="px-3 py-1 rounded-full bg-white/5 text-[10px] text-slate-500 font-mono">
                        +{getTimeInterval(msg.timeISO, messages[index - 1].timeISO)}
                      </span>
                    </div>
                  )}
                  
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="relative group bg-white/[0.03] hover:bg-white/[0.06] border border-white/5 p-4 rounded-2xl transition-all duration-300"
                  >
                    <div className="flex gap-4">
                      {/* Avatar & Badge */}
                      <div className="relative shrink-0">
                        <div className="w-12 h-12 rounded-xl overflow-hidden ring-2 ring-purple-500/20 group-hover:ring-purple-500/40 transition-all">
                          {msg.avatar ? (
                            <img 
                              src={msg.avatar} 
                              alt={msg.nickname}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full bg-slate-800 flex items-center justify-center">
                              <User className="w-6 h-6 text-slate-600" />
                            </div>
                          )}
                        </div>
                        {msg.badge && (
                          <div className={`absolute -bottom-2 -left-1 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase shadow-lg ${
                            msg.badge === 'VIP' ? 'bg-gradient-to-r from-pink-600 to-purple-600 text-white' : 'bg-slate-700 text-slate-300'
                          }`}>
                            {msg.badge}
                          </div>
                        )}
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-white truncate max-w-[150px]">
                              {msg.nickname}
                            </span>
                            <a 
                              href={msg.profile} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="p-1 rounded-md hover:bg-white/10 text-slate-500 hover:text-slate-300 transition-colors"
                            >
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>
                          <div className="flex flex-col items-end gap-0.5 text-[10px] font-mono text-slate-500">
                            <div className="flex items-center gap-1.5">
                              <Clock className="w-3 h-3 text-purple-400/50" />
                              <span className="text-purple-300/80">Local: {format(parseISO(msg.timeISO), 'HH:mm:ss')}</span>
                            </div>
                            <div className="flex gap-2 opacity-60">
                              <span>Site (Chat): {msg.messageTime}</span>
                              <span className="border-l border-white/10 pl-2">Server: {format(getServerTime(parseISO(msg.timeISO)), 'HH:mm:ss')}</span>
                            </div>
                          </div>
                        </div>
                        <p className="text-sm text-slate-300 leading-relaxed break-words">
                          {msg.message}
                        </p>
                      </div>
                    </div>
                  </motion.div>
                </div>
              ))}
            </AnimatePresence>
          )}
        </div>
      </main>

      <style jsx global>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 5px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}</style>
    </div>
  );
}
