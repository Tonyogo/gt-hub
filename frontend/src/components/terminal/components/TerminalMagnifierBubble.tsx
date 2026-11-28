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
      className="ui-modal-shell fixed -translate-x-1/2 -translate-y-1/2 z-40 pointer-events-none select-none flex flex-col items-center"
    >
      {/* Inverted Pointer (Pointing up when flipped below finger) */}
      {isFlippedBelow && (
        <div className="w-0 h-0 border-x-4 border-x-transparent border-b-4 border-b-[var(--accent-primary)] mb-[-1px]" />
      )}

      {/* Magnifier Bubble Body */}
      <div className="ui-elevated-glass px-2.5 py-1 rounded-xl border border-[var(--border-default)] shadow-[var(--shadow-popover)] flex items-center font-mono text-xs sm:text-sm font-semibold tracking-wide whitespace-pre text-[var(--text-secondary)] ring-1 ring-[var(--border-subtle)]">
        <span>{textBefore}</span>
        <span className="bg-[var(--accent-fill)] text-white px-1 py-0.5 rounded-md shadow-xs mx-0.5">
          {focusChar === ' ' ? '␣' : focusChar}
        </span>
        <span>{textAfter}</span>
      </div>

      {/* Normal Pointer (Pointing down when positioned above finger) */}
      {!isFlippedBelow && (
        <div className="w-0 h-0 border-x-4 border-x-transparent border-t-4 border-t-[var(--accent-primary)] mt-[-1px]" />
      )}
    </div>
  );
};

export default TerminalMagnifierBubble;
