'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import { ArrowLeft, Save, Globe, User, Shield, HelpCircle, CheckCircle, WifiOff } from 'lucide-react';

interface AppConfigState {
  targetUserId: string;
  useAutoMirror: boolean;
  customMirrorUrl: string;
  onlyTargetUser: boolean;
}

export default function DomenConfigPage() {
  const router = useRouter();
  const [config, setConfig] = useState<AppConfigState>({
    targetUserId: '25945',
    useAutoMirror: true,
    customMirrorUrl: '',
    onlyTargetUser: true,
  });
  
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  // Fetch current config on load
  useEffect(() => {
    fetch('/api/domen-settings')
      .then((res) => {
        if (!res.ok) throw new Error('Ошибка при загрузке настроек');
        return res.json();
      })
      .then((data: AppConfigState) => {
        setConfig(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error(err);
        setError('Не удалось загрузить настройки сервера. Пожалуйста, попробуйте позже.');
        setLoading(false);
      });
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess(false);

    try {
      const response = await fetch('/api/domen-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      if (!response.ok) {
        throw new Error('Не удалось обновить настройки сервера');
      }

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message || 'Произошла непредвиденная ошибка');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0e0f1e] text-slate-200 font-sans flex flex-col items-center justify-center p-6">
        <div className="w-12 h-12 rounded-full border-4 border-purple-500/20 border-t-purple-500 animate-spin" />
        <p className="text-sm font-mono mt-4 text-slate-400">Загрузка конфигурации...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0e0f1e] bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(120,119,198,0.12),rgba(255,255,255,0))] text-slate-200 font-sans selection:bg-purple-500/30 py-10 px-4">
      <div className="max-w-xl mx-auto">
        
        {/* Back Button */}
        <button
          onClick={() => router.push('/')}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 active:bg-white/15 text-xs text-slate-300 font-medium transition-all mb-8 cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          Вернуться к мониторингу
        </button>

        {/* Form Container */}
        <div className="bg-[#13152a] ring-1 ring-white/5 border border-white/5 rounded-3xl p-6 md:p-8 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-purple-500/5 rounded-full blur-3xl -z-10" />

          <div className="border-b border-white/5 pb-5 mb-6">
            <h1 className="text-xl md:text-2xl font-bold tracking-tight text-white flex items-center gap-2.5">
              <Shield className="w-6 h-6 text-purple-400" />
              Настройки мониторинга
            </h1>
            <p className="text-xs text-slate-400 mt-1 select-none">
              Конфигурация параметров Centrifugo сокета и целевого профиля пользователя.
            </p>
          </div>

          <form onSubmit={handleSave} className="space-y-6">
            
            {/* Target User ID Section */}
            <div className="space-y-2">
              <label className="text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
                <User className="w-3.5 h-3.5 text-purple-400" />
                ID отслеживаемого пользователя
              </label>
              <div className="relative">
                <input
                  type="text"
                  required
                  placeholder="Например, 25945"
                  value={config.targetUserId}
                  onChange={(e) => setConfig({ ...config, targetUserId: e.target.value })}
                  className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-sm font-mono text-purple-300 focus:outline-none focus:ring-2 focus:ring-purple-500/45 focus:border-purple-500/60 transition-all placeholder:text-slate-600"
                />
              </div>
              <p className="text-[10px] text-slate-500 leading-normal">
                Укажите числовой идентификатор (например: 25945). Весь чат будет фильтроваться по этому ID.
              </p>
            </div>

            {/* Manual Domain Section */}
            <div className="space-y-4 pt-2 border-t border-white/5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
                  <Globe className="w-3.5 h-3.5 text-blue-400" />
                  Ручная настройка домена
                </label>
                
                {/* Disable zref.pro Checkbox */}
                <label className="flex items-center gap-1.5 cursor-pointer selection:bg-none select-none">
                  <input
                    type="checkbox"
                    checked={!config.useAutoMirror}
                    onChange={(e) => setConfig({ ...config, useAutoMirror: !e.target.checked })}
                    className="rounded border-white/10 bg-black/40 text-purple-600 focus:ring-purple-500/50 w-3.5 h-3.5 accent-purple-600"
                  />
                  <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">без zref.pro</span>
                </label>
              </div>

              {!config.useAutoMirror ? (
                <div className="space-y-2">
                  <input
                    type="url"
                    required={!config.useAutoMirror}
                    placeholder="https://example.com"
                    value={config.customMirrorUrl}
                    onChange={(e) => setConfig({ ...config, customMirrorUrl: e.target.value })}
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-sm font-mono text-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-500/45 focus:border-blue-500/60 transition-all placeholder:text-slate-600"
                  />
                  <div className="flex items-start gap-1.5 p-2.5 bg-yellow-500/5 border border-yellow-500/10 rounded-lg text-[10px] text-yellow-400 leading-normal">
                    <WifiOff className="w-4 h-4 shrink-0" />
                    <span>Автоматический поиск активных зеркал через zref.pro отключен. Будет использоваться указанный вами домен напрямую.</span>
                  </div>
                </div>
              ) : (
                <div className="p-3 bg-emerald-500/5 border border-emerald-500/10 rounded-xl text-center">
                  <p className="text-[11px] text-emerald-400 font-medium">
                    Активен автоматический парсинг актуального зеркала через zref.pro
                  </p>
                </div>
              )}
            </div>

            {/* Target User Switch - Checkbox */}
            <div className="pt-2 border-t border-white/5 space-y-2">
              <label className="text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
                <HelpCircle className="w-3.5 h-3.5 text-purple-400" />
                Режим фильтрации
              </label>

              <label className="flex items-start gap-3 p-3 bg-white/[0.02] hover:bg-white/[0.04] active:bg-white/[0.06] border border-white/5 rounded-xl cursor-pointer transition-all">
                <input
                  type="checkbox"
                  checked={config.onlyTargetUser}
                  onChange={(e) => setConfig({ ...config, onlyTargetUser: e.target.checked })}
                  className="mt-0.5 rounded border-white/10 bg-black/40 text-purple-600 focus:ring-purple-500/50 w-4 h-4 accent-purple-600"
                />
                <div className="flex flex-col">
                  <span className="text-xs font-semibold text-white">Только целевой пользователь (ID: {config.targetUserId})</span>
                  <span className="text-[10px] text-slate-400 mt-1 leading-relaxed">
                    Если флажок установлен, на главной странице по умолчанию будут отображаться только сообщения выбранного ID. Снимите флажок для полной ленты чата.
                  </span>
                </div>
              </label>
            </div>

            {/* Messages/Status block */}
            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-xl">
                {error}
              </div>
            )}

            {success && (
              <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs rounded-xl flex items-center gap-2 font-medium">
                <CheckCircle className="w-4 h-4" />
                Настройки успешно обновлены и отправлены серверу!
              </div>
            )}

            {/* Submission Actions */}
            <div className="pt-2">
              <button
                type="submit"
                disabled={saving}
                className="w-full bg-purple-600 hover:bg-purple-500 active:bg-purple-700 disabled:bg-purple-800 disabled:opacity-50 text-white font-semibold py-3 px-4 rounded-xl shadow-lg shadow-purple-950/20 transition-all flex items-center justify-center gap-2 text-sm cursor-pointer"
              >
                <Save className="w-4 h-4" />
                {saving ? 'Сохранение...' : 'Сохранить настройки'}
              </button>
            </div>

          </form>
        </div>

      </div>
    </div>
  );
}
