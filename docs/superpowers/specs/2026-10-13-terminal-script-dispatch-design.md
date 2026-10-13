# 网页在线终端服务端脚本管理与下发执行设计规范 (Design Spec)

- **作者/设计人**: gt-hub 团队
- **日期**: 2026-10-13
- **状态**: Draft / Pending Approval
- **目标组件**: Server (`src/server/`), Terminal (`src/terminal/`), Frontend (`frontend/src/`)

---

## 1. 背景与目标 (Background & Goals)

### 1.1 背景
在 `gt-hub` 中，用户可以通过 Web 浏览器与本地或远程 Agent 建立 WebTerminal (PTY) 会话，完成集群运维、排错与命令交互。在实际运维工作中，存在大量高频复用的运维指令和复杂多行脚本（例如健康检查、性能排查、环境初始化、服务重启等）。用户目前需要手动在本地复制粘贴大段脚本到终端，容易受换行丢失、缩进错乱、字符转义或终端历史污染等问题困扰。

### 1.2 目标
1. **服务端集中持久化**：在服务端提供统一的脚本存储空间，支持通过 REST API 进行增删改查；支持直接在服务端目录维护文件（如 git clone 脚本库）。
2. **多行与复杂脚本支持**：不仅支持单行快捷指令，还支持几十至上百行的复杂多行 Shell/Python 脚本。
3. **PTY 安全透明下发**：脚本下发至当前活动终端的 PTY 会话中执行，保持上下文（当前工作目录、环境变量）、支持终端交互输入（如 sudo 密码或确认提示），且不破坏终端显示与格式。
4. **前端交互友好**：在 WebTerminal 提供抽屉式脚本管理面板，支持实时搜索、代码预览/就地编辑、防误触确认与一键执行到当前终端。

---

## 2. 总体架构与数据流 (Architecture & Data Flow)

```
+-------------------------------------------------------------------------------+
|                                Frontend (Web)                                 |
|                                                                               |
|  +--------------------+         +-------------------------------------------+ |
|  | WebTerminalView    | <-----> | TerminalScriptDrawer (脚本抽屉)           | |
|  | (Xterm.js PTY 会话)|         | - 脚本列表 & 过滤                          | |
|  +--------------------+         | - 预览 & Monaco/Textarea 编辑             | |
|           ^                     | - [执行到当前终端] 按钮                   | |
|           |                     +-------------------------------------------+ |
|           | (sendInput / WS)                          | (REST API)            |
+-----------|-------------------------------------------|-----------------------+
            |                                           |
            v (WebSocket PTY)                           v (HTTP REST: /api/admin/scripts)
+------------------------------------+      +-----------------------------------+
| Server: terminalWs.ts              |      | Server: scriptRoutes.ts           |
| (下发包装指令: bash -c "$(echo...)")|      | (CRUD + 路径穿越防御)             |
+------------------------------------+      +-----------------------------------+
            |                                                   |
            | PTY Tunnel                                        v File System
+------------------------------------+      +-----------------------------------+
| Target Host / Agent Node           |      | Storage Directory:                |
| - 执行子 shell: 隔离 exit 状态      |      | ~/.gt/scripts/                    |
| - 保持 stdin 交互能力 (read/sudo)  |      | (*.sh, *.bash, *.py)              |
+------------------------------------+      +-----------------------------------+
```

---

## 3. 详细设计 (Detailed Specifications)

### 3.1 服务端存储与元数据解析 (Server Storage & Parsing)

1. **存储路径**：
   - 默认存储于 `~/.gt/scripts/`（可通过环境变量 `GT_SCRIPTS_DIR` 或配置文件覆盖）。
   - 服务启动时检测该目录，如不存在则通过 `fs.mkdirSync(dir, { recursive: true, mode: 0o755 })` 自动初始化。
2. **支持格式**：
   - 支持 `.sh`, `.bash`, `.py`, `.js` 等常见脚本扩展名。
3. **头部元数据自包含解析**：
   - 服务端读取脚本前 20 行，解析以 `#` 开头的元数据注解：
     ```bash
     #!/usr/bin/env bash
     # @title: 检查系统性能与负载
     # @description: 采集当前 CPU、内存使用率与磁盘剩余空间
     # @interpreter: bash
     ```
   - 若未提供注解，默认提取文件名作为 `title`，`description` 留空，根据后缀自动推断 `interpreter`（`.sh`/`.bash` -> `bash`，`.py` -> `python3`，`.js` -> `node`）。

### 3.2 服务端 REST API 规范

所有端点均挂载于 `/api/admin/scripts`，复用 `adminSecretKey`（Header `x-admin-key`）校验机制。

#### 1. `GET /api/admin/scripts`
- **功能**：列出所有可用脚本元数据。
- **返回示例**：
  ```json
  {
    "success": true,
    "data": [
      {
        "name": "check-system.sh",
        "title": "检查系统性能与负载",
        "description": "采集当前 CPU、内存使用率与��盘剩余空间",
        "interpreter": "bash",
        "size": 1024,
        "updatedAt": "2026-10-13T08:00:00.000Z"
      }
    ]
  }
  ```

#### 2. `GET /api/admin/scripts/:name`
- **功能**：获取指定脚本的完整源码及详细信息。
- **返回示例**：
  ```json
  {
    "success": true,
    "data": {
      "name": "check-system.sh",
      "title": "检查系统性能与负载",
      "description": "采集当前 CPU、内存使用率与磁盘剩余空间",
      "interpreter": "bash",
      "content": "#!/usr/bin/env bash\necho 'Checking...'\n..."
    }
  }
  ```

#### 3. `POST /api/admin/scripts`
- **功能**：创建新脚本。
- **请求体**：
  ```json
  {
    "name": "deploy-app.sh",
    "content": "#!/usr/bin/env bash\n# @title: 部署应用\n..."
  }
  ```

#### 4. `PUT /api/admin/scripts/:name`
- **功能**：更新已有脚本内容。
- **请求体**：
  ```json
  {
    "content": "..."
  }
  ```

#### 5. `DELETE /api/admin/scripts/:name`
- **功能**：删除指定脚本。

#### 6. 安全防御规范
- **文件名强校验**：仅允许合规安全字符 `^[a-zA-Z0-9_\-\.]+$`。
- **路径遍历防护**：服务端通过 `path.resolve(scriptsDir, name)` 运算后比对 `resolvedPath.startsWith(scriptsDir)`，严格禁止包含 `..`、`/` 或 `\` 的输入。
- **文件体积限制**：限制脚本上传和保存大小上限为 1MB。

---

### 3.3 终端下发与安全执行通道规范

#### 1. 下发指令封装
为防止多行脚本破坏终端格式、污染终端历史记录，同时确保子 shell 隔离及 stdin 交互可用，前端在下发时将脚本内容编码为单行 Base64 执行结构：

- **UTF-8 编码转换**：
  ```ts
  function encodeScriptToBase64(content: string): string {
    return btoa(unescape(encodeURIComponent(content)));
  }
  ```
- **解释器包装指令**：
  - `bash` / `sh`：
    ```bash
    bash -c "$(echo '<base64>' | base64 -d)"
    ```
  - `python3`：
    ```bash
    python3 -c "$(echo '<base64>' | base64 -d)"
    ```
  - `node`：
    ```bash
    node -e "$(echo '<base64>' | base64 -d)"
    ```

#### 2. 关键防护机制
1. **子进程与终端会话隔离**：使用 `bash -c "..."` 执行，脚本中的 `exit 1` 只退出子进程，绝对不会意外终止用户的 WebTerminal 当前主 Shell 会话。
2. **保持交互性**：通过命令替换 `$(echo ... | base64 -d)` 作为脚本内容直接传递给 `bash -c`，脚本执行时的 `stdin` 依然挂载在当前终端 PTY 上，支持 `sudo` 密���输入、`read -p` 等交互操作。
3. **光标自动回归**：下发后前端调用 `sendInput(command + '\r')`，并自动调用 `terminal.focus()`，用户无缝接管执行。

---

### 3.4 前端界面与交互设计 (UI & UX)

#### 1. 入口与布局
- 在 `WebTerminalView.tsx` 顶部工具栏（位于连接状态右侧）新增「脚本库」图标按钮（`ScrollText` 或 `FileCode` 图标）。
- 点击打开右侧滑出抽屉 `TerminalScriptDrawer`，宽度约 `500px ~ 640px`（在小屏下自适应 100% 宽度）。

#### 2. 抽屉内部结构
- **顶部工具条**：
  - 搜索输入框（支持实时按名称、描述模糊搜索）。
  - 「新建脚本」按钮。
- **脚本列表区域**：
  - 卡片式展示脚本名称、解释器标签、描述摘要、更新时间。
  - 选中项高亮激活。
- **详情与操作区域**：
  - 脚本预览区：支持行号和代码高亮。
  - 模式切换：支持「预览」与「编辑」模式就地切换。
  - 底部操作栏：
    - 主操作按钮：**「执行到当前终端」**（显示当前目标主机名，若当前终端未连接则置灰禁用）。
    - 次操作按钮：**「保存修改」**、**「取消」**、**「删除」**。

#### 3. 国际化 (i18n)
在 `frontend/src/i18n/locales/` 中增加中英文对照字典���：
- `webTerminal.scripts.title`：“脚本库” / “Script Library”
- `webTerminal.scripts.runToTerminal`：“执行到当前终端” / “Run in Current Terminal”
- `webTerminal.scripts.notConnected`：“终端未连接，无法执行” / “Terminal not connected”
- `webTerminal.scripts.newScript`：“新建脚本” / “New Script”
- `webTerminal.scripts.saveSuccess`：“脚本保存成功” / “Script saved successfully”
- `webTerminal.scripts.deleteConfirm`：“确定要删除该脚本吗？” / “Are you sure to delete this script?”

---

## 4. 测试与验证策略 (Testing & Verification)

1. **后端单元测试** (`tests/scripts.test.ts`)：
   - 验证脚本目录自动创建与文件增删改查。
   - 验证路径穿越攻击被正确阻断（如 `../../etc/passwd`）。
   - 验证头部元数据（`@title`, `@description`, `@interpreter`）解析正确性。
2. **前端与集成测试**：
   - 验证抽屉展开/折叠、脚本搜索过滤、多语言切换正常。
   - 验证 Base64 编码对包含中文、特殊字符（如 `$`, `"`, `'`, `\`）的脚本解析无乱码。
   - 验证在离线/未连接终端状态下下发按钮正确禁用。
