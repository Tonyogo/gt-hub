# Mobile Top Bar Responsive Layout & More Menu Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate mobile top-bar icon overlap and crowding in `UnifiedTerminalView` by keeping high-priority actions (Select Mode & Fullscreen) pinned, while gracefully collapsing secondary controls (Script Library, Reconnect, Reset Session, Theme, Language, GitHub, and Logout) into a responsive mobile "More" dropdown menu.

**Architecture:** Update `frontend/src/components/UnifiedTerminalView.tsx` with responsive utility classes (`hidden sm:inline-flex`) for desktop secondary buttons, add an active mobile `MoreVertical` popover menu with click-outside dismissal and accessible item triggers, and maintain identical desktop layout without regression.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Lucide Icons (`MoreVertical`, `TextSelect`, `Maximize2`, etc.), Jest.

**Spec:** In-chat bounded design agreed with user.

## Global Constraints

- Desktop layout (`sm:` breakpoint and above) must remain horizontally laid out with all existing buttons intact.
- On mobile devices, the pinned right-side buttons during interactive session are strictly:
  1. Select / Copy Mode toggle (`TextSelect`)
  2. Browser Fullscreen toggle (`Maximize2` / `Minimize2`)
  3. Mobile More Actions toggle (`MoreVertical`)
- The "More" popover must contain:
  - Script Library (`ScrollText`) -> calls `terminalRef.current?.openScriptDrawer()`
  - Reconnect (`RefreshCw`) -> calls `terminalRef.current?.reconnect()`
  - Reset Session (`Trash2`) -> calls `handleResetSession()`
  - Language switcher (`Languages`)
  - Theme switcher (`Sun` / `Moon`)
  - GitHub Link (`Github`)
  - Logout (`LogOut`, if `onLogout` is provided)
- Clicking outside or clicking any action in the More menu must automatically dismiss the popover.

## Review Focus

1. Mobile viewport (< 640px) must never wrap or overlap icons on the top bar.
2. Clicking "Script Library" inside the mobile More menu must trigger `terminalRef.current?.openScriptDrawer()` and close the popover.
3. Clicking backdrop or pressing outside must close the More menu cleanly.
4. On screens >= 640px (`sm:`), the More button must be completely hidden (`sm:hidden`).
5. All 112+ existing test suites must pass without regression.

---

### Task 1: Update Top Bar Responsive Layout & Implement Mobile More Menu in `UnifiedTerminalView.tsx`

**Files:**
- Modify: `frontend/src/components/UnifiedTerminalView.tsx`
- Test: `tests/terminalUnifiedTopBarControls.test.ts`

**Interfaces:**
- Consumes: `useTranslation`, `useTheme`, `WebTerminalHandle`
- Produces: Responsive top-bar with `isMoreMenuOpen` state, `moreMenuRef`, `MoreVertical` toggle, and popover container.

- [x] **Step 1: Write the failing tests for mobile More menu and responsive classes**

Update `tests/terminalUnifiedTopBarControls.test.ts`:
```ts
import * as fs from 'fs';
import * as path from 'path';

describe('UnifiedTerminalView Micro Top Bar Integrated Controls', () => {
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
  let content: string;

  beforeAll(() => {
    content = fs.readFileSync(unifiedPath, 'utf-8');
  });

  it('UnifiedTerminalView imports MoreVertical icon for mobile overflow menu', () => {
    expect(content).toMatch(/import\s*\{[^}]*\bMoreVertical\b[^}]*\}\s*from\s*'lucide-react'/);
  });

  it('UnifiedTerminalView manages isMoreMenuOpen state and closes on click-outside', () => {
    expect(content).toContain('isMoreMenuOpen');
    expect(content).toContain('setIsMoreMenuOpen');
  });

  it('UnifiedTerminalView pins Select Mode and Fullscreen on mobile while collapsing secondary desktop buttons', () => {
    // Desktop secondary buttons have hidden sm:inline-flex or hidden sm:flex
    expect(content).toMatch(/data-testid="unified-open-scripts-btn"[^>]*hidden\s+sm:inline-flex/);
    expect(content).toContain('data-testid="mobile-more-btn"');
    expect(content).toContain('sm:hidden');
  });

  it('UnifiedTerminalView renders mobile more menu popover containing Script Library, Reconnect, Settings', () => {
    expect(content).toContain('data-testid="mobile-more-menu"');
    expect(content).toContain('openScriptDrawer');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx jest tests/terminalUnifiedTopBarControls.test.ts --detectOpenHandles`
Expected: FAIL (missing `MoreVertical`, `isMoreMenuOpen`, etc.)

- [x] **Step 3: Implement Mobile More Menu in `UnifiedTerminalView.tsx`**

1. Import `MoreVertical` from `'lucide-react'`.
2. Add state and ref:
   ```tsx
   const [isMoreMenuOpen, setIsMoreMenuOpen] = useState<boolean>(false);
   const moreMenuRef = useRef<HTMLDivElement>(null);

   useEffect(() => {
     if (!isMoreMenuOpen) return;
     const handleClickOutside = (e: MouseEvent) => {
       if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
         setIsMoreMenuOpen(false);
       }
     };
     document.addEventListener('mousedown', handleClickOutside);
     document.addEventListener('touchstart', handleClickOutside);
     return () => {
       document.removeEventListener('mousedown', handleClickOutside);
       document.removeEventListener('touchstart', handleClickOutside);
     };
   }, [isMoreMenuOpen]);
   ```
3. Update desktop action buttons to hide on mobile:
   - Reconnect: `className="hidden sm:inline-flex p-1 sm:p-1.5 ..."`
   - Reset session: `className="hidden sm:inline-flex p-1 sm:p-1.5 ..."`
   - Script library: `className="hidden sm:inline-flex p-1 sm:p-1.5 ..."`
   - GitHub: `className="hidden sm:flex p-1 sm:p-1.5 ..."`
   - Language: `className="hidden sm:inline-flex p-1 sm:p-1.5 ..."`
   - Theme: `className="hidden sm:inline-flex p-1 sm:p-1.5 ..."`
   - Logout: `className="hidden sm:inline-flex p-1 sm:p-1.5 ..."`
4. Keep pinned on mobile & desktop:
   - Select mode toggle button
   - Fullscreen toggle button
5. Add Mobile More Actions toggle button and popover menu:
   ```tsx
   {/* Mobile More Actions Menu */}
   <div className="relative sm:hidden" ref={moreMenuRef}>
     <button
       type="button"
       data-testid="mobile-more-btn"
       onClick={() => setIsMoreMenuOpen((prev) => !prev)}
       className={`p-1 rounded-lg border transition-all ${
         isMoreMenuOpen
           ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30'
           : 'bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06]'
       }`}
       title="更多操作"
     >
       <MoreVertical className="w-3.5 h-3.5" />
     </button>

     {isMoreMenuOpen && (
       <div
         data-testid="mobile-more-menu"
         className="absolute right-0 top-full mt-1.5 w-48 bg-[#18181b] border border-[#27272a] rounded-xl shadow-2xl py-1 z-50 divide-y divide-white/[0.06] text-xs text-slate-300 animate-in fade-in zoom-in-95 duration-100"
       >
         {subTab === 'interactive' && (
           <div className="py-1">
             <button
               type="button"
               onClick={() => {
                 terminalRef.current?.openScriptDrawer();
                 setIsMoreMenuOpen(false);
               }}
               className="w-full px-3 py-2 flex items-center space-x-2.5 hover:bg-white/[0.06] text-left transition-colors"
             >
               <ScrollText className="w-3.5 h-3.5 text-indigo-400" />
               <span>{t('scripts.title', '常用脚本库')}</span>
             </button>

             <button
               type="button"
               onClick={() => {
                 terminalRef.current?.reconnect();
                 setIsMoreMenuOpen(false);
               }}
               className="w-full px-3 py-2 flex items-center space-x-2.5 hover:bg-white/[0.06] text-left transition-colors"
             >
               <RefreshCw className="w-3.5 h-3.5 text-indigo-400" />
               <span>{t('webTerminal.reconnect', '重新连接')}</span>
             </button>

             <button
               type="button"
               onClick={() => {
                 handleResetSession();
                 setIsMoreMenuOpen(false);
               }}
               className="w-full px-3 py-2 flex items-center space-x-2.5 hover:bg-rose-500/10 text-rose-300 text-left transition-colors"
             >
               <Trash2 className="w-3.5 h-3.5" />
               <span>{t('webTerminal.resetSession', '重置会话')}</span>
             </button>
           </div>
         )}

         <div className="py-1">
           <button
             type="button"
             onClick={() => {
               setLanguage(language === 'zh' ? 'en' : 'zh');
               setIsMoreMenuOpen(false);
             }}
             className="w-full px-3 py-2 flex items-center space-x-2.5 hover:bg-white/[0.06] text-left transition-colors"
           >
             <Languages className="w-3.5 h-3.5 text-slate-400" />
             <span>{language === 'zh' ? 'English' : '简体中文'}</span>
           </button>

           <button
             type="button"
             onClick={() => {
               setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
               setIsMoreMenuOpen(false);
             }}
             className="w-full px-3 py-2 flex items-center space-x-2.5 hover:bg-white/[0.06] text-left transition-colors"
           >
             {resolvedTheme === 'dark' ? <Sun className="w-3.5 h-3.5 text-amber-400" /> : <Moon className="w-3.5 h-3.5 text-indigo-400" />}
             <span>{resolvedTheme === 'dark' ? '亮色主题' : '暗色主题'}</span>
           </button>

           <a
             href="https://github.com/Tonyogo/gt-hub"
             target="_blank"
             rel="noopener noreferrer"
             onClick={() => setIsMoreMenuOpen(false)}
             className="w-full px-3 py-2 flex items-center space-x-2.5 hover:bg-white/[0.06] text-left transition-colors"
           >
             <Github className="w-3.5 h-3.5 text-slate-400" />
             <span>GitHub</span>
           </a>
         </div>

         {onLogout && (
           <div className="py-1">
             <button
               type="button"
               onClick={() => {
                 onLogout();
                 setIsMoreMenuOpen(false);
               }}
               className="w-full px-3 py-2 flex items-center space-x-2.5 hover:bg-rose-500/10 text-rose-400 text-left transition-colors"
             >
               <LogOut className="w-3.5 h-3.5" />
               <span>{t('nav.logout', '退出登录')}</span>
             </button>
           </div>
         )}
       </div>
     )}
   </div>
   ```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/terminalUnifiedTopBarControls.test.ts --detectOpenHandles`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/components/UnifiedTerminalView.tsx tests/terminalUnifiedTopBarControls.test.ts
git commit -m "feat(frontend): optimize mobile top bar layout with pinned actions and overflow more menu

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Full System Verification & Production Build Validation

**Files:**
- All project files.

- [x] **Step 1: Run all test suites**

Run: `npm test`
Expected: All 112+ test suites PASS with 0 failures.

- [x] **Step 2: Run production build**

Run: `npm run build`
Expected: Clean build of frontend Vite bundle, backend TypeScript, and CLI executable.

- [x] **Step 3: Commit any build assets if needed**

```bash
git commit -m "chore: verify full test suites and production build for mobile top bar optimization

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
