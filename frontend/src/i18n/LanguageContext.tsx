import React, { createContext, useContext, useState, ReactNode } from 'react';
import { en, Translations } from './locales/en';
import { zh } from './locales/zh';

export type Language = 'zh' | 'en';
export type TerminalTranslationKey = 'interactiveTab' | 'exitFullscreen' | 'fullscreen';

export interface LanguageContextType {
  lang: Language;
  setLang: (lang: Language) => void;
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (path: string, fallbackOrParams?: string | Record<string, any>, params?: Record<string, any>) => string;
}

const dictionaries: Record<Language, Translations> = { en, zh };

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export const LanguageProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Language>(() => {
    const saved = localStorage.getItem('app_lang') as Language | null;
    if (saved === 'zh' || saved === 'en') return saved;
    return navigator.language.toLowerCase().includes('zh') ? 'zh' : 'en';
  });

  const setLang = (newLang: Language) => {
    setLangState(newLang);
    localStorage.setItem('app_lang', newLang);
  };

  const t = (path: string, fallbackOrParams?: string | Record<string, any>, paramsOrEmpty?: Record<string, any>): string => {
    const fallback = typeof fallbackOrParams === 'string' ? fallbackOrParams : undefined;
    const params = typeof fallbackOrParams === 'object' && fallbackOrParams !== null ? fallbackOrParams : paramsOrEmpty;
    const keys = path.split('.');
    let current: any = dictionaries[lang];
    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = current[key];
      } else {
        current = fallback || path;
        break;
      }
    }
    let res = typeof current === 'string' ? current : (fallback || path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        res = res.split(`{{${k}}}`).join(String(v));
        res = res.split(`{${k}}`).join(String(v));
      }
    }
    return res;
  };

  return (
    <LanguageContext.Provider value={{ lang, setLang, language: lang, setLanguage: setLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useTranslation = (): LanguageContextType => {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useTranslation must be used within a LanguageProvider');
  }
  return context;
};
