import React from 'react';
import UnifiedTerminalView from './components/UnifiedTerminalView';

export default function App() {
  return (
    <div className="flex flex-col h-[100dvh] w-screen overflow-hidden bg-[var(--bg-canvas)] text-[var(--text-primary)] select-none">
      <UnifiedTerminalView isStandalone={true} />
    </div>
  );
}
