# Coyote WSS Relay Server

> PEAK × DG-LAB / Coyote 公网 WebSocket 中继服务器。

`PEAK_Coyote_Relay` 用于在运行 Coyote 的电脑与 DG-LAB App 之间建立安全的公网 WebSocket 通道。

服务器本身**不负责生成游戏规则，也不负责判断 PEAK 游戏事件**。它的核心职责是连接、转发、设备管理、后台管理、安全限制与运行监控。

> 本项目为第三方社区项目，与 PEAK、DG-LAB 官方无隶属关系。

---

# 1. 项目定位

Coyote 客户端默认支持本地直连。

当电脑和手机无法直接互访时，可以使用公网 WSS Relay：

```text
Coyote Client
     │
     │ WSS / TLS
     ▼
┌─────────────────────┐
│ Coyote Relay Server │
│ Caddy + Bun Relay   │
└─────────────────────┘
     ▲
     │ WSS / TLS
     │
DG-LAB App
```

Relay 负责：

- Coyote Controller 接入
- DG-LAB App 接入
- WebSocket 消息转发
- 多 Controller 管理
- 多 DG-LAB 设备管理
- HTTPS / WSS
- Web 管理后台
- IP 封禁
- 客户端踢下线
- 日志
- 服务器资源监控
- 安全限流
- 数据持久化

---

# 2. 推荐部署结构

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
       │ Docker Internal Network
       ▼
┌─────────────────┐
│ Coyote Relay    │
│ Bun / :9998     │
└────────┬────────┘
         │
         ▼
    Docker Volume
        /data
```

默认情况下：

- 公网开放 `80/443`；
- Caddy 负责 TLS；
- Relay 内部端口默认 `9998`；
- Relay 内部端口不直接暴露公网；
- Caddy 将 HTTPS/WSS 请求反向代理给 Bun Relay。

---

# 3. 多 Controller / 多设备

一个 Relay Server 可以同时承载多个 Coyote Controller。

单个 Controller 下面可以有多个 DG-LAB App / Device。

管理后台使用类似结构：

```text
Controller A
├─ Device 1
├─ Device 2
└─ Device 3

Controller B
├─ Device 1
└─ Device 2
```

设备管理适合多人或多设备场景。

---

# 4. Web 管理后台

浏览器访问：

```text
https://peak.hbsuzh.cn
```

即可进入管理后台。

默认初始账户通常为：

```text
用户名：admin
密码：admin
```

首次部署后应立即修改默认密码。

管理后台可查看：

- Relay 状态
- Controller 数量
- DG-LAB 客户端数量
- 在线 IP 数量
- 已封禁 IP
- Controller → Device 树
- 客户端详细信息
- 游戏状态
- 设备状态
- 客户端日志
- 服务端日志
- CPU
- 内存
- 磁盘
- Relay 运行时间

---

# 5. 设备管理

后台支持：

- Controller 展开 / 收起
- 全部展开
- 全部收起
- 按设备数量排序
- 按最近活动排序
- 按连接时间排序
- 按 IP 搜索
- 按 Controller ID 搜索
- 按客户端 ID 搜索
- 按设备名称搜索
- 按 Slot 搜索
- 踢下线 Controller
- 踢下线单个设备
- IP 封禁

---

# 6. 踢下线与 IP 封禁

## 6.1 踢下线

踢下线是一次性的连接断开。

客户端自身具备重连能力，因此被踢后仍可能重新建立连接。

适合：

- 临时断开
- 清理异常会话
- 调试
- 测试重连

---

## 6.2 IP 封禁

封禁 IP 后：

- 当前连接立即断开；
- 同一 IP 后续连接会被拒绝；
- 管理后台可记录封禁原因；
- 解除封禁后可以重新连接。

IP 封禁只影响对应公网 Relay，不应影响用户本地直连模式。

---

# 7. 客户端隐私

Coyote 客户端可以向 Relay 上传诊断信息。

客户端可本地控制：

```text
禁止上传日志
禁止上传设备信息和游戏信息
```

关闭上传后：

- Relay 基础消息中继仍可正常工作；
- 服务端不应绕过客户端本地隐私设置强制上传。

诊断信息通过现有 WSS/TLS 通道传输。

---

# 8. 日志系统

Relay 主要有两类日志。

## 8.1 服务端日志

可记录：

- Controller 连接 / 断开
- DG-LAB 客户端连接 / 断开
- WebSocket 异常
- IP 封禁 / 解封
- 管理员登录
- 登录失败
- 安全限流
- 管理配置修改
- 服务端错误

---

## 8.2 客户端日志

当客户端允许上传时，可以查看：

- Coyote 连接日志
- 游戏事件
- 规则触发
- 输出记录
- 设备状态
- 其他诊断信息

客户端本地隐私开关优先级高于服务端日志策略。

---

# 9. 服务器资源监控

管理后台可以监控：

- Relay 进程内存
- Heap 使用
- 系统总内存
- 系统可用内存
- CPU 核心数
- Load Average
- Docker / cgroup 内存
- 磁盘总容量
- 磁盘剩余容量
- `/data` 占用
- Relay 运行时间
- 系统运行时间

这些数据可用于快速判断服务器是否存在：

- 内存不足
- CPU 负载异常
- 磁盘空间不足
- 连接数量异常

---

# 10. 安全机制

Relay 内置多项基础安全控制：

- HTTPS
- WSS
- 管理后台认证
- 首次登录修改默认密码
- 密码 Hash 保存
- 登录失败次数限制
- 登录 IP 临时锁定
- 全局登录频率限制
- 管理 API 限流
- 单 IP WebSocket 连接数限制
- WebSocket 握手频率限制
- 单 Controller 附属客户端限制
- 单条消息大小限制
- 单连接消息速率限制
- IP 黑名单
- Session Token
- HttpOnly Cookie
- Secure Cookie
- SameSite Cookie
- CSRF 防护
- CSP
- iframe 防护
- 基础安全响应头

公网生产环境不建议关闭这些安全限制。

---

# 11. 默认限制

默认示例：

```text
最大总连接                  4000
单 IP 最大连接              64
单 Controller 最大客户端    16
单 IP WS 握手 / 分钟        240
单连接消息 / 秒             120
默认单消息最大              256 KiB
```

这些数值可以通过环境变量调整。

生产环境应根据：

- CPU
- 内存
- 带宽
- 用户数量
- App 数量
- 消息频率

进行压力测试后再修改。

---

# 12. 项目目录

典型结构：

```text
PEAK_Coyote_Relay/
├─ Dockerfile
├─ README.md
├─ deploy.sh
├─ deploy.ps1
├─ manage.sh
├─ manage.ps1
├─ compose.auto-tls.yaml
├─ compose.manual-tls.yaml
├─ compose.plain.yaml
└─ server/
   ├─ v4-server.ts
   ├─ admin.html
   ├─ admin.js
   └─ admin.css
```

核心 Relay：

```text
server/v4-server.ts
```

管理后台：

```text
server/admin.html
server/admin.js
server/admin.css
```

---

# 13. 部署要求

推荐：

```text
Linux Server
Docker
Docker Compose
公网 IP
域名（自动 TLS 推荐）
```

也可以在支持 Docker 的 Windows 环境部署。

---

# 14. Linux 快速部署

获取源码：

```bash
git clone https://github.com/sunzhaocn/PEAK_Coyote_Relay.git
cd PEAK_Coyote_Relay
```

赋予脚本执行权限：

```bash
chmod +x deploy.sh
chmod +x manage.sh
```

运行部署：

```bash
./deploy.sh
```

脚本会交互式配置：

- 域名 / IP
- TLS 模式
- 证书
- 公网端口
- Relay 内部端口
- 安全参数
- 防火墙相关设置

---

# 15. Windows 部署

PowerShell 中：

```powershell
git clone https://github.com/sunzhaocn/PEAK_Coyote_Relay.git
cd PEAK_Coyote_Relay
```

执行：

```powershell
.\deploy.ps1
```

如果 PowerShell 阻止脚本执行，可根据本机策略临时调整执行权限。

---

# 16. 自动 TLS 模式

适用于：

- 已有域名；
- 域名已经解析到服务器；
- 服务器可以从公网访问 `80/443`。

推荐结构：

```text
peak.hbsuzh.cn
   ↓
DNS
   ↓
Server
   ↓
Caddy
   ↓
自动申请 / 续期 TLS
   ↓
WSS
```

对应 Compose：

```text
compose.auto-tls.yaml
```

---

# 17. 手动 TLS 模式

如果已有自己的 TLS 证书，可以使用：

```text
compose.manual-tls.yaml
```

推荐证书文件：

```text
fullchain.pem
privkey.pem
```

典型目录：

```text
sites/
└─ peak.hbsuzh.cn/
   └─ certs/
      ├─ fullchain.pem
      └─ privkey.pem
```

---

# 18. Plain 模式

测试环境可以使用：

```text
compose.plain.yaml
```

对应：

```text
http://
ws://
```

仅建议：

- 本地测试
- 私有网络
- 可信内网

公网环境推荐使用：

```text
https://
wss://
```

---

# 19. Docker 直接构建

Relay Dockerfile 基于：

```text
oven/bun:1-alpine
```

基本构建：

```bash
docker build -t coyote-relay .
```

运行示例：

```bash
docker run --rm \
  -p 9998:9998 \
  -e PORT=9998 \
  -e HOST=0.0.0.0 \
  -v coyote-relay-data:/data \
  coyote-relay
```

公网正式部署仍建议使用 Compose + Caddy，而不是直接暴露 Bun 端口。

---

# 20. Docker Compose

自动 TLS：

```bash
docker compose -f compose.auto-tls.yaml up -d --build
```

手动 TLS：

```bash
docker compose -f compose.manual-tls.yaml up -d --build
```

Plain：

```bash
docker compose -f compose.plain.yaml up -d --build
```

---

# 21. 数据持久化

Relay 默认使用：

```text
/data
```

作为持久化数据目录。

Docker Compose 使用 Volume 保存相关数据。

可能包括：

- 管理员账户
- 密码 Hash
- IP 黑名单
- 安全设置
- 客户端历史
- 客户端日志
- 服务端日志

正常重新构建镜像不会自动删除 Volume。

如果手动删除 Volume，则这些数据也会被删除。

---

# 22. 常用管理命令

Linux：

```bash
./manage.sh
```

不带参数时可进入交互管理。

常用命令：

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

# 23. restart 与 reload 的区别

如果只是重启当前已经构建好的容器：

```bash
./manage.sh restart
```

如果修改了：

```text
server/v4-server.ts
server/admin.html
server/admin.js
server/admin.css
Dockerfile
```

则应执行：

```bash
./manage.sh reload
```

因为这些修改需要重新构建 Docker Image。

只执行 `restart` 不会自动把新的源码复制进旧镜像。

---

# 24. 健康检查

部署完成后：

```bash
curl https://peak.hbsuzh.cn/healthz
```

同时可以检查：

```bash
docker ps
```

Relay 容器正常情况下应处于：

```text
healthy
```

状态。

---

# 25. 查看日志

Relay：

```bash
docker logs --tail 200 <relay-container>
```

Caddy：

```bash
docker logs --tail 200 <caddy-container>
```

也可以使用：

```bash
./manage.sh relay-logs
./manage.sh caddy-logs
```

---

# 26. 一键诊断

```bash
./manage.sh doctor
```

可用于检查常见部署问题。

---

# 27. Docker 开机自启

Compose 推荐：

```yaml
restart: unless-stopped
```

同时确保 Docker 服务开机启动：

```bash
systemctl enable docker
systemctl is-enabled docker
```

---

# 28. Coyote 客户端连接自建 Relay

部署完成并确认：

```text
https://peak.hbsuzh.cn
```

以及：

```text
wss://peak.hbsuzh.cn
```

可正常访问后，在 Coyote 客户端选择：

```text
自定义中继
```

填写：

```text
wss://peak.hbsuzh.cn
```

应用配置后，再让 DG-LAB App 使用 Coyote 生成的对应配对地址连接。

---

# 29. 官方中继与自建中继

客户端可根据实际情况选择：

```text
直连
官方 WSS 中继
自定义 WSS 中继
```

推荐：

### 同一网络

```text
直连
```

### 异地、NAT、复杂网络

```text
官方 WSS 中继
```

### 自己维护服务器

```text
自定义 WSS 中继
```

---

# 30. 生产环境建议

正式公网 Relay 建议：

- 使用独立域名；
- 开启 HTTPS/WSS；
- 首次登录立即修改管理员密码；
- 不直接暴露 Relay 内部端口；
- 保留连接数与消息频率限制；
- 定期查看日志；
- 定期备份配置和 `/data`；
- 定期更新 Docker / Caddy / Bun 基础镜像；
- 根据实际并发进行压力测试；
- 配置服务器防火墙；
- 只开放必要端口。

---

# 31. 故障排查

## 域名无法访问

检查：

```bash
nslookup peak.hbsuzh.cn
```

确认域名解析到正确公网 IP。

---

## HTTPS 无法申请证书

检查：

- 80/443 是否开放；
- DNS 是否生效；
- 云服务安全组；
- 本机防火墙；
- Caddy 日志。

---

## Relay 无法启动

检查：

```bash
docker ps -a
docker compose logs
```

以及：

```bash
./manage.sh doctor
```

---

## 客户端无法连接 WSS

检查：

1. `https://peak.hbsuzh.cn` 是否可访问；
2. `/healthz` 是否正常；
3. TLS 证书是否有效；
4. 地址是否使用 `wss://`；
5. 防火墙是否放行；
6. Relay 是否触发 IP 封禁或限流。

---

## 修改源码后页面没有变化

不要只执行：

```bash
./manage.sh restart
```

应执行：

```bash
./manage.sh reload
```

重新 Build。

---

# 32. 推荐拓扑

```text
                 Internet
                    │
               HTTPS / WSS
                    │
                    ▼
             ┌────────────┐
             │   Caddy    │
             └─────┬──────┘
                   │
          Docker Internal
                   │
                   ▼
          ┌────────────────┐
          │ Coyote Relay   │
          │ Bun / :9998    │
          └───────┬────────┘
                  │
          ┌───────┴────────┐
          │                │
          ▼                ▼
   Controller A      Controller B
      │   │             │
      ▼   ▼             ▼
    App1 App2          App3
```

---

# 33. 相关项目

Coyote PEAK 客户端：

```text
https://github.com/sunzhaocn/PEAK-DG-LAB-Integration
```

---

## License

请以仓库当前 `LICENSE` 文件为准。
