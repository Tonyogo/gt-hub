import React from 'react';

export interface TerminalMagnifierBubbleProps {
  visible: boolean;
  x: number;
  y: number;
  textBefore: string;
  focusChar: string;
  textAfter: string;
  isFlippedBelow: boolean;
}

export const TerminalMagnifierBubble: React.FC<TerminalMagnifierBubbleProps> = ({
  visible,
  x,
  y,
  textBefore,
  focusChar,
  textAfter,
  isFlippedBelow,
}) => {
  if (!visible) return null;

  return (
    <div
      style={{ left: `${x}px`, top: `${y}px` }}
      className="fixed -translate-x-1/2 -translate-y-1/2 z-40 pointer-events-none select-none flex flex-col items-center animate-in fade-in zoom-in-95 duration-75"
    >
      {/* Inverted Pointer (Pointing up when flipped below finger) */}
      {isFlippedBelow && (
        <div className="w-0 h-0 border-x-4 border-x-transparent border-b-4 border-b-indigo-500/60 mb-[-1px]" />
      )}

      {/* Magnifier Bubble Body */}
      <div className="px-2.5 py-1 rounded-xl bg-slate-900/95 dark:bg-slate-950/95 border border-indigo-500/40 shadow-2xl backdrop-blur-xl flex items-center font-mono text-xs sm:text-sm font-semibold tracking-wide whitespace-pre text-slate-400 ring-1 ring-white/10">
        <span>{textBefore}</span>
        <span className="bg-indigo-600 text-white px-1 py-0.5 rounded shadow-sm scale-110 mx-0.5">
          {focusChar === ' ' ? '␣' : focusChar}
        </span>
        <span>{textAfter}</span>
      </div>

      {/* Normal Pointer (Pointing down when positioned above finger) */}
      {!isFlippedBelow && (
        <div className="w-0 h-0 border-x-4 border-x-transparent border-t-4 border-t-indigo-500/60 mt-[-1px]" />
      )}
    </div>
  );
};

export default TerminalMagnifierBubble;
