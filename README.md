# Coyote WSS Relay Server

> PEAK × DG-LAB / Coyote 官方 WebSocket 中继服务器  
> 当前版本：**V2.6.5**

Coyote WSS Relay Server 是为 **PEAK-DG-LAB-Integration** 提供公网连接能力的中继服务端。

它用于在运行 Coyote 的电脑与 DG-LAB App 之间建立安全、稳定的 WebSocket 通道，并提供 Web 管理后台、连接管理、设备树、IP 封禁、日志审计、运行状态监控和安全限制等功能。

官方中继示例：

```text
wss://peak.hbsuzh.cn
```

管理后台示例：

```text
https://peak.hbsuzh.cn
```

---

## 1. 项目定位

Coyote 客户端默认支持本地直连。

当电脑与手机无法直接互访时，可以使用公网 WSS 中继：

```text
Coyote Client
      │
      │ WSS / TLS
      ▼
┌───────────────────────┐
│ Coyote Relay Server   │
│ Caddy + Bun Relay     │
└───────────────────────┘
      ▲
      │ WSS / TLS
      │
DG-LAB App
```

服务器本身不负责生成游戏规则或电击逻辑。

它主要负责：

- Controller 与 DG-LAB App 的连接建立
- WebSocket 消息中转
- 多设备连接管理
- 公网 TLS/WSS 接入
- 管理员 Web 后台
- IP 封禁与解除封禁
- 在线客户端与设备查看
- 日志与运行状态查看
- 服务器资源监控
- 安全限制与运行参数管理

---

## 2. 核心特性

### 2.1 WSS 加密中继

公网连接推荐使用：

```text
wss://
```

部署结构：

```text
Internet :443
     │
     ▼
   Caddy
     │
     ▼
Docker Internal Network
     │
     ▼
Bun Relay :9998
```

默认情况下：

- 公网仅开放 HTTPS/WSS 端口
- Relay 内部 `9998` 不直接暴露公网
- Caddy 负责 TLS
- Bun 负责 WebSocket 中继与管理 API

---

### 2.2 多 Controller / 多 DG-LAB 设备

一个服务器可以同时承载多个 Coyote Controller。

单个 Controller 下可以连接多个 DG-LAB App / 郊狼设备。

管理后台采用树形结构显示：

```text
控制端 A
├─ 郊狼 1
├─ 郊狼 2
└─ 郊狼 3

控制端 B
├─ 郊狼 1
└─ 郊狼 2
```

适合多人同时使用时进行集中管理。

---

### 2.3 Web 管理后台

浏览器访问绑定域名即可进入管理后台：

```text
https://your-domain.example
```

默认初始账号：

```text
用户名：admin
密码：admin
```

首次登录后应立即修改密码。

管理后台主要提供：

- 服务运行状态
- Controller 数量
- DG-LAB 客户端数量
- 在线 IP 数
- 已封禁 IP 数
- 控制端树形设备管理
- 客户端详细信息
- 游戏状态与设备状态
- 客户端日志
- 服务器日志
- IP 黑名单
- 安全参数
- 服务器 CPU / 内存 / 磁盘信息

---

## 3. 设备管理

V2.6.3 将设备管理调整为 **Controller → 附属郊狼设备** 的层级结构。

默认界面更适合大量用户：

```text
▶ 控制端 A     3 郊狼
▶ 控制端 B     1 郊狼
▶ 控制端 C     6 郊狼
▶ 控制端 D     2 郊狼
```

展开控制端后再显示其附属设备。

支持：

- 按控制端查看附属设备数量
- 展开 / 收起
- 全部展开
- 全部收起
- 按设备数量排序
- 按最近活动排序
- 按连接时间排序
- 按 IP 搜索
- 按 Controller ID 搜索
- 按客户端 ID 搜索
- 按设备名称 / Slot 搜索
- 踢下线控制端
- 踢下线单个设备
- 封禁 IP

---

## 4. 封禁与踢下线

### 踢下线

踢下线属于一次性断开。

客户端本身具备自动重连机制，因此被踢后仍可以重新连接服务器。

适合：

- 临时断开连接
- 测试
- 清理异常会话

### IP 封禁

封禁后：

- 当前连接立即断开
- 相同 IP 后续 WebSocket 连接被拒绝
- 管理后台保存封禁原因
- 客户端可以显示封禁状态与原因
- 解除封禁后客户端可恢复连接

封禁状态只作用于对应公网中继，不应影响客户端本地直连模式。

---

## 5. 客户端状态与隐私

Coyote 客户端可以向服务器上传诊断信息，用于管理员排查连接问题。

客户端拥有本地隐私控制权：

```text
□ 禁止上传日志
□ 禁止上传设备信息和游戏信息
```

用户关闭上传后：

- Relay 的基本中转功能仍然正常
- 服务器不会要求客户端绕过该本地隐私设置

诊断数据通过现有 WSS/TLS 通道传输，不需要额外开放公网 UDP 日志端口。

---

## 6. 日志系统

服务器支持两类日志。

### 服务器日志

记录：

- Controller 连接 / 断开
- DG-LAB 客户端连接 / 断开
- WebSocket 异常
- IP 封禁 / 解封
- 管理员登录
- 登录失败
- 安全限流
- 管理配置修改
- 服务端错误

### 客户端日志

在客户端允许上传的情况下，可以按客户端查看：

- Coyote 连接日志
- 游戏事件
- 规则触发
- 输出记录
- 设备状态
- 其他客户端诊断日志

客户端日志可以由服务器设置为：

```text
关闭
实时
间隔上传
```

客户端本地的“禁止上传日志”优先级更高。

---

## 7. 服务器资源监控

管理后台可以查看服务器自身运行信息，例如：

- Relay 进程内存
- Heap 使用情况
- 系统总内存
- 系统可用内存
- CPU 核心数
- Load Average
- Docker / cgroup 内存
- 磁盘总容量
- 磁盘剩余容量
- `/data` 数据目录占用
- Relay 运行时间
- 系统运行时间

用于快速判断服务器是否存在资源不足或异常负载。

---

## 8. 安全机制

服务端内置基础安全限制，包括：

- HTTPS / WSS
- 管理后台登录
- 首次登录强制修改默认密码
- 密码 Hash 保存
- 登录失败次数限制
- 登录 IP 临时锁定
- 全局登录频率限制
- 管理 API 限流
- WebSocket 单 IP 连接数限制
- WebSocket 握手频率限制
- 单 Controller 附属客户端数量限制
- 单条消息大小限制
- 单连接消息速率限制
- IP 黑名单
- Session Token
- HttpOnly Cookie
- Secure Cookie
- SameSite Cookie
- CSRF 防护
- CSP
- 防 iframe
- 基础安全响应头

安全参数可以在管理后台进行调整。

---

## 9. 默认限制

实际数值可以根据服务器资源调整。

默认示例：

```text
最大总连接                    4000
单 IP 最大连接                64
单 Controller 最大客户端      16
单 IP WS 握手 / 分钟          240
单连接消息 / 秒               120
```

生产环境建议根据 CPU、内存、网络带宽和真实并发情况进行压力测试后调整。

---

## 10. 目录结构

典型目录：

```text
Coyote_WSS/
├─ Dockerfile
├─ deploy.sh
├─ deploy.ps1
├─ manage.sh
├─ manage.ps1
├─ compose.auto-tls.yaml
├─ compose.manual-tls.yaml
├─ compose.plain.yaml
├─ server/
│  ├─ v4-server.ts
│  ├─ admin.html
│  ├─ admin.js
│  └─ admin.css
├─ sites/
└─ generated-client-config/
```

核心程序：

```text
server/v4-server.ts
```

Web 管理后台：

```text
server/admin.html
server/admin.js
server/admin.css
```

---

## 11. 部署模式

支持三种部署模式。

### 自动 TLS

适合已经正确解析到服务器的域名。

```text
HTTPS / WSS
Caddy 自动申请和续期证书
```

### 手动 TLS

使用已有证书。

推荐文件：

```text
fullchain.pem
privkey.pem
```

典型位置：

```text
sites/<domain>/certs/
```

### 无 TLS

使用：

```text
ws://
http://
```

仅建议测试环境或可信内网使用。

公网环境不推荐明文 WebSocket。

---

## 12. Linux 部署

赋予执行权限：

```bash
chmod +x *.sh
```

启动交互部署：

```bash
./deploy.sh
```

按照提示配置：

- 域名 / IP
- TLS 模式
- 证书
- 公网端口
- Relay 内部端口
- 防火墙
- 安全参数

---

## 13. 常用管理命令

```bash
./manage.sh
```

不带参数时可进入交互管理菜单。

常见命令：

```bash
./manage.sh status
./manage.sh logs
./manage.sh relay-logs
./manage.sh caddy-logs
./manage.sh start
./manage.sh stop
./manage.sh restart
./manage.sh reload
./manage.sh doctor
./manage.sh config
./manage.sh backup
./manage.sh admin
```

---

## 14. 上传源码后的正确刷新方式

如果只是重启当前已经构建好的容器：

```bash
./manage.sh restart
```

如果修改或上传了：

```text
server/v4-server.ts
server/admin.html
server/admin.js
server/admin.css
Dockerfile
```

必须重新构建镜像：

```bash
./manage.sh reload
```

`reload` 会重新 Build 并刷新容器。

源码更新后只执行 `restart` 不会把新代码复制进已有镜像。

---

## 15. Docker 开机自启

推荐 Compose 使用：

```yaml
restart: unless-stopped
```

或根据服务器用途设置：

```yaml
restart: always
```

同时确保 Docker 服务开机启动：

```bash
systemctl enable docker
```

检查：

```bash
systemctl is-enabled docker
```

---

## 16. 健康检查

部署完成后：

```bash
curl https://your-domain.example/healthz
```

正常情况下返回类似：

```json
{
  "ok": true,
  "service": "coyote-dglab-relay",
  "version": "2.6.3"
}
```

也可以检查容器：

```bash
docker ps
```

Relay 应显示：

```text
healthy
```

---

## 17. 故障诊断

Relay 日志：

```bash
docker logs --tail 200 coyote-relay-relay-1
```

Caddy 日志：

```bash
docker logs --tail 200 coyote-relay-caddy-1
```

一键诊断：

```bash
./manage.sh doctor
```

检查健康状态：

```bash
curl https://your-domain.example/healthz
```

---

## 18. 数据持久化

服务器通过 Docker Volume 保存运行数据。

其中可能包括：

- 管理员账户信息
- 管理员密码 Hash
- IP 黑名单
- 安全配置
- 客户端历史
- 客户端日志
- 服务器日志

重新构建 Relay 镜像通常不会清除这些数据。

如果执行 Volume 删除操作，则相关持久化数据也会被永久删除。

---

## 19. 官方推荐拓扑

生产环境推荐：

```text
                  Internet
                     │
                     │ HTTPS / WSS :443
                     ▼
              ┌─────────────┐
              │    Caddy    │
              │ TLS / Proxy │
              └──────┬──────┘
                     │
             Docker Internal
                     │
                     ▼
              ┌─────────────┐
              │ Bun Relay   │
              │    :9998    │
              └─────────────┘
                     │
                  relay_data
```

不建议直接把：

```text
9998
```

暴露到公网。

---

## 20. 与客户端的关系

服务器与 Coyote 客户端职责分离。

### Coyote 客户端负责

- PEAK 游戏遥测
- 规则判断
- 强度 / 波形逻辑
- 本地设备控制
- 多人玩家逻辑
- 网络模式选择
- 用户隐私设置

### Relay Server 负责

- WSS 中继
- 会话管理
- Controller / DG-LAB App 映射
- 在线设备管理
- 管理后台
- 日志
- 安全策略
- IP 封禁
- 服务端运行监控

服务器不会替代客户端的游戏控制逻辑。

---

## 21. 项目状态

当前服务端版本：

```text
V2.6.3
```

当前重点能力：

```text
WSS 中继
多 Controller
多郊狼设备
树形设备管理
Web 管理后台
IP 封禁
客户端诊断
日志管理
服务器资源监控
运行时安全参数
Docker 部署
TLS
```

---

## 22. 安全提示

如果服务器公开到互联网：

1. 首次部署后立即修改 `admin/admin`
2. 使用 HTTPS/WSS
3. 不直接暴露 Relay 内部端口
4. 定期检查异常 IP
5. 定期备份持久化数据
6. 定期更新 Docker 基础镜像
7. 根据实际并发设置连接和速率限制
8. 不要将证书私钥提交到公开 Git 仓库

---

## 23. 相关项目

客户端项目：

```text
PEAK-DG-LAB-Integration
```

服务端用于为该客户端提供可选的公网 WSS 中继能力。

---

## License

请以项目仓库实际提供的 LICENSE 文件为准。

如果公开发布或二次分发，请同时遵守 PEAK、DG-LAB、BepInEx 及项目所使用第三方依赖的各自许可条款。
