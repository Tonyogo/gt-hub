# Script List Name Display Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the script library list and cron script selector so scripts display their actual filename/title rather than the hardcoded default template placeholder `"新脚本"`.

**Architecture:** Ignore default template placeholders (`"新脚本"` for `@title` and `"描述信息"` for `@description`) during backend metadata parsing in `ScriptService` so existing and new scripts without custom titles fall back to their filename `name`. Update `TerminalScriptDrawer` to use clean empty metadata comments on creation, always surface `item.name` when a custom `item.title` is shown, and prevent duplicate `name (name)` labels in `CronJobModal`.

**Tech Stack:** TypeScript, Node.js, Express, React 18, Jest

**Spec:** Approved in-chat Bounded design (`docs/superpowers/specs/2026-10-13-terminal-script-dispatch-design.md` §3.1)

## Global Constraints

- Targeted test execution during development: `npm test -- tests/<file>.test.ts` (per `CLAUDE.md`).
- Preserve existing `~/.gt/scripts/` file format and `# @title:`, `# @description:`, `# @interpreter:` header parsing contract.
- When no custom `@title` is provided (or when `@title` is empty or equals `"新脚本"`), `title` must fall back to the script filename `name`.

## Review Focus

- Existing script files on disk containing `# @title: 新脚本` and `# @description: 描述信息` from the old template must resolve to `title: <filename>` and `description: ""` without manual file edits.
- Scripts with whitespace-only header tags (`# @title:   ` or `# @description:   `) must fall back to `title: <filename>` and `description: ""`.
- Scripts with a genuine custom title (e.g. `# @title: 系统健康检查` on `health.sh`) must preserve `title: "系统健康检查"` while still displaying the filename `health.sh` in the drawer list item.
- `CronJobModal` script `<option>` elements must render `health.sh (系统健康检查)` when a custom title differs from `name`, and `health.sh` (not `health.sh (health.sh)`) when `title === name`.

---

### Task 1: Backend `ScriptService` Default Placeholder Filtering

**Files:**
- Modify: `src/server/modules/scripts/scriptService.ts:56-85`
- Test: `tests/scriptService.test.ts`

**Interfaces:**
- Produces: `ScriptService.prototype.listScripts(): Promise<ScriptMetadata[]>`, `ScriptService.prototype.getScript(name: string): Promise<ScriptDetail>`, `ScriptService.prototype.saveScript(name: string, content: string): Promise<ScriptMetadata>` where `title` falls back to `name` when `# @title:` is missing, empty, or `"新脚本"`, and `description` falls back to `""` when `# @description:` is missing, empty, or `"描述信息"`.

- [x] **Step 1: Write the failing tests in `tests/scriptService.test.ts`**

```typescript
  it('ignores default template placeholders ("新脚本" and "描述信息") and falls back to script filename', async () => {
    const content = '#!/usr/bin/env bash\n# @title: 新脚本\n# @description: 描述信息\n\necho "Hello World"\n';
    await service.saveScript('deploy-app.sh', content);

    const list = await service.listScripts();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: 'deploy-app.sh',
      title: 'deploy-app.sh',
      description: '',
      interpreter: 'bash',
    });
  });

  it('falls back to filename when @title and @description tags are empty', async () => {
    const content = '#!/usr/bin/env bash\n# @title:   \n# @description:   \n\necho "ok"\n';
    await service.saveScript('clean-logs.sh', content);

    const detail = await service.getScript('clean-logs.sh');
    expect(detail.title).toBe('clean-logs.sh');
    expect(detail.description).toBe('');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/scriptService.test.ts`
Expected: FAIL on `ignores default template placeholders ("新脚本" and "描述信息") and falls back to script filename` (`Expected: "deploy-app.sh", Received: "新脚本"`)

- [x] **Step 3: Update `parseMetadata` in `src/server/modules/scripts/scriptService.ts`**

In `parseMetadata(name: string, content: string, stat: fs.Stats): ScriptMetadata`, treat `title === '新脚本'` as unset (falling back to `name`) and `description === '描述信息'` as unset (`''`).

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/scriptService.test.ts`
Expected: PASS (all tests in `tests/scriptService.test.ts` green)

- [x] **Step 5: Commit**

```bash
git add src/server/modules/scripts/scriptService.ts tests/scriptService.test.ts
git commit -m "fix(scripts): ignore default template placeholders in metadata parser"
```

---

### Task 2: Frontend `TerminalScriptDrawer` & `CronJobModal` Display and Template Fix

**Files:**
- Modify: `frontend/src/components/terminal/TerminalScriptDrawer.tsx:129-136,303-313`
- Modify: `frontend/src/components/terminal/components/CronJobModal.tsx:371-375`
- Test: `tests/terminalScriptDrawer.test.ts`

**Interfaces:**
- Consumes: `ScriptMetadata` (`{ name, title, description, interpreter, size, updatedAt }`) from `/api/admin/scripts`
- Produces: Updated `TerminalScriptDrawer` and `CronJobModal` rendering

- [x] **Step 1: Write the failing test in `tests/terminalScriptDrawer.test.ts`**

```typescript
  it('uses empty metadata tags in new script template and displays script filename in list items', () => {
    const content = fs.readFileSync(componentPath, 'utf-8');
    expect(content).not.toContain('# @title: 新脚本');
    expect(content).toContain('# @title:');
    expect(content).toContain('item.title && item.title !== item.name && item.title !== \'新脚本\'');
  });

  it('avoids duplicate script name in CronJobModal option label when title equals name', () => {
    const cronModalPath = path.resolve(
      __dirname,
      '../frontend/src/components/terminal/components/CronJobModal.tsx'
    );
    const cronContent = fs.readFileSync(cronModalPath, 'utf-8');
    expect(cronContent).toContain('s.title && s.title !== s.name');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/terminalScriptDrawer.test.ts`
Expected: FAIL (`expect(content).not.toContain('# @title: 新脚本')`)

- [x] **Step 3: Update `TerminalScriptDrawer.tsx` and `CronJobModal.tsx`**

In `frontend/src/components/terminal/TerminalScriptDrawer.tsx`:
1. In `handleStartCreate`, set initial template content to `'#!/usr/bin/env bash\n# @title: \n# @description: \n\necho "Hello World"\n'`.
2. In the script list button rendering, display `{item.title && item.title !== '新脚本' ? item.title : item.name}` as the primary label, render `<p className="text-[10px] text-[var(--text-muted)] font-mono truncate">{item.name}</p>` when `item.title && item.title !== item.name && item.title !== '新脚本'`, and only render `item.description` when `item.description && item.description !== '描述信息'`.

In `frontend/src/components/terminal/components/CronJobModal.tsx`:
1. In the script `<select>` options, render `{s.name} {s.title && s.title !== s.name && s.title !== '新脚本' ? `(${s.title})` : ''}`.

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/terminalScriptDrawer.test.ts tests/scriptRoutes.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/components/terminal/TerminalScriptDrawer.tsx frontend/src/components/terminal/components/CronJobModal.tsx tests/terminalScriptDrawer.test.ts
git commit -m "fix(frontend): display actual script filename and remove hardcoded template title"
```
