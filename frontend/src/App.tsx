import React from 'react';
import UnifiedTerminalView from './components/UnifiedTerminalView';
import LoginView from './components/LoginView';
import { useAuth } from './auth/AuthContext';
import { Loader2 } from 'lucide-react';

export default function App() {
  const { status, adminKey, authRequired, logout } = useAuth();

  if (status === 'checking') {
    return (
      <div className="flex items-center justify-center h-[100dvh] w-screen bg-[var(--bg-canvas)] text-[var(--text-muted)] select-none">
        <Loader2 className="w-6 h-6 animate-spin text-emerald-400" />
      </div>
    );
  }

  if (status === 'unauthenticated') {
    return <LoginView />;
  }

  return (
    <div className="flex flex-col h-[100dvh] w-screen overflow-hidden bg-[var(--bg-canvas)] text-[var(--text-primary)] select-none">
      <UnifiedTerminalView
        adminKey={adminKey}
        isStandalone={true}
        onLogout={authRequired ? logout : undefined}
      />
    </div>
  );
}
