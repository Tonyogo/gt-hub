import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Image as ImageIcon,
  Download,
  X,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { useTranslation } from '../../i18n/LanguageContext';
import { TerminalFileItem } from './TerminalFileManagerView';

export interface TerminalImagePreviewModalProps {
  file: TerminalFileItem;
  blobUrl: string;
  onClose: () => void;
  onDownload: (file: TerminalFileItem) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

export function TerminalImagePreviewModal({
  file,
  blobUrl,
  onClose,
  onDownload,
}: TerminalImagePreviewModalProps) {
  const { t } = useTranslation();

  const [scale, setScale] = useState<number>(1);
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [rotation, setRotation] = useState<number>(0);
  const [isMaximized, setIsMaximized] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [initialPos, setInitialPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [hasMoved, setHasMoved] = useState<boolean>(false);
  const [naturalDimensions, setNaturalDimensions] = useState<{ width: number; height: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Keep ref sync for event listeners
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const positionRef = useRef(position);
  positionRef.current = position;

  // Zoom In / Out / Reset / 1:1 / Rotate
  const handleZoomIn = useCallback(() => {
    setScale((prev) => Math.min(Number((prev * 1.25).toFixed(2)), 10));
  }, []);

  const handleZoomOut = useCallback(() => {
    setScale((prev) => Math.max(Number((prev * 0.8).toFixed(2)), 0.1));
  }, []);

  const handleReset = useCallback(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
    setRotation(0);
  }, []);

  const handleRotate = useCallback(() => {
    setRotation((prev) => (prev + 90) % 360);
  }, []);

  const handleActualSize = useCallback(() => {
    if (imgRef.current && naturalDimensions && imgRef.current.clientWidth > 0) {
      const actualScale = naturalDimensions.width / imgRef.current.clientWidth;
      setScale(Math.min(Math.max(Number(actualScale.toFixed(2)), 0.1), 10));
      setPosition({ x: 0, y: 0 });
    } else {
      setScale(1);
      setPosition({ x: 0, y: 0 });
    }
  }, [naturalDimensions]);

  // Native wheel zoom with focal point tracking
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - (rect.left + rect.width / 2);
      const mouseY = e.clientY - (rect.top + rect.height / 2);

      const zoomDelta = e.deltaY < 0 ? 1.15 : 0.87;
      const curScale = scaleRef.current;
      const curPos = positionRef.current;
      const newScale = Math.min(Math.max(Number((curScale * zoomDelta).toFixed(2)), 0.1), 10);
      const ratio = newScale / curScale;

      const newX = mouseX - (mouseX - curPos.x) * ratio;
      const newY = mouseY - (mouseY - curPos.y) * ratio;

      setScale(newScale);
      setPosition({ x: Math.round(newX), y: Math.round(newY) });
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', onWheel);
    };
  }, []);

  // Mobile pinch-to-zoom
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let initialDistance = 0;
    let initialScale = 1;
    let initialMidpoint = { x: 0, y: 0 };
    let initialPosOnTouch = { x: 0, y: 0 };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        initialDistance = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        initialScale = scaleRef.current;
        const rect = container.getBoundingClientRect();
        initialMidpoint = {
          x: (t1.clientX + t2.clientX) / 2 - (rect.left + rect.width / 2),
          y: (t1.clientY + t2.clientY) / 2 - (rect.top + rect.height / 2),
        };
        initialPosOnTouch = { ...positionRef.current };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && initialDistance > 0) {
        e.preventDefault();
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const currentDistance = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        const ratio = currentDistance / initialDistance;
        const newScale = Math.min(Math.max(Number((initialScale * ratio).toFixed(2)), 0.1), 10);

        const scaleRatio = newScale / scaleRef.current;
        const mx = initialMidpoint.x;
        const my = initialMidpoint.y;
        const newX = mx - (mx - initialPosOnTouch.x) * scaleRatio;
        const newY = my - (my - initialPosOnTouch.y) * scaleRatio;

        setScale(newScale);
        setPosition({ x: Math.round(newX), y: Math.round(newY) });
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        initialDistance = 0;
      }
    };

    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tagName = (e.target as HTMLElement)?.tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName)) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        handleZoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        handleZoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        handleReset();
      } else if (e.key === '1') {
        e.preventDefault();
        handleActualSize();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        handleRotate();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, handleZoomIn, handleZoomOut, handleReset, handleActualSize, handleRotate]);

  // Pointer Drag Handlers
  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
    setInitialPos({ x: position.x, y: position.y });
    setHasMoved(false);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      setHasMoved(true);
    }
    setPosition({
      x: initialPos.x + dx,
      y: initialPos.y + dy,
    });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isDragging) return;
    setIsDragging(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
  };

  // Double Click: Toggle between Fit and 2x Zoom
  const handleDoubleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (scale !== 1 || position.x !== 0 || position.y !== 0) {
      handleReset();
    } else {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - (rect.left + rect.width / 2);
      const my = e.clientY - (rect.top + rect.height / 2);
      const newScale = 2;
      const ratio = newScale / scale;
      const newX = mx - (mx - position.x) * ratio;
      const newY = my - (my - position.y) * ratio;
      setScale(newScale);
      setPosition({ x: Math.round(newX), y: Math.round(newY) });
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && !hasMoved) {
      onClose();
    }
  };

  return (
    <div
      onClick={handleBackdropClick}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-xs transition-all ${
        isMaximized ? 'p-0' : 'p-2 sm:p-4'
      }`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`ui-card flex flex-col border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-2xl overflow-hidden transition-all duration-200 ${
          isMaximized
            ? 'w-full h-full rounded-none border-none'
            : 'w-full max-w-5xl h-[88vh] max-h-[88vh] rounded-xl'
        }`}
      >
        {/* Header Toolbar */}
        <div className="px-3 py-2 sm:px-4 sm:py-2.5 border-b border-[var(--border-subtle)] flex items-center justify-between shrink-0 bg-[var(--bg-surface-sub)] gap-2 select-none">
          {/* File Info */}
          <div className="flex items-center space-x-2 min-w-0">
            <ImageIcon className="w-4 h-4 text-emerald-400 shrink-0" />
            <span
              className="font-semibold text-xs sm:text-sm text-slate-200 truncate max-w-[110px] sm:max-w-xs md:max-w-md"
              title={file.name}
            >
              {file.name}
            </span>
            <span className="text-[10px] text-slate-400 font-mono shrink-0 hidden sm:inline">
              ({formatBytes(file.size)}
              {naturalDimensions ? ` · ${naturalDimensions.width}×${naturalDimensions.height}` : ''})
            </span>
          </div>

          {/* Zoom & Transform Controls */}
          <div className="flex items-center space-x-0.5 sm:space-x-1 bg-black/40 rounded-lg p-0.5 border border-[var(--border-subtle)]">
            <button
              onClick={handleZoomOut}
              title="缩小 (快捷键 -)"
              className="p-1 sm:px-1.5 sm:py-1 rounded text-slate-400 hover:text-white hover:bg-slate-700/50 transition-colors"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={handleReset}
              title="复位自适应 (快捷键 0)"
              className="text-[10px] sm:text-[11px] font-mono px-1 sm:px-1.5 py-0.5 min-w-[38px] sm:min-w-[44px] text-center text-slate-300 hover:text-white hover:bg-slate-700/50 rounded transition-colors"
            >
              {Math.round(scale * 100)}%
            </button>

            <button
              onClick={handleZoomIn}
              title="放大 (快捷键 +)"
              className="p-1 sm:px-1.5 sm:py-1 rounded text-slate-400 hover:text-white hover:bg-slate-700/50 transition-colors"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>

            <div className="w-[1px] h-3.5 bg-[var(--border-subtle)] mx-0.5" />

            <button
              onClick={handleReset}
              title="自适应窗口 (快捷键 0)"
              className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] sm:text-[11px] font-medium text-slate-400 hover:text-white hover:bg-slate-700/50 rounded transition-colors"
            >
              Fit
            </button>

            <button
              onClick={handleActualSize}
              title="1:1 实际尺寸 (快捷键 1)"
              className="px-1.5 py-0.5 text-[10px] sm:text-[11px] font-medium text-slate-400 hover:text-white hover:bg-slate-700/50 rounded transition-colors"
            >
              1:1
            </button>

            <button
              onClick={handleRotate}
              title="顺时针旋转 90° (快捷键 R)"
              className="p-1 sm:px-1.5 sm:py-1 rounded text-slate-400 hover:text-white hover:bg-slate-700/50 transition-colors"
            >
              <RotateCw className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center space-x-1 sm:space-x-1.5 shrink-0">
            <button
              onClick={() => setIsMaximized((prev) => !prev)}
              title={isMaximized ? '还原窗口' : '最大化全屏'}
              className="p-1.5 rounded border border-[var(--border-subtle)] text-slate-400 hover:text-white hover:bg-slate-700/50 transition-colors"
            >
              {isMaximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>

            <button
              onClick={() => onDownload(file)}
              title={t('files.download', '下载')}
              className="flex items-center space-x-1 px-2 sm:px-2.5 py-1 rounded border border-[var(--border-subtle)] text-slate-300 hover:text-white text-xs bg-slate-800/40 hover:bg-slate-700/60 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span className="hidden md:inline">{t('files.download', '下载')}</span>
            </button>

            <button
              onClick={onClose}
              title="关闭 (Esc)"
              className="p-1.5 rounded hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 transition-colors ml-0.5"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Viewport Canvas */}
        <div
          ref={containerRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onDoubleClick={handleDoubleClick}
          className={`flex-1 min-h-0 relative flex items-center justify-center overflow-hidden select-none bg-black/60 touch-none ${
            isDragging ? 'cursor-grabbing' : scale > 1 ? 'cursor-grab' : 'cursor-default'
          }`}
        >
          {/* Subtle Grid / Canvas Background */}
          <div
            className="absolute inset-0 pointer-events-none opacity-20"
            style={{
              backgroundImage:
                'radial-gradient(circle at 1px 1px, rgba(255, 255, 255, 0.15) 1px, transparent 0)',
              backgroundSize: '24px 24px',
            }}
          />

          <div
            style={{
              transform: `translate3d(${position.x}px, ${position.y}px, 0px) scale(${scale}) rotate(${rotation}deg)`,
              transformOrigin: 'center center',
              transition: isDragging ? 'none' : 'transform 0.15s ease-out',
            }}
            className="flex items-center justify-center will-change-transform"
          >
            <img
              ref={imgRef}
              src={blobUrl}
              alt={file.name}
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget;
                setNaturalDimensions({ width: img.naturalWidth, height: img.naturalHeight });
              }}
              className="max-w-[82vw] max-h-[72vh] object-contain rounded shadow-2xl pointer-events-none select-none transition-shadow"
            />
          </div>

          {/* Bottom Floating Shortcut / Gesture Tips */}
          <div className="absolute bottom-2.5 left-1/2 -translate-x-1/2 pointer-events-none opacity-60 hover:opacity-100 transition-opacity hidden sm:flex items-center space-x-2 text-[10px] text-slate-400 bg-black/60 px-3 py-1 rounded-full border border-white/5 backdrop-blur-xs font-mono">
            <span>滚轮 / 捏合缩放</span>
            <span>·</span>
            <span>拖拽平移</span>
            <span>·</span>
            <span>双击切换</span>
            <span>·</span>
            <span>Esc 退出</span>
          </div>
        </div>
      </div>
    </div>
  );
}
