# Remote Codex

参考 dsh-go 的移动工作流，为 Codex 做的手机远程控制台。电脑运行官方 `codex app-server`，手机通过一个带配对令牌的轻量桥接服务连接；无需把代码仓库、Codex 登录凭据或 API Key 放到手机里。

当前版本是可安装 PWA，适用于 Android 和 iPhone：发起/继续会话、查看流式消息和工具过程、插话、停止任务，以及在手机上处理命令和文件写入审批。

## 快速开始

要求：Node.js 20+，并且电脑已安装、登录 Codex CLI。

```bash
git clone <your-repository-url> remote-codex
cd remote-codex
npm start
```

默认只监听 `127.0.0.1`，用于电脑本机预览。让同一 Wi-Fi 下的手机访问：

```bash
npm run lan
```

终端会打印配对二维码和一个带 `#token=...` 的地址。用手机扫码或在浏览器打开地址即可完成配对。二维码完全在本机生成；令牌位于 URL fragment 中，不会随静态页面请求发送给服务器，首次配对后只保存在该浏览器的本地存储中。

打开会话列表，点“新建会话”，填写电脑上的绝对工作目录，然后发送任务。Safari 或 Chrome 中可使用“添加到主屏幕”获得接近原生 App 的体验。

## 常用启动参数

```text
--lan                 监听 0.0.0.0（局域网访问）
--host 127.0.0.1      自定义监听地址
--port 4173           自定义端口
--cwd /path/project   Codex app-server 的启动目录
--codex /path/codex   自定义 Codex CLI 路径
--token <secret>      固定配对令牌（也可用 REMOTE_CODEX_TOKEN）
--tls-cert cert.pem   HTTPS 证书
--tls-key key.pem     HTTPS 私钥
--verbose             输出 Codex app-server 日志
--no-qr               不在终端输出二维码
```

示例：

```bash
node src/server.mjs --lan --port 4173 --cwd /Users/me/dev/project
```

## 安全说明

- 默认仅监听本机；必须显式使用 `--lan` 才开放给局域网。
- 每次启动默认生成 192-bit 随机配对令牌，所有 `/api/*` 请求必须携带 Bearer Token。
- 手机端只被允许调用会话、消息、中断和审批相关 RPC。`thread/shellCommand`、`command/exec`、删除会话等高风险接口没有暴露。
- 审批默认使用 `on-request`，新会话默认采用 `workspace-write` 沙箱。界面会对 `danger-full-access` 给出额外警告。
- `--lan` 的普通 HTTP 只适用于可信局域网。跨公网使用时，请在反向代理或私有组网入口终止 TLS，或者提供 `--tls-cert` / `--tls-key`。不要直接把明文端口映射到公网。
- 手机上看到的批准动作会在电脑上产生真实修改。批准前请核对命令、工作目录和原因。

## 架构

```text
手机 PWA
  │  HTTPS / SSE / JSON（配对令牌）
  ▼
Remote Codex bridge（Node.js，无第三方运行时依赖）
  │  stdin/stdout JSON-RPC
  ▼
codex app-server
  │
  ▼
本机工作区 + 本机 Codex 登录
```

桥接层负责协议握手、RPC 白名单、SSE 事件转发和待审批请求保留。手机断线后重新连接，未处理的审批仍可通过 `/api/pending` 恢复。

## 开发

项目没有生产依赖：

```bash
npm test
node --check src/server.mjs
node --check public/app.js
```

主要目录：

- `src/codex-client.mjs`：Codex app-server 双向 JSON-RPC 客户端
- `src/server.mjs`：鉴权桥接、SSE、RPC 白名单和静态服务
- `public/`：手机优先 PWA
- `test/`：协议和安全单元测试

## 当前范围

已实现：会话列表、新建/恢复会话、模型与思考深度选择、流式回复、命令/文件过程卡片、插话、停止、命令审批、文件审批、`request_user_input` 回答、断线重连和 PWA 外壳。

下一阶段适合加入图片附件、语音输入、系统推送、多主机管理，以及 Flutter 原生壳。当前版本刻意不在手机本地运行 Codex，也不远程暴露任意 Shell。

## 致谢与许可

产品思路参考 [dsh-go](https://github.com/ccch1mneyyy/dsh-Go)，本项目未复制其代码、品牌或素材。Remote Codex 自身代码采用 MIT 许可证。
