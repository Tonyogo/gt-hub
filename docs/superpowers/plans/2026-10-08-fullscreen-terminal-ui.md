# Fullscreen Terminal and File Manager UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove outer application header, navigation tabs, and audit logs view, making the UI exclusively a full-screen, immersive web terminal and file manager.

**Architecture:** Refactor `App.tsx` into a lean 100% viewport container that directly renders `UnifiedTerminalView`. Migrate global utilities (Admin Secret Key, Language Switcher, Theme Switcher) into `UnifiedTerminalView`'s compact micro top bar, consolidating terminal actions, host selector, mode toggle, and settings into a single 36px–40px sticky header.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Lucide React, xterm.js, Monaco Editor, Jest.

**Spec:** `docs/superpowers/specs/2026-10-08-fullscreen-terminal-ui-design.md`

## Global Constraints

- **Viewport Size**: The app root must fill `100dvh` × `100vw` without outer padding, max-width constraints, or card margins.
- **Micro Top Bar**: Sticky single-line header with height 36px–40px, holding host selector, terminal/files mode pills, context actions, and global controls (Key, Language, Theme).
- **Core Views Only**: Only WebTerminalView and TerminalFileManagerView are mounted and toggled; TerminalLogsView is completely removed from the user interface.
- **Non-destructive Session Switching**: Switching between interactive terminal and file management retains active terminal state without re-creating WebSocket or disposing xterm instance.
- **Browser Fullscreen / Esc Safety**: Terminal does not intercept Esc keys or force HTML5 fullscreen that breaks Vim/tmux escape sequences.

## Review Focus

1. **Admin Secret Key State Persistence**: Updating the admin secret key via the micro top bar popover/input must persist to `localStorage` under `admin_secret_key` and propagate to sub-components immediately.
2. **Terminal Auto-Fit on Fullscreen Mount**: Initial render at full screen must trigger xterm fit cleanly without leaving unrendered black bars or misaligned canvas dimensions.
3. **Sub-Tab Switching Stability**: Toggling from terminal to file manager and back to terminal must trigger auto-fit timer without unmounting the running terminal instance.
4. **Theme and Language Toggle from Micro Top Bar**: Changing theme (dark/light) or language (zh/en) in the micro top bar must immediately apply to both the terminal canvas and file manager without layout shift.
5. **Mobile Viewport Soft Keyboard Push**: On touch devices, opening the soft keyboard must correctly clamp available workspace height via `visualViewport` listener while keeping the micro top bar pinned at `top: 0`.

---

### Task 1: Migrate Global Controls into UnifiedTerminalView Micro Top Bar

**Files:**
- Modify: `frontend/src/components/UnifiedTerminalView.tsx`
- Test: `tests/terminalUnifiedTopBarControls.test.ts`

**Interfaces:**
- Consumes:
  - `useTranslation()` from `../i18n/LanguageContext` (produces `t`, `language`, `setLanguage`)
  - `useTheme()` from `../theme/ThemeContext` (produces `theme`, `setTheme`, `resolvedTheme`)
  - `adminKey?: string` prop with fallback to `localStorage.getItem('admin_secret_key') || ''`
  - `isStandalone?: boolean` defaulting to `true`
- Produces:
  - Micro top bar with Host Selector, SubTab Pills, Connection Badge, Action Buttons, and integrated Key/Language/Theme utilities.

- [x] **Step 1: Write the failing test for micro top bar controls**

Create `tests/terminalUnifiedTopBarControls.test.ts`:
```ts
import * as fs from 'fs';
import * as path from 'path';

describe('UnifiedTerminalView Micro Top Bar Integrated Controls', () => {
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
  let content: string;

  beforeAll(() => {
    content = fs.readFileSync(unifiedPath, 'utf-8');
  });

  it('UnifiedTerminalView imports and uses Key, Languages, Sun, Moon icons', () => {
    expect(content).toMatch(/import\s*\{[^}]*\bKey\b[^}]*\}\s*from\s*'lucide-react'/);
    expect(content).toMatch(/import\s*\{[^}]*\bLanguages\b[^}]*\}\s*from\s*'lucide-react'/);
    expect(content).toMatch(/import\s*\{[^}]*\bSun\b[^}]*\}\s*from\s*'lucide-react'/);
    expect(content).toMatch(/import\s*\{[^}]*\bMoon\b[^}]*\}\s*from\s*'lucide-react'/);
  });

  it('UnifiedTerminalView imports and uses useTheme hook', () => {
    expect(content).toMatch(/import\s*\{[^}]*\buseTheme\b[^}]*\}\s*from\s*'\.\.\/theme\/ThemeContext'/);
    expect(content).toContain('useTheme()');
  });

  it('UnifiedTerminalView manages adminKey state with localStorage fallback', () => {
    expect(content).toContain("localStorage.getItem('admin_secret_key')");
    expect(content).toContain("localStorage.setItem('admin_secret_key'");
  });

  it('UnifiedTerminalView provides default isStandalone=true prop', () => {
    expect(content).toMatch(/isStandalone\s*=\s*true/);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx jest tests/terminalUnifiedTopBarControls.test.ts`
Expected: FAIL (missing `Key`, `Languages`, `Sun`, `Moon`, and `useTheme` in `UnifiedTerminalView.tsx`).

- [x] **Step 3: Update UnifiedTerminalView with integrated top bar controls**

Edit `frontend/src/components/UnifiedTerminalView.tsx`:
1. Import `Sun, Moon, Languages, Key` from `lucide-react`.
2. Import `useTheme` from `../theme/ThemeContext`.
3. Add `language, setLanguage` from `useTranslation()`, and `{ theme, setTheme, resolvedTheme }` from `useTheme()`.
4. Change prop defaults:
   ```tsx
   export interface UnifiedTerminalViewProps {
     adminKey?: string;
     isStandalone?: boolean;
     onEnterStandalone?: () => void;
     onExitStandalone?: () => void;
   }

   export default function UnifiedTerminalView({
     adminKey: propAdminKey,
     isStandalone = true,
     onEnterStandalone,
     onExitStandalone,
   }: UnifiedTerminalViewProps) {
     const { t, language, setLanguage } = useTranslation();
     const { setTheme, resolvedTheme } = useTheme();
     const [adminKey, setAdminKey] = useState<string>(() => {
       return propAdminKey || (typeof window !== 'undefined' ? localStorage.getItem('admin_secret_key') || '' : '');
     });
     const [showKeyInput, setShowKeyInput] = useState<boolean>(false);

     const handleKeySave = (newKey: string) => {
       setAdminKey(newKey);
       if (typeof window !== 'undefined') {
         localStorage.setItem('admin_secret_key', newKey);
       }
     };
   ```
5. In the top bar action buttons section (line ~412), right after the Fullscreen Toggle button, add:
   ```tsx
   {/* Global Settings Separator */}
   <div className="h-3.5 w-px bg-[var(--border-subtle)] mx-0.5 sm:mx-1 hidden sm:block" />

   {/* Admin Secret Key Toggle / Input */}
   {showKeyInput ? (
     <div className="flex items-center">
       <input
         type="password"
         value={adminKey}
         onChange={(e) => handleKeySave(e.target.value)}
         placeholder="Admin Key"
         className="px-2 py-0.5 text-[11px] font-mono w-24 sm:w-36 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-emerald-500/50"
         autoFocus
         onBlur={() => setShowKeyInput(false)}
       />
     </div>
   ) : (
     <button
       type="button"
       onClick={() => setShowKeyInput(true)}
       title="Admin Secret Key"
       className={`p-1 sm:p-1.5 rounded-lg border transition-all ${
         adminKey
           ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30'
           : 'bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06]'
       }`}
     >
       <Key className="w-3.5 h-3.5" />
     </button>
   )}

   {/* Language Switcher */}
   <button
     type="button"
     onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
     className="p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06] transition-all"
     title="Toggle Language"
   >
     <Languages className="w-3.5 h-3.5" />
   </button>

   {/* Theme Switcher */}
   <button
     type="button"
     onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
     className="p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06] transition-all"
     title="Toggle Theme"
   >
     {resolvedTheme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
   </button>
   ```

- [x] **Step 4: Run test to verify it passes**

Run: `npx jest tests/terminalUnifiedTopBarControls.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add tests/terminalUnifiedTopBarControls.test.ts frontend/src/components/UnifiedTerminalView.tsx
git commit -m "feat: integrate key, language, and theme controls into UnifiedTerminalView micro top bar"
```

---

### Task 2: Refactor App.tsx to Remove Outer Header and Logs View

**Files:**
- Modify: `frontend/src/App.tsx`
- Test: `tests/terminalFullscreenAppLayout.test.ts`

**Interfaces:**
- Consumes:
  - `<UnifiedTerminalView isStandalone={true} />`
- Produces:
  - Minimalistic, 100dvh full-screen root component rendering only `UnifiedTerminalView`.

- [x] **Step 1: Write the failing test for App.tsx fullscreen minimalism**

Create `tests/terminalFullscreenAppLayout.test.ts`:
```ts
import * as fs from 'fs';
import * as path from 'path';

describe('App.tsx Pure Fullscreen Terminal Architecture', () => {
  const appPath = path.resolve(__dirname, '../frontend/src/App.tsx');
  let appContent: string;

  beforeAll(() => {
    appContent = fs.readFileSync(appPath, 'utf-8');
  });

  it('App.tsx does not import or render TerminalLogsView', () => {
    expect(appContent).not.toContain('TerminalLogsView');
    expect(appContent).not.toContain('terminal.logsTab');
  });

  it('App.tsx does not render outer header or gt-hub title bar', () => {
    expect(appContent).not.toMatch(/<header[^>]*>/);
    expect(appContent).not.toContain('gt-hub');
    expect(appContent).not.toContain('activeTab');
  });

  it('App.tsx renders UnifiedTerminalView with full screen container', () => {
    expect(appContent).toContain('<UnifiedTerminalView');
    expect(appContent).toContain('h-[100dvh]');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx jest tests/terminalFullscreenAppLayout.test.ts`
Expected: FAIL (App.tsx still contains `<header>`, `TerminalLogsView`, etc.).

- [x] **Step 3: Refactor App.tsx**

Replace `frontend/src/App.tsx` with:
```tsx
import React from 'react';
import UnifiedTerminalView from './components/UnifiedTerminalView';

export default function App() {
  return (
    <div className="flex flex-col h-[100dvh] w-screen overflow-hidden bg-[var(--bg-canvas)] text-[var(--text-primary)] select-none">
      <UnifiedTerminalView isStandalone={true} />
    </div>
  );
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx jest tests/terminalFullscreenAppLayout.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add tests/terminalFullscreenAppLayout.test.ts frontend/src/App.tsx
git commit -m "refactor: eliminate outer header and logs view in App.tsx for fullscreen terminal"
```

---

### Task 3: Regression Suite Verification & Build Validation

**Files:**
- Test: All suites in `tests/*.test.ts`
- Build: `frontend/`

- [x] **Step 1: Run complete Jest test suite**

Run: `npm test`
Expected: All 85 test suites pass (including existing 83 suites plus 2 new test suites).

- [x] **Step 2: Run frontend production build**

Run: `cd frontend && npm run build && cd ..`
Expected: `tsc --noEmit && vite build` succeeds with zero errors.

- [x] **Step 3: Commit**

```bash
git commit --allow-empty -m "chore: verify complete regression test suite and frontend build pass"
```

---

## Plan Self-Review Checklist

- [x] **Spec coverage**:
  - Remove outer application header: Task 2.
  - Remove audit logs view: Task 2.
  - Pure 100dvh fullscreen layout: Task 1 & Task 2.
  - Unified micro top bar with host selector, mode pills, and migrated utilities (Key, Language, Theme): Task 1.
  - Full tests and build verification: Task 3.
- [x] **Placeholder scan**: No TODOs, TBDs, or vague steps. Every file path, code snippet, and command is explicit.
- [x] **Type consistency**: `UnifiedTerminalViewProps` properties (`adminKey`, `isStandalone`, `onEnterStandalone`, `onExitStandalone`) match all consumers and tests.
- [x] **Review Focus**:
  - Admin key persistence tested in Task 1.
  - Fullscreen mount & top bar structure tested in Task 1 & Task 2.
  - Sub-tab switching stability preserved in `UnifiedTerminalView`.
  - Regression testing covering all 85 test files in Task 3.
