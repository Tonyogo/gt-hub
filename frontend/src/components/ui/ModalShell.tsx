import React, { useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export interface ModalShellProps {
  isOpen: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  headerExtra?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  variant?: 'modal' | 'drawer';
  maxWidthClassName?: string;
  heightClassName?: string;
  zIndex?: 'base' | 'nested';
  closeOnBackdrop?: boolean;
  disableClose?: boolean;
  bodyClassName?: string;
  noHeader?: boolean;
  ariaLabel?: string;
}

export function getModalShellClasses(opts: {
  variant?: 'modal' | 'drawer';
  zIndex?: 'base' | 'nested';
  maxWidthClassName?: string;
  heightClassName?: string;
}): {
  backdropClassName: string;
  panelClassName: string;
  bodyClassName: string;
} {
  const variant = opts.variant ?? 'modal';
  const zClass = opts.zIndex === 'nested' ? 'z-[60]' : 'z-50';

  if (variant === 'drawer') {
    const maxW = opts.maxWidthClassName || 'max-w-md';
    return {
      backdropClassName: `fixed inset-0 ${zClass} flex justify-end bg-zinc-950/35 dark:bg-black/60 backdrop-blur-xl ui-modal-shell`,
      panelClassName: `ui-modal-shell bg-[var(--bg-sidebar)] border-l border-[var(--border-subtle)] text-[var(--text-primary)] shadow-[var(--shadow-popover)] h-full w-full ${maxW} flex flex-col overflow-hidden`
        .replace(/\s+/g, ' ')
        .trim(),
      bodyClassName: 'flex-1 min-h-0 overflow-y-auto overscroll-contain',
    };
  }

  const maxW = opts.maxWidthClassName || 'max-w-lg';
  const height = opts.heightClassName || '';
  return {
    backdropClassName: `fixed inset-0 ${zClass} flex items-end sm:items-center justify-center p-0 sm:p-4 bg-zinc-950/35 dark:bg-black/60 backdrop-blur-xl ui-modal-shell`,
    panelClassName: `ui-card ui-modal-shell overflow-hidden flex flex-col w-full ${maxW} ${height} max-h-[88dvh] rounded-t-2xl sm:rounded-xl`
      .replace(/\s+/g, ' ')
      .trim(),
    bodyClassName: 'flex-1 min-h-0 overflow-y-auto overscroll-contain',
  };
}

export function shouldCloseOnModalKeyDown(key: string, disableClose?: boolean): boolean {
  return key === 'Escape' && !disableClose;
}

export const ModalShell: React.FC<ModalShellProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  icon,
  headerExtra,
  footer,
  children,
  variant = 'modal',
  maxWidthClassName,
  heightClassName,
  zIndex = 'base',
  closeOnBackdrop = true,
  disableClose = false,
  bodyClassName,
  noHeader = false,
  ariaLabel,
}) => {
  const titleId = useId();

  useEffect(() => {
    if (!isOpen || typeof window === 'undefined') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (shouldCloseOnModalKeyDown(e.key, disableClose)) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, disableClose]);

  if (!isOpen || typeof document === 'undefined') {
    return null;
  }

  const classes = getModalShellClasses({
    variant,
    zIndex,
    maxWidthClassName,
    heightClassName,
  });

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (closeOnBackdrop !== false && !disableClose) {
      onClose();
    }
  };

  const content = (
    <div
      className={classes.backdropClassName}
      onClick={handleBackdropClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={!noHeader && title ? titleId : undefined}
        aria-label={noHeader || !title ? ariaLabel : undefined}
        className={classes.panelClassName}
        onClick={(e) => e.stopPropagation()}
      >
        {variant === 'modal' && (
          <div className="sm:hidden w-10 h-1 bg-[var(--border-hover)] rounded-full mx-auto mt-2 mb-1 shrink-0" />
        )}

        {!noHeader && (
          <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5 sm:py-3.5 shrink-0 bg-[var(--bg-surface-sub)] border-b border-[var(--border-subtle)]">
            <div className="flex items-center gap-2.5 min-w-0">
              {icon && <div className="shrink-0">{icon}</div>}
              <div className="min-w-0">
                {title && (
                  <h3
                    id={titleId}
                    className="text-sm font-semibold text-[var(--text-primary)] truncate"
                  >
                    {title}
                  </h3>
                )}
                {subtitle && (
                  <div className="text-[11px] text-[var(--text-secondary)] truncate mt-0.5">
                    {subtitle}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {headerExtra}
              <button
                type="button"
                onClick={onClose}
                disabled={disableClose}
                className="ui-icon-btn disabled:opacity-40 disabled:pointer-events-none"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        <div className={`${classes.bodyClassName} ${bodyClassName || 'p-4 sm:p-5'}`}>
          {children}
        </div>

        {footer && (
          <div className="shrink-0 bg-[var(--bg-surface-sub)] border-t border-[var(--border-subtle)] px-4 py-3 sm:px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(content, document.body);
};
