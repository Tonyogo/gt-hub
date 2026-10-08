# 强制认证守卫与登录页面系统设计规范

## 1. 概述与背景

当前 `gt-hub` 在服务端配置了 `ADMIN_SECRET_KEY` 时，前端缺乏严格的全局路由/页面认证守卫机制。未认证的用户访问站点时，界面依然会直接加载并渲染全屏 Web 终端与文件管理组件；后台由于缺乏有效密钥而请求 `/api/terminal/hosts` 报错 `401 Unauthorized: Invalid x-admin-key`，导致安全边界不够严密、用户体验不直观。

本次重构旨在引入严格的**强制认证门禁（Auth Guard）**：
1. **未登录绝对不可见**：未登录（未认证）状态下，全面阻断终端与文件管理器组件的渲染与网络请求，强制呈现全屏登录界面。
2. **智能模式感知**：自动探测服务端是否开启密钥保护。若服务端未配置密钥，则无需强制登录直接进入系统；若服务端已开启密钥，则必须凭有效密钥登录。
3. **闭环生命周期管理**：提供主动“退出登录”功能，并在任意接口或 WebSocket 握手捕获到 401 凭证失效时，自动清理本地缓存并强制回退至登录页。

---

## 2. 系统架构与交互流

### 2.1 整体认证流程
```text
[ 用户打开浏览器访问站点 ]
            │
            ▼
[ Auth Guard 探测状态 (/api/auth/status) ]
            │
   ┌────────┴──────────────────────────┐
   ▼                                   ▼
【未开启密钥保护】               【开启密钥保护】
(authRequired: false)                  │
   │                          ┌────────┴────────┐
   │                          ▼                 ▼
   │                    [ 本地存在有效Key ]  [ 无Key 或 Key无效 ]
   │                          │                 │
   │                          │                 ▼
   │                          │          【强制渲染 LoginView 登录页】
   │                          │                 │
   │                          │          [ 用户输入密钥并提交 ]
   │                          │                 │
   │                          │                 ▼
   │                          │          [/api/auth/login 校验通过]
   │                          │                 │
   └───────────────────────��──┼─────────────────┘
                              ▼
           【渲染 UnifiedTerminalView 全屏工作区】
                              │
               ┌──────────────┴──────────────┐
               ▼                             ▼
       [ 主动点击登出 ]             [ 业务接口捕获 401 ]
               │                             │
               └──────────────┬──────────────┘
                              ▼
                 [ 清理本地凭证与主机缓存 ]
                              ▼
                 [ 强制跳转回 LoginView ]
```

---

## 3. 后端接口设计 (Auth API)

### 3.1 认证状态探测接口
- **路径**：`GET /api/auth/status`
- **鉴权要求**：公开访问（无需预先携带鉴权头）
- **请求头**（可选）：`x-admin-key: <string>`
- **响应格式**：
  ```json
  {
    "authRequired": true,
    "authenticated": false
  }
  ```
- **业务逻辑**：
  - `authRequired = Boolean(config.adminSecretKey)`
  - 若 `!authRequired`，则 `authenticated = true`；
  - 若 `authRequired`，检查请求传入的 `x-admin-key` 或 query 是否与 `config.adminSecretKey` 恒等。匹配则 `authenticated = true`，否则 `authenticated = false`。
  - HTTP 状态码统一返回 `200`（状态探测本身不抛 401，避免网络控制台不必要的报错标红）。

### 3.2 登录验证接口
- **路径**：`POST /api/auth/login`
- **鉴权要求**：公开访问
- **请求体**：
  ```json
  {
    "key": "your-secret-key"
  }
  ```
- **响应格式**：
  - 成功 (200)：`{ "success": true }`
  - 失败 (401)：`{ "error": "Unauthorized: Invalid secret key" }`
- **业务逻辑**：
  - 若服务端未配置密钥，直接返回 `{ "success": true }`；
  - 若配置了密钥，核对 `req.body.key`。核对成功返回 200，失败返回 401。

---

## 4. 前端架构与认证守卫 (Auth Guard)

### 4.1 全局认证状态设计
在前端引入 `AuthContext` 或根层状态管理，定义三种核心生命周期：
- `status: 'checking' | 'authenticated' | 'unauthenticated'`
- `adminKey: string`
- `authRequired: boolean`
- `login(key: string): Promise<boolean>`
- `logout(): void`

### 4.2 路由与挂载保护 (`App.tsx`)
```tsx
export default function App() {
  const { status, adminKey, logout } = useAuth();

  if (status === 'checking') {
    return <FullScreenLoadingPlaceholder />;
  }

  if (status === 'unauthenticated') {
    return <LoginView />;
  }

  return <UnifiedTerminalView adminKey={adminKey} onLogout={logout} isStandalone={true} />;
}
```
- **安全隔离**：在 `status !== 'authenticated'` 时，`UnifiedTerminalView` 完全不被挂载，彻底杜绝 xterm 初始化、WebSocket 握手及主机轮询。

### 4.3 全屏登录页 (`LoginView.tsx`)
- **布局定位**：全屏 `100dvh` × `100vw` 居中卡片，暗黑/明亮自适应科技风格。
- **右上角快捷操作**：
  - 语言切换（中 / 英）。
  - 主题切换（深 / 浅）。
- **表单内容**：
  - 居中 Logo（`gt-hub` 终端图标与品牌标题）。
  - 密钥输入框（支持明暗文切换、回车提交、自动聚焦）。
  - 登录按钮（支持加载状态、防连击）。
  - 错误提示区（当校验失败或从 401 拦截退出时显示友好的错误提示）。

### 4.4 顶栏退出登录与 401 拦截
- **顶栏右侧工具区更新**：
  - 如果系统启用了密钥保护（`authRequired === true`），微顶栏右侧展示 `LogOut`（退出登录）图标按钮。
  - 点击登出按钮后，执行 `logout()`，清理 `localStorage` 和 `sessionStorage`，并回退至��录页。
- **全局 401 拦截**：
  - 封装统一的 fetch 错误处理或在全局层监听。当任何业务接口（如获取节点列表、文件列表等）响应 401 时，触发 `onUnauthorized` 回调，强制切换状态为 `unauthenticated` 并清除无效密钥。

---

## 5. 测试与验证策略

1. **后端接口单元测试**：
   - 验证配置密钥时 `/api/auth/status` 与 `/api/auth/login` 的正向与反向返回。
   - 验证无密钥配置时 `/api/auth/status` 自动返回 `authRequired: false` 与 `authenticated: true`。
2. **前端守卫集成测试**：
   - 测试未登录状态下 `App.tsx` 仅渲染 `LoginView`，绝不挂载 `UnifiedTerminalView`。
   - 测试输入正确密钥后成功流转进入 `UnifiedTerminalView`。
   - 测试主动登出与 401 拦截时退回到 `LoginView` 的流程。
3. **全量构建验证**：
   - 执行 `npm test` 与 `cd frontend && npm run build` 确保零错误。
