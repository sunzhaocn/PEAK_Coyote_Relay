import type { Server, ServerWebSocket } from 'bun';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { cpus, freemem, loadavg, totalmem, uptime as osUptime } from 'node:os';

const PORT = numberFromEnv('PORT', 9998);
const HOST = stringFromEnv('HOST', '0.0.0.0');
const HEARTBEAT_MS = numberFromEnv('HEARTBEAT_INTERVAL', 30_000);
const WS_PING_MS = numberFromEnv('WS_PING_INTERVAL', 10_000);
const MAX_MISSED_WS_PONGS = numberFromEnv('MAX_MISSED_WS_PONGS', 3);
const IDLE_TIMEOUT_MS = numberFromEnv('IDLE_TIMEOUT', 5 * 60_000);
const PREFIX = prefixFromEnv('PREFIX', '/');
const MAX_CONNECTIONS = numberFromEnv('MAX_CONNECTIONS', 4000);
const MAX_CONNECTIONS_PER_IP = numberFromEnv('MAX_CONNECTIONS_PER_IP', 64);
const MAX_CLIENTS_PER_CONTROLLER = numberFromEnv('MAX_CLIENTS_PER_CONTROLLER', 16);
const MAX_MESSAGE_BYTES = Math.max(256 * 1024, numberFromEnv('MAX_MESSAGE_BYTES', 256 * 1024));
const HARD_MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_MESSAGES_PER_SECOND = numberFromEnv('MAX_MESSAGES_PER_SECOND', 120);
const MAX_WS_HANDSHAKES_PER_MINUTE = numberFromEnv('MAX_WS_HANDSHAKES_PER_MINUTE', 240);
const CLIENT_ID_BYTES = 16;

const DATA_DIR = stringFromEnv('DATA_DIR', '/data');
const SECURITY_FILE = `${DATA_DIR}/security.json`;
const SERVER_LOG_FILE = `${DATA_DIR}/server.log`;
const CLIENT_LOG_DIR = `${DATA_DIR}/client-logs`;
const CLIENT_META_FILE = `${DATA_DIR}/client-meta.json`;
const MAX_SERVER_LOG_RING = 1500;
const MAX_CLIENT_LOG_FILE_BYTES = 20 * 1024 * 1024;
const ADMIN_USER_DEFAULT = stringFromEnv('ADMIN_USER', 'admin');
const ADMIN_PASSWORD_DEFAULT = Bun.env.ADMIN_INITIAL_PASSWORD || 'admin';
const ADMIN_SESSION_MS = numberFromEnv('ADMIN_SESSION_HOURS', 8) * 60 * 60_000;
const ADMIN_LOGIN_WINDOW_MS = numberFromEnv('ADMIN_LOGIN_WINDOW_MS', 10 * 60_000);
const ADMIN_LOGIN_MAX_ATTEMPTS = numberFromEnv('ADMIN_LOGIN_MAX_ATTEMPTS', 5);
const ADMIN_LOGIN_LOCKOUT_MS = numberFromEnv('ADMIN_LOGIN_LOCKOUT_MS', 15 * 60_000);
const ADMIN_API_MAX_PER_MINUTE = numberFromEnv('ADMIN_API_MAX_PER_MINUTE', 180);
const ADMIN_GLOBAL_LOGIN_MAX_PER_MINUTE = numberFromEnv('ADMIN_GLOBAL_LOGIN_MAX_PER_MINUTE', 60);
const ADMIN_ALLOW_INSECURE_HTTP = boolFromEnv('ADMIN_ALLOW_INSECURE_HTTP', false);
const ADMIN_COOKIE = 'coyote_admin_session';
const ADMIN_PREFIX = '/admin';
const ADMIN_MAX_BODY_BYTES = 16 * 1024;
const RESET_ADMIN_MODE = Bun.argv.includes('--reset-admin');

const CLOSE_CONTROLLER_DISCONNECTED = 4000;
const CLOSE_CONTROLLER_NOT_FOUND = 4001;
const CLOSE_IDLE_TIMEOUT = 4002;
const CLOSE_CONTROLLER_FULL = 4003;
const CLOSE_BLOCKED = 4009;
const CLOSE_RATE_LIMIT = 4008;
const CLOSE_TOO_LARGE = 1009;

interface WSData { tid?: string; remoteIp?: string; userAgent?: string; }
type JsonObject = Record<string, unknown>;
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
interface MessageFrame { type: 'message'; clientId?: string; data?: unknown; }
interface RateState { start: number; count: number; }
interface ConnectionMeta {
  clientId: string;
  role: 'controller' | 'client';
  remoteIp: string;
  controllerId?: string;
  connectedAt: number;
  lastSeenAt: number;
  messagesIn: number;
  userAgent: string;
  deviceName?: string;
  deviceType?: string;
  slotId?: string;
}
interface BlockedIpRecord { ip: string; reason: string; createdAt: string; }
interface RuntimeSettings {
  maxConnections: number;
  maxConnectionsPerIp: number;
  maxClientsPerController: number;
  maxMessageBytes: number;
  maxMessagesPerSecond: number;
  maxWsHandshakesPerMinute: number;
  adminApiMaxPerMinute: number;
  adminGlobalLoginMaxPerMinute: number;
  adminLoginWindowSeconds: number;
  adminLoginMaxAttempts: number;
  adminLoginLockoutSeconds: number;
  idleControllerSeconds: number;
  logMode: 'off' | 'realtime' | 'interval';
  logIntervalSeconds: number;
  stateIntervalSeconds: number;
  blockRecheckSeconds: number;
  clientLogRetentionLines: number;
}
interface ClientReportRecord {
  instanceId: string;
  controllerId: string;
  remoteIp: string;
  connected: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  client: JsonObject;
  privacy: JsonObject;
  peak: JsonObject;
  dg: JsonObject;
  multiplayer: JsonObject;
  peakTimestamp: number;
  lastStateAt: number;
  lastLogAt: number;
  logCount: number;
}
interface ServerLogEntry { time: string; level: LogLevel; message: string; }
interface SecurityState {
  version: number;
  admin: {
    username: string;
    passwordHash: string;
    forcePasswordChange: boolean;
    updatedAt: string;
  };
  blockedIps: BlockedIpRecord[];
  runtime?: RuntimeSettings;
}
interface AdminSession {
  token: string;
  csrf: string;
  username: string;
  ip: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}
interface LoginRateState { windowStart: number; attempts: number; lockedUntil: number; }
interface MinuteRateState { windowStart: number; count: number; }
interface SecurityEvent { time: string; type: string; ip: string; detail: string; }

function safeCloseReason(value: unknown, maxBytes = 100): string {
  const text = String(value ?? '');
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  let out = '';
  for (const ch of text) {
    if (encoder.encode(out + ch).byteLength > maxBytes) break;
    out += ch;
  }
  return out;
}

const ACTIVE_LOG_LEVEL = logLevelFromEnv();
const LOG_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const serverLogRing: ServerLogEntry[] = [];
const log = (level: LogLevel, message: string): void => {
  if (LOG_WEIGHT[level] < LOG_WEIGHT[ACTIVE_LOG_LEVEL]) return;
  const entry: ServerLogEntry = { time: new Date().toISOString(), level, message: message.slice(0, 2000) };
  serverLogRing.push(entry);
  if (serverLogRing.length > MAX_SERVER_LOG_RING) serverLogRing.splice(0, serverLogRing.length - MAX_SERVER_LOG_RING);
  try { appendFileSync(SERVER_LOG_FILE, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 }); } catch {}
  const line = `[V4] ${message}`;
  if (level === 'debug') return console.debug(line);
  if (level === 'warn') return console.warn(line);
  if (level === 'error') return console.error(line);
  console.log(line);
};

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(CLIENT_LOG_DIR, { recursive: true });
let security = await loadSecurityState();
let runtimeSettings = normalizeRuntimeSettings(security.runtime);
security.runtime = runtimeSettings;
persistSecurityState();
const dummyPasswordHash = await Bun.password.hash('coyote-admin-dummy-password-never-valid');
const sessions = new Map<string, AdminSession>();
const loginRates = new Map<string, LoginRateState>();
const adminApiRates = new Map<string, MinuteRateState>();
const wsHandshakeRates = new Map<string, MinuteRateState>();
let globalLoginRate: MinuteRateState = { windowStart: Date.now(), count: 0 };
const securityEvents: SecurityEvent[] = [];

// Monotonic in-process revision for IP block-list changes.  Banned clients may
// long-poll /relay-status over HTTPS; changing the list wakes them immediately
// without exposing another port or using plaintext UDP.
let blocklistRevision = 1;
const blocklistWaiters = new Set<() => void>();

function bumpBlocklistRevision(): void {
  blocklistRevision = blocklistRevision >= Number.MAX_SAFE_INTEGER - 1 ? 1 : blocklistRevision + 1;
  const waiters = [...blocklistWaiters];
  blocklistWaiters.clear();
  for (const wake of waiters) {
    try { wake(); } catch {}
  }
}

function waitForBlocklistChange(since: number, timeoutMs: number): Promise<void> {
  if (since !== blocklistRevision) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const wake = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      blocklistWaiters.delete(wake);
      resolve();
    };
    timer = setTimeout(wake, Math.max(250, Math.min(timeoutMs, 30_000)));
    blocklistWaiters.add(wake);
    // Close the tiny race between the initial comparison and waiter insertion.
    if (since !== blocklistRevision) wake();
  });
}

if (RESET_ADMIN_MODE) {
  security.admin = {
    username: 'admin',
    passwordHash: await Bun.password.hash('admin'),
    forcePasswordChange: true,
    updatedAt: new Date().toISOString(),
  };
  persistSecurityState();
  console.log('[V4] 管理员已重置为 admin / admin；下次登录必须修改密码。');
  process.exit(0);
}

class RelayServer {
  readonly port: number;
  private sockets = new Set<ServerWebSocket<WSData>>();
  private wsToClientId = new Map<ServerWebSocket<WSData>, string>();
  private clientIdToWs = new Map<string, ServerWebSocket<WSData>>();
  private controllersById = new Map<string, ServerWebSocket<WSData>>();
  private controlledClients = new Map<ServerWebSocket<WSData>, Map<string, ServerWebSocket<WSData>>>();
  private clientToController = new Map<ServerWebSocket<WSData>, ServerWebSocket<WSData>>();
  private idleTimers = new Map<ServerWebSocket<WSData>, Timer>();
  private missedWsPongs = new Map<ServerWebSocket<WSData>, number>();
  private rateStates = new Map<ServerWebSocket<WSData>, RateState>();
  private ipBySocket = new Map<ServerWebSocket<WSData>, string>();
  private connectionsByIp = new Map<string, number>();
  private metaBySocket = new Map<ServerWebSocket<WSData>, ConnectionMeta>();
  private reportsByController = new Map<string, ClientReportRecord>();
  private reportsByInstance = new Map<string, ClientReportRecord>();
  private heartbeatTimer?: Timer;
  private wsPingTimer?: Timer;

  constructor(port = PORT) {
    this.port = port;
    // V2.6.4: the admin client/device views are strictly online-only.
    // Do not restore historical client snapshots after a relay restart.
    // Keep uploaded log files and the server audit log on disk, but clear
    // stale realtime metadata so an offline IP never remains in the dashboard.
    persistClientMeta(this.reportsByInstance);
  }
  connectionCount(): number { return this.sockets.size; }
  controllerCount(): number { return this.controllersById.size; }
  clientCount(): number { return Math.max(0, this.sockets.size - this.controllersById.size); }
  canAccept(): boolean { return this.sockets.size < runtimeSettings.maxConnections; }
  canAcceptIp(ip: string): boolean {
    if (!ip) return true;
    return (this.connectionsByIp.get(ip) ?? 0) < runtimeSettings.maxConnectionsPerIp;
  }

  stats(): JsonObject {
    return {
      ok: true,
      service: 'coyote-dglab-relay',
      version: '2.6.5',
      connections: this.connectionCount(),
      controllers: this.controllerCount(),
      controlledClients: this.clientCount(),
      distinctIps: this.connectionsByIp.size,
      blockedIps: security.blockedIps.length,
      maxConnections: runtimeSettings.maxConnections,
      maxConnectionsPerIp: runtimeSettings.maxConnectionsPerIp,
      maxWsHandshakesPerMinute: runtimeSettings.maxWsHandshakesPerMinute,
      time: new Date().toISOString(),
    };
  }

  connectionSnapshots(): JsonObject[] {
    const result: JsonObject[] = [];
    for (const [ws, meta] of this.metaBySocket) {
      const controllerWs = meta.role === 'client' ? this.clientToController.get(ws) : undefined;
      const controllerId = controllerWs ? this.wsToClientId.get(controllerWs) : meta.controllerId;
      result.push({
        id: meta.clientId,
        role: meta.role,
        ip: meta.remoteIp || '-',
        controllerId: controllerId || null,
        connectedAt: new Date(meta.connectedAt).toISOString(),
        lastSeenAt: new Date(meta.lastSeenAt).toISOString(),
        messagesIn: meta.messagesIn,
        userAgent: meta.userAgent || '-',
        deviceName: meta.deviceName || null,
        deviceType: meta.deviceType || null,
        slotId: meta.slotId || null,
      });
    }
    result.sort((a, b) => String(a.connectedAt).localeCompare(String(b.connectedAt)));
    return result;
  }

  clientReportSummaries(): JsonObject[] {
    const now = Date.now();
    return [...this.reportsByInstance.values()]
      .filter(record => record.connected === true && !!record.controllerId && this.controllersById.has(record.controllerId))
      .map(record => ({
        instanceId: record.instanceId,
        controllerId: record.controllerId || null,
        ip: record.remoteIp || '-',
        connected: record.connected,
        firstSeenAt: new Date(record.firstSeenAt).toISOString(),
        lastSeenAt: new Date(record.lastSeenAt).toISOString(),
        lastStateAt: record.lastStateAt ? new Date(record.lastStateAt).toISOString() : null,
        lastLogAt: record.lastLogAt ? new Date(record.lastLogAt).toISOString() : null,
        logCount: record.logCount,
        client: record.client,
        privacy: record.privacy,
        logUploadDisabled: record.privacy.logUploadDisabled === true,
        stateUploadDisabled: record.privacy.stateUploadDisabled === true,
        deviceCount: countReportedDevices(record),
        gameOnline: !!record.peakTimestamp && now - record.peakTimestamp * 1000 < 10_000,
        scene: typeof record.peak.scene === 'string' ? record.peak.scene : null,
        stageNumber: typeof record.peak.stageNumber === 'number' ? record.peak.stageNumber : null,
        stageName: typeof record.peak.stageName === 'string' ? record.peak.stageName : null,
        stageDisplay: typeof record.peak.stageDisplay === 'string' ? record.peak.stageDisplay : null,
        biome: typeof record.peak.biome === 'string' ? record.peak.biome : null,
        hp: typeof record.peak.hp === 'number' ? record.peak.hp : null,
      }))
      .sort((a, b) => Number(b.connected) - Number(a.connected) || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
  }

  clientReportDetail(id: string): JsonObject | null {
    const record = this.reportsByInstance.get(id) || this.reportsByController.get(id);
    if (!record || record.connected !== true || !record.controllerId || !this.controllersById.has(record.controllerId)) return null;
    return {
      instanceId: record.instanceId, controllerId: record.controllerId || null, ip: record.remoteIp || '-',
      connected: record.connected, firstSeenAt: new Date(record.firstSeenAt).toISOString(),
      lastSeenAt: new Date(record.lastSeenAt).toISOString(), client: record.client, privacy: record.privacy,
      peakTimestamp: record.peakTimestamp, peak: record.peak, dg: record.dg, multiplayer: record.multiplayer,
      lastStateAt: record.lastStateAt ? new Date(record.lastStateAt).toISOString() : null,
      lastLogAt: record.lastLogAt ? new Date(record.lastLogAt).toISOString() : null, logCount: record.logCount,
    };
  }

  broadcastPolicy(): void {
    for (const ws of this.controllersById.values()) this.sendPolicy(ws);
  }

  private sendPolicy(ws: ServerWebSocket<WSData>): void {
    this.sendFrame(ws, { type: 'coyote.policy', policy: reportingPolicy() });
  }

  private handleCoyotePrivate(ws: ServerWebSocket<WSData>, parsed: unknown): boolean {
    if (!isJsonObject(parsed)) return false;
    const type = parsed.type;
    if (type !== 'coyote.control' && type !== 'coyote.report') return false;

    const controllerId = this.wsToClientId.get(ws) || '';
    if (!controllerId || !this.controllersById.has(controllerId)) return true;
    const meta = this.metaBySocket.get(ws);
    if (!meta) return true;

    if (type === 'coyote.control') {
      const op = typeof parsed.op === 'string' ? parsed.op : '';
      if (op === 'hello') {
        const instanceId = sanitizeInstanceId(parsed.clientInstanceId);
        if (!instanceId) return true;
        const existing = this.reportsByInstance.get(instanceId);
        const now = Date.now();
        const record: ClientReportRecord = existing || {
          instanceId, controllerId, remoteIp: meta.remoteIp, connected: true, firstSeenAt: now, lastSeenAt: now,
          client: {}, privacy: {}, peak: {}, dg: {}, multiplayer: {}, peakTimestamp: 0, lastStateAt: 0, lastLogAt: 0, logCount: 0,
        };
        if (record.controllerId && record.controllerId !== controllerId) this.reportsByController.delete(record.controllerId);
        record.controllerId = controllerId; record.remoteIp = meta.remoteIp; record.connected = true; record.lastSeenAt = now;
        record.client = sanitizeObject(parsed.client, 40, 500);
        record.privacy = sanitizeObject(parsed.privacy, 20, 200);
        this.reportsByInstance.set(instanceId, record);
        this.reportsByController.set(controllerId, record);
        persistClientMeta(this.reportsByInstance);
        this.sendPolicy(ws);
        log('info', `Coyote客户端注册 instance=${instanceId} controller=${controllerId} ip=${meta.remoteIp || '-'}`);
        return true;
      }
      if (op === 'privacy') {
        const instanceId = sanitizeInstanceId(parsed.clientInstanceId);
        const record = this.reportsByInstance.get(instanceId) || this.reportsByController.get(controllerId);
        if (record) { record.privacy = sanitizeObject(parsed.privacy, 20, 200); record.lastSeenAt = Date.now(); }
        return true;
      }
      return true;
    }

    const instanceId = sanitizeInstanceId(parsed.clientInstanceId);
    const record = this.reportsByInstance.get(instanceId) || this.reportsByController.get(controllerId);
    if (!record) { this.sendPolicy(ws); return true; }
    record.lastSeenAt = Date.now();
    record.remoteIp = meta.remoteIp; record.controllerId = controllerId; record.connected = true;
    record.privacy = sanitizeObject(parsed.privacy, 20, 200);
    const kind = typeof parsed.kind === 'string' ? parsed.kind : '';
    if (kind === 'state') {
      if (record.privacy.stateUploadDisabled === true) return true;
      record.peak = sanitizeObject(parsed.peak, 2000, 20_000);
      record.dg = sanitizeObject(parsed.dg, 200, 3000);
      record.multiplayer = sanitizeObject(parsed.multiplayer, 3000, 30_000);
      record.peakTimestamp = finiteNumber(parsed.peakTimestamp, 0);
      record.lastStateAt = Date.now();
      return true;
    }
    if (kind === 'logs') {
      if (record.privacy.logUploadDisabled === true) return true;
      const rawLogs = Array.isArray(parsed.logs) ? parsed.logs.slice(-100) : [];
      const logs = rawLogs.map(sanitizeClientLog).filter(Boolean) as JsonObject[];
      if (logs.length) {
        persistClientLogs(record.instanceId, logs);
        record.logCount += logs.length;
        record.lastLogAt = Date.now();
      }
      return true;
    }
    return true;
  }

  kickClient(clientId: string, reason = '管理员踢下线'): boolean {
    const ws = this.clientIdToWs.get(clientId);
    if (!ws) return false;
    if (this.controllersById.has(clientId)) this.sendFrame(ws, { type: 'coyote.notice', event: 'kicked', reason: reason.slice(0, 240) });
    ws.close(4007, safeCloseReason(reason));
    return true;
  }

  kickIp(ip: string, reason = '管理员封禁 IP'): number {
    let count = 0;
    for (const ws of [...this.sockets]) {
      if ((this.ipBySocket.get(ws) ?? '') === ip) {
        count += 1;
        const id = this.wsToClientId.get(ws) || '';
        if (this.controllersById.has(id)) this.sendFrame(ws, { type: 'coyote.notice', event: 'blocked', reason: reason.slice(0, 240) });
        ws.close(CLOSE_BLOCKED, safeCloseReason(reason));
      }
    }
    return count;
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.broadcastHeartbeat(), HEARTBEAT_MS);
  }

  startWsPing(): void {
    if (this.wsPingTimer) return;
    this.wsPingTimer = setInterval(() => this.pingConnections(), WS_PING_MS);
  }

  sendFrame(ws: ServerWebSocket<WSData>, payload: JsonObject): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  private broadcastHeartbeat(): void {
    const payload = JSON.stringify({ type: 'heartbeat' });
    for (const ws of this.sockets) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }

  private pingConnections(): void {
    for (const ws of this.sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const missed = this.missedWsPongs.get(ws) ?? 0;
      if (missed >= MAX_MISSED_WS_PONGS) {
        log('warn', `WS探活超时 连接=${this.clientIdOf(ws)} 未响应=${missed}`);
        ws.terminate();
        continue;
      }
      this.missedWsPongs.set(ws, missed + 1);
      ws.ping();
    }
  }

  private clientIdOf(ws: ServerWebSocket<WSData>): string {
    return this.wsToClientId.get(ws) ?? '-';
  }

  private permitMessage(ws: ServerWebSocket<WSData>): boolean {
    const now = Date.now();
    const state = this.rateStates.get(ws);
    if (!state || now - state.start >= 1000) {
      this.rateStates.set(ws, { start: now, count: 1 });
      return true;
    }
    state.count += 1;
    if (state.count <= runtimeSettings.maxMessagesPerSecond) return true;
    log('warn', `速率超限 连接=${this.clientIdOf(ws)} count=${state.count}`);
    ws.close(CLOSE_RATE_LIMIT, 'rate_limit');
    return false;
  }

  onOpen(ws: ServerWebSocket<WSData>): void {
    const remoteIp = ws.data.remoteIp?.trim() || '';
    if (isBlockedIp(remoteIp)) {
      ws.close(CLOSE_BLOCKED, 'blocked_ip');
      return;
    }
    if (!this.canAccept()) {
      ws.close(1013, 'server_busy');
      return;
    }
    if (!this.canAcceptIp(remoteIp)) {
      ws.close(1013, 'ip_connection_limit');
      return;
    }

    const clientId = this.createClientId();
    const now = Date.now();
    this.sockets.add(ws);
    if (remoteIp) {
      this.ipBySocket.set(ws, remoteIp);
      this.connectionsByIp.set(remoteIp, (this.connectionsByIp.get(remoteIp) ?? 0) + 1);
    }
    this.wsToClientId.set(ws, clientId);
    this.clientIdToWs.set(clientId, ws);
    this.missedWsPongs.set(ws, 0);
    this.rateStates.set(ws, { start: now, count: 0 });
    this.metaBySocket.set(ws, {
      clientId,
      role: ws.data.tid ? 'client' : 'controller',
      remoteIp,
      controllerId: ws.data.tid,
      connectedAt: now,
      lastSeenAt: now,
      messagesIn: 0,
      userAgent: ws.data.userAgent || '',
    });

    this.sendFrame(ws, { type: 'hello', clientId });
    if (ws.data.tid) this.attachClient(ws, clientId, ws.data.tid);
    else this.attachController(ws, clientId);
  }

  onMessage(ws: ServerWebSocket<WSData>, message: string | Buffer<ArrayBuffer>) {
    const meta = this.metaBySocket.get(ws);
    if (meta) {
      meta.lastSeenAt = Date.now();
      meta.messagesIn += 1;
    }
    const byteLength = typeof message === 'string' ? Buffer.byteLength(message, 'utf8') : message.byteLength;
    if (!this.permitMessage(ws)) return;

    let parsed: unknown;
    try { parsed = JSON.parse(message.toString()); }
    catch { log('warn', `WS JSON无效 连接=${this.clientIdOf(ws)}`); return; }

    const isPrivateDiagnostic = isJsonObject(parsed) && (parsed.type === 'coyote.control' || parsed.type === 'coyote.report');
    if (byteLength > runtimeSettings.maxMessageBytes) {
      log('warn', `${isPrivateDiagnostic ? '诊断消息' : '消息'}过大 连接=${this.clientIdOf(ws)} bytes=${byteLength}`);
      // Diagnostics are optional. Reject an oversized diagnostic frame without breaking
      // the core DG-LAB relay connection. Ordinary relay traffic still closes normally.
      if (isPrivateDiagnostic) {
        this.sendFrame(ws, { type: 'coyote.notice', event: 'diagnostic_rejected', reason: `诊断帧超过服务器限制 ${runtimeSettings.maxMessageBytes} bytes` });
        return;
      }
      ws.close(CLOSE_TOO_LARGE, 'message_too_large');
      return;
    }

    if (this.handlePingMessage(ws, parsed)) return;
    if (this.handleCoyotePrivate(ws, parsed)) return;
    if (!isMessageFrame(parsed)) return;

    const msg = parsed;
    const clientId = this.wsToClientId.get(ws);
    if (!clientId) return;

    if (this.controllersById.has(clientId)) {
      if (typeof msg.clientId !== 'string') {
        this.sendFrame(ws, { type: 'error', code: 'bad_request', message: 'message.clientId is required' });
        return;
      }
      const clientWs = this.controlledClients.get(ws)?.get(msg.clientId);
      if (clientWs?.readyState === WebSocket.OPEN) {
        this.sendFrame(clientWs, { type: 'message', data: msg.data });
      } else {
        this.sendFrame(ws, { type: 'error', code: 'client_not_found', clientId: msg.clientId });
      }
      return;
    }

    this.updateDeviceInfo(ws, msg.data);
    const controllerWs = this.clientToController.get(ws);
    if (controllerWs?.readyState === WebSocket.OPEN) {
      this.sendFrame(controllerWs, { type: 'message', clientId, data: msg.data });
    }
  }

  onPong(ws: ServerWebSocket<WSData>): void {
    this.missedWsPongs.set(ws, 0);
    const meta = this.metaBySocket.get(ws);
    if (meta) meta.lastSeenAt = Date.now();
  }

  private purgeRealtimeReportsForIp(remoteIp: string): void {
    if (!remoteIp) return;
    let changed = false;
    for (const [instanceId, report] of [...this.reportsByInstance.entries()]) {
      if (report.remoteIp !== remoteIp) continue;
      if (report.controllerId) this.reportsByController.delete(report.controllerId);
      this.reportsByInstance.delete(instanceId);
      changed = true;
    }
    if (changed) {
      persistClientMeta(this.reportsByInstance);
      log('info', `IP已完全离线，清除实时客户端快照 ip=${remoteIp}`);
    }
  }

  onClose(ws: ServerWebSocket<WSData>, code: number, reason: string): void {
    this.sockets.delete(ws);
    this.missedWsPongs.delete(ws);
    this.rateStates.delete(ws);
    this.metaBySocket.delete(ws);
    const remoteIp = this.ipBySocket.get(ws) ?? '';
    this.ipBySocket.delete(ws);
    let ipWentOffline = false;
    if (remoteIp) {
      const left = Math.max(0, (this.connectionsByIp.get(remoteIp) ?? 1) - 1);
      if (left === 0) {
        this.connectionsByIp.delete(remoteIp);
        ipWentOffline = true;
      } else {
        this.connectionsByIp.set(remoteIp, left);
      }
    }
    const clientId = this.wsToClientId.get(ws);
    this.wsToClientId.delete(ws);
    if (clientId) this.clientIdToWs.delete(clientId);
    if (!clientId) {
      if (ipWentOffline) this.purgeRealtimeReportsForIp(remoteIp);
      return;
    }

    if (this.controllersById.has(clientId)) {
      this.controllersById.delete(clientId);
      const report = this.reportsByController.get(clientId);
      if (report) {
        // Online-only policy: once the controller is gone, immediately remove
        // its game/device/privacy/client snapshot from memory and metadata.
        // Historical JSONL logs remain available as audit material.
        report.connected = false;
        report.lastSeenAt = Date.now();
        this.reportsByController.delete(clientId);
        this.reportsByInstance.delete(report.instanceId);
        persistClientMeta(this.reportsByInstance);
      }
      const clients = this.controlledClients.get(ws);
      this.controlledClients.delete(ws);
      this.cancelIdleTimer(ws);
      if (clients) {
        for (const [cId, cWs] of clients) {
          this.clientToController.delete(cWs);
          this.sendFrame(cWs, { type: 'controller_disconnected', clientId });
          cWs.close(CLOSE_CONTROLLER_DISCONNECTED, 'controller_disconnected');
          log('info', `踢出被控方 被控方=${cId} 控制方=${clientId}`);
        }
      }
      if (ipWentOffline) this.purgeRealtimeReportsForIp(remoteIp);
      log('info', `控制方断开 控制方=${clientId} ip=${remoteIp || '-'} code=${code} reason=${reason || '-'}`);
      return;
    }

    const controllerWs = this.clientToController.get(ws);
    if (controllerWs) {
      this.clientToController.delete(ws);
      const clients = this.controlledClients.get(controllerWs);
      clients?.delete(clientId);
      if (controllerWs.readyState === WebSocket.OPEN) {
        this.sendFrame(controllerWs, { type: 'client_disconnected', clientId });
        if (!clients || clients.size === 0) this.startIdleTimer(controllerWs);
      }
    }
    if (ipWentOffline) this.purgeRealtimeReportsForIp(remoteIp);
  }

  private updateDeviceInfo(ws: ServerWebSocket<WSData>, data: unknown): void {
    if (!isJsonObject(data)) return;
    const meta = this.metaBySocket.get(ws);
    if (!meta || meta.role !== 'client') return;
    const controllerWs = this.clientToController.get(ws);
    const controllerId = controllerWs ? (this.wsToClientId.get(controllerWs) || '') : '';
    const report = controllerId ? this.reportsByController.get(controllerId) : undefined;
    // The relay must transiently forward protocol payloads, but when the Coyote user
    // disables state/device reporting we do not retain device metadata for the admin UI.
    if (report?.privacy?.stateUploadDisabled === true) {
      meta.deviceName = undefined; meta.deviceType = undefined; meta.slotId = undefined;
      return;
    }
    if (data.ev !== 'devices.snapshot' || !Array.isArray(data.devices) || data.devices.length === 0) return;
    const device = data.devices[0];
    if (!isJsonObject(device)) return;
    if (typeof device.name === 'string') meta.deviceName = device.name.slice(0, 120);
    if (typeof device.type === 'string') meta.deviceType = device.type.slice(0, 80);
    if (typeof device.slotId === 'string' || typeof device.slotId === 'number') meta.slotId = String(device.slotId).slice(0, 80);
  }

  private handlePingMessage(ws: ServerWebSocket<WSData>, message: unknown): boolean {
    if (!isJsonObject(message)) return false;
    if (message.type === 'pong') return true;
    if (message.type !== 'ping') return false;
    this.sendFrame(ws, { type: 'pong', ts: Date.now() });
    return true;
  }

  private createClientId(): string {
    let clientId: string;
    do { clientId = randomHex(CLIENT_ID_BYTES); }
    while (this.clientIdToWs.has(clientId));
    return clientId;
  }

  private attachController(ws: ServerWebSocket<WSData>, clientId: string) {
    this.controllersById.set(clientId, ws);
    this.controlledClients.set(ws, new Map());
    this.startIdleTimer(ws);
    log('info', `控制方连接 控制方=${clientId} ip=${this.ipBySocket.get(ws) || '-'}`);
  }

  private attachClient(ws: ServerWebSocket<WSData>, clientId: string, tid: string) {
    const controllerWs = this.controllersById.get(tid);
    if (!controllerWs || controllerWs.readyState !== WebSocket.OPEN) {
      this.sendFrame(ws, { type: 'error', code: 'controller_not_found' });
      ws.close(CLOSE_CONTROLLER_NOT_FOUND, 'controller_not_found');
      return;
    }
    const clients = this.controlledClients.get(controllerWs);
    if (!clients) {
      this.sendFrame(ws, { type: 'error', code: 'controller_not_found' });
      ws.close(CLOSE_CONTROLLER_NOT_FOUND, 'controller_not_found');
      return;
    }
    if (clients.size >= runtimeSettings.maxClientsPerController) {
      this.sendFrame(ws, { type: 'error', code: 'controller_full' });
      ws.close(CLOSE_CONTROLLER_FULL, 'controller_full');
      return;
    }
    clients.set(clientId, ws);
    this.clientToController.set(ws, controllerWs);
    this.cancelIdleTimer(controllerWs);
    this.sendFrame(ws, { type: 'controller_attached', clientId: tid });
    this.sendFrame(controllerWs, { type: 'client_attached', clientId });
    log('info', `被控方接入 被控方=${clientId} 控制方=${tid} ip=${this.ipBySocket.get(ws) || '-'} 总数=${clients.size}`);
  }

  private startIdleTimer(controllerWs: ServerWebSocket<WSData>) {
    this.cancelIdleTimer(controllerWs);
    const clientId = this.wsToClientId.get(controllerWs);
    const timer = setTimeout(() => {
      this.idleTimers.delete(controllerWs);
      if (controllerWs.readyState === WebSocket.OPEN) {
        this.sendFrame(controllerWs, { type: 'idle_timeout' });
        controllerWs.close(CLOSE_IDLE_TIMEOUT, 'idle_timeout');
        log('info', `控制方空闲回收 控制方=${clientId ?? '-'}`);
      }
    }, runtimeSettings.idleControllerSeconds * 1000);
    this.idleTimers.set(controllerWs, timer);
  }

  private cancelIdleTimer(controllerWs: ServerWebSocket<WSData>) {
    const timer = this.idleTimers.get(controllerWs);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(controllerWs);
  }
}


function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function normalizeRuntimeSettings(raw: unknown): RuntimeSettings {
  const value = isJsonObject(raw) ? raw : {};
  const logModeRaw = typeof value.logMode === 'string' ? value.logMode.toLowerCase() : 'interval';
  const logMode: RuntimeSettings['logMode'] = logModeRaw === 'off' || logModeRaw === 'realtime' ? logModeRaw : 'interval';
  return {
    maxConnections: clampInteger(value.maxConnections, MAX_CONNECTIONS, 100, 50_000),
    maxConnectionsPerIp: clampInteger(value.maxConnectionsPerIp, MAX_CONNECTIONS_PER_IP, 1, 4096),
    maxClientsPerController: clampInteger(value.maxClientsPerController, MAX_CLIENTS_PER_CONTROLLER, 1, 128),
    maxMessageBytes: clampInteger(value.maxMessageBytes, MAX_MESSAGE_BYTES, 16 * 1024, HARD_MAX_MESSAGE_BYTES),
    maxMessagesPerSecond: clampInteger(value.maxMessagesPerSecond, MAX_MESSAGES_PER_SECOND, 10, 5000),
    maxWsHandshakesPerMinute: clampInteger(value.maxWsHandshakesPerMinute, MAX_WS_HANDSHAKES_PER_MINUTE, 10, 20_000),
    adminApiMaxPerMinute: clampInteger(value.adminApiMaxPerMinute, ADMIN_API_MAX_PER_MINUTE, 30, 5000),
    adminGlobalLoginMaxPerMinute: clampInteger(value.adminGlobalLoginMaxPerMinute, ADMIN_GLOBAL_LOGIN_MAX_PER_MINUTE, 10, 5000),
    adminLoginWindowSeconds: clampInteger(value.adminLoginWindowSeconds, Math.floor(ADMIN_LOGIN_WINDOW_MS / 1000), 60, 86_400),
    adminLoginMaxAttempts: clampInteger(value.adminLoginMaxAttempts, ADMIN_LOGIN_MAX_ATTEMPTS, 2, 50),
    adminLoginLockoutSeconds: clampInteger(value.adminLoginLockoutSeconds, Math.floor(ADMIN_LOGIN_LOCKOUT_MS / 1000), 30, 86_400),
    idleControllerSeconds: clampInteger(value.idleControllerSeconds, Math.floor(IDLE_TIMEOUT_MS / 1000), 30, 86_400),
    logMode,
    logIntervalSeconds: clampInteger(value.logIntervalSeconds, 15, 3, 3600),
    stateIntervalSeconds: clampInteger(value.stateIntervalSeconds, 2, 1, 60),
    blockRecheckSeconds: clampInteger(value.blockRecheckSeconds, 60, 15, 3600),
    clientLogRetentionLines: clampInteger(value.clientLogRetentionLines, 5000, 100, 100_000),
  };
}

function reportingPolicy(): JsonObject {
  return {
    logMode: runtimeSettings.logMode,
    logIntervalSeconds: runtimeSettings.logIntervalSeconds,
    stateIntervalSeconds: runtimeSettings.stateIntervalSeconds,
    blockRecheckSeconds: runtimeSettings.blockRecheckSeconds,
  };
}

function sanitizeInstanceId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const cleaned = value.trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return cleaned.length >= 8 ? cleaned : '';
}

function finiteNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeValue(value: unknown, depth: number, budget: { left: number }, maxString: number): unknown {
  if (budget.left <= 0 || depth > 8) return null;
  budget.left -= 1;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, maxString);
  if (Array.isArray(value)) return value.slice(0, 500).map(item => sanitizeValue(item, depth + 1, budget, maxString));
  if (isJsonObject(value)) {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value).slice(0, 500)) {
      if (budget.left <= 0) break;
      out[String(key).slice(0, 120)] = sanitizeValue(item, depth + 1, budget, maxString);
    }
    return out;
  }
  return String(value).slice(0, maxString);
}

function sanitizeObject(value: unknown, maxNodes = 1000, maxString = 4000): JsonObject {
  if (!isJsonObject(value)) return {};
  const result = sanitizeValue(value, 0, { left: maxNodes }, maxString);
  return isJsonObject(result) ? result : {};
}

function sanitizeClientLog(value: unknown): JsonObject | null {
  if (!isJsonObject(value)) return null;
  return {
    time: typeof value.time === 'string' ? value.time.slice(0, 32) : '',
    timestamp: finiteNumber(value.timestamp, Date.now() / 1000),
    category: typeof value.category === 'string' ? value.category.slice(0, 80) : '',
    event: typeof value.event === 'string' ? value.event.slice(0, 160) : '',
    detail: typeof value.detail === 'string' ? value.detail.slice(0, 3000) : '',
    output: sanitizeObject(value.output, 200, 1000),
    receivedAt: new Date().toISOString(),
  };
}

function safeClientLogPath(instanceId: string): string {
  return `${CLIENT_LOG_DIR}/${sanitizeInstanceId(instanceId)}.jsonl`;
}

function persistClientLogs(instanceId: string, logs: JsonObject[]): void {
  const cleanId = sanitizeInstanceId(instanceId);
  if (!cleanId || !logs.length) return;
  const path = safeClientLogPath(cleanId);
  try {
    if (existsSync(path) && statSync(path).size > MAX_CLIENT_LOG_FILE_BYTES) {
      const rotated = `${path}.1`;
      try { if (existsSync(rotated)) writeFileSync(rotated, '', { encoding: 'utf8' }); } catch {}
      try { renameSync(path, rotated); } catch {}
    }
    appendFileSync(path, logs.map(item => JSON.stringify(item)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    log('warn', `客户端日志写盘失败 instance=${cleanId} ${String(error)}`);
  }
}

function readJsonlTail(path: string, limit: number): JsonObject[] {
  try {
    if (!existsSync(path)) return [];
    const text = readFileSync(path, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Math.min(limit, 5000)));
    const result: JsonObject[] = [];
    for (const line of lines) {
      try { const parsed = JSON.parse(line); if (isJsonObject(parsed)) result.push(parsed); } catch {}
    }
    return result;
  } catch { return []; }
}

function readClientLogs(instanceId: string, limit: number): JsonObject[] {
  const cleanId = sanitizeInstanceId(instanceId);
  if (!cleanId) return [];
  return readJsonlTail(safeClientLogPath(cleanId), Math.min(limit, runtimeSettings.clientLogRetentionLines));
}

function readServerLogs(limit: number): JsonObject[] {
  const fromDisk = readJsonlTail(SERVER_LOG_FILE, limit);
  if (fromDisk.length) return fromDisk;
  return serverLogRing.slice(-Math.max(1, Math.min(limit, MAX_SERVER_LOG_RING))).map(entry => ({ ...entry }));
}

function persistClientMeta(records: Map<string, ClientReportRecord>): void {
  try {
    const compact = [...records.values()].map(record => ({
      instanceId: record.instanceId, controllerId: record.controllerId, remoteIp: record.remoteIp,
      connected: record.connected, firstSeenAt: record.firstSeenAt, lastSeenAt: record.lastSeenAt,
      client: record.client, privacy: record.privacy, logCount: record.logCount,
    }));
    writeFileSync(CLIENT_META_FILE, JSON.stringify(compact, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch {}
}

function loadClientMeta(): ClientReportRecord[] {
  try {
    if (!existsSync(CLIENT_META_FILE)) return [];
    const raw = JSON.parse(readFileSync(CLIENT_META_FILE, 'utf8'));
    if (!Array.isArray(raw)) return [];
    const out: ClientReportRecord[] = [];
    for (const item of raw.slice(-5000)) {
      if (!isJsonObject(item)) continue;
      const instanceId = sanitizeInstanceId(item.instanceId);
      if (!instanceId) continue;
      out.push({
        instanceId,
        controllerId: typeof item.controllerId === 'string' ? item.controllerId.slice(0, 80) : '',
        remoteIp: typeof item.remoteIp === 'string' ? item.remoteIp.slice(0, 128) : '',
        connected: false,
        firstSeenAt: finiteNumber(item.firstSeenAt, Date.now()),
        lastSeenAt: finiteNumber(item.lastSeenAt, Date.now()),
        client: sanitizeObject(item.client, 40, 500),
        privacy: sanitizeObject(item.privacy, 20, 200),
        peak: {}, dg: {}, multiplayer: {}, peakTimestamp: 0, lastStateAt: 0, lastLogAt: 0,
        logCount: clampInteger(item.logCount, 0, 0, 100_000_000),
      });
    }
    return out;
  } catch { return []; }
}

function countReportedDevices(record: ClientReportRecord): number {
  let count = 0;
  try {
    const apps = isJsonObject(record.multiplayer.apps) ? record.multiplayer.apps : {};
    for (const app of Object.values(apps)) {
      if (!isJsonObject(app)) continue;
      const devices = isJsonObject(app.devices) ? app.devices : {};
      count += Object.keys(devices).length;
    }
  } catch {}
  if (count === 0 && record.dg.slot_id != null) count = 1;
  return count;
}

function directorySize(path: string, depth = 0): number {
  if (depth > 5) return 0;
  try {
    let total = 0;
    for (const name of readdirSync(path)) {
      const full = `${path}/${name}`;
      const st = statSync(full);
      if (st.isDirectory()) total += directorySize(full, depth + 1);
      else if (st.isFile()) total += st.size;
    }
    return total;
  } catch { return 0; }
}

function cgroupMemory(): JsonObject {
  const readNum = (path: string): number | null => {
    try {
      const raw = readFileSync(path, 'utf8').trim();
      if (!raw || raw === 'max') return null;
      const n = Number(raw); return Number.isFinite(n) ? n : null;
    } catch { return null; }
  };
  return {
    current: readNum('/sys/fs/cgroup/memory.current'),
    limit: readNum('/sys/fs/cgroup/memory.max'),
  };
}

function systemSnapshot(): JsonObject {
  const mem = process.memoryUsage();
  let disk: JsonObject = {};
  try {
    const fs = statfsSync(DATA_DIR);
    const block = Number(fs.bsize || 0);
    disk = {
      total: Number(fs.blocks || 0) * block,
      free: Number(fs.bavail || 0) * block,
      dataUsed: directorySize(DATA_DIR),
    };
  } catch { disk = { total: null, free: null, dataUsed: directorySize(DATA_DIR) }; }
  return {
    process: { pid: process.pid, uptimeSeconds: Math.floor(process.uptime()), rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
    system: { uptimeSeconds: Math.floor(osUptime()), cpuCount: cpus().length, loadavg: loadavg(), memoryTotal: totalmem(), memoryFree: freemem() },
    cgroup: cgroupMemory(),
    disk,
    time: new Date().toISOString(),
  };
}

async function loadSecurityState(): Promise<SecurityState> {
  if (existsSync(SECURITY_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(SECURITY_FILE, 'utf8')) as SecurityState;
      if (parsed?.admin?.passwordHash && Array.isArray(parsed.blockedIps)) {
        const previousVersion = Number(parsed.version || 1);
        parsed.version = Math.max(3, previousVersion);
        parsed.runtime = normalizeRuntimeSettings(parsed.runtime);
        // V2.6 diagnostic state can exceed the old 64 KiB limit. Upgrade only old defaults;
        // an administrator can still lower this later from the panel.
        if (previousVersion < 3 && parsed.runtime.maxMessageBytes <= 65_536) parsed.runtime.maxMessageBytes = 256 * 1024;
        return parsed;
      }
    } catch (error) {
      log('error', `安全配置读取失败，将创建新配置: ${String(error)}`);
    }
  }
  const state: SecurityState = {
    version: 3,
    admin: {
      username: ADMIN_USER_DEFAULT,
      passwordHash: await Bun.password.hash(ADMIN_PASSWORD_DEFAULT),
      forcePasswordChange: true,
      updatedAt: new Date().toISOString(),
    },
    blockedIps: [],
    runtime: normalizeRuntimeSettings({}),
  };
  writeFileSync(SECURITY_FILE, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  log('warn', `管理后台首次初始化：admin 用户=${ADMIN_USER_DEFAULT}；首次登录必须修改初始密码。`);
  return state;
}

function persistSecurityState(): void {
  writeFileSync(SECURITY_FILE, JSON.stringify(security, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function blockedIpRecord(ip: string): BlockedIpRecord | null {
  if (!ip) return null;
  return security.blockedIps.find(item => item.ip === ip) || null;
}

function isBlockedIp(ip: string): boolean {
  return blockedIpRecord(ip) !== null;
}

function addSecurityEvent(type: string, ip: string, detail: string): void {
  securityEvents.unshift({ time: new Date().toISOString(), type, ip: ip || '-', detail: detail.slice(0, 300) });
  if (securityEvents.length > 200) securityEvents.length = 200;
  log(type.includes('失败') || type.includes('封禁') ? 'warn' : 'info', `安全 ${type} ip=${ip || '-'} ${detail}`);
}

function randomHex(bytes: number): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.get('cookie') || '';
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function requestIp(req: Request): string {
  return (req.headers.get('x-coyote-client-ip') || req.headers.get('x-forwarded-for') || '').split(',')[0]?.trim() || '';
}

function requestIsHttps(req: Request): boolean {
  const proto = (req.headers.get('x-forwarded-proto') || '').split(',')[0]?.trim().toLowerCase();
  return proto === 'https' || new URL(req.url).protocol === 'https:';
}

function adminSecurityHeaders(contentType?: string): Headers {
  const headers = new Headers();
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  headers.set('Pragma', 'no-cache');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (contentType) headers.set('Content-Type', contentType);
  return headers;
}

function jsonResponse(data: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = adminSecurityHeaders('application/json; charset=utf-8');
  if (extra) new Headers(extra).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(data), { status, headers });
}

function sameSiteRequest(req: Request): boolean {
  const secFetchSite = req.headers.get('sec-fetch-site');
  if (secFetchSite === 'cross-site') return false;
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || new URL(req.url).host;
    return originUrl.host === host;
  } catch { return false; }
}

function sessionCookie(token: string, req: Request, maxAgeSeconds: number): string {
  const secure = requestIsHttps(req) ? '; Secure' : '';
  return `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=${ADMIN_PREFIX}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

function getSession(req: Request): AdminSession | null {
  const token = parseCookies(req)[ADMIN_COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAt <= now) {
    sessions.delete(token);
    return null;
  }
  session.lastSeenAt = now;
  return session;
}

function makeSession(username: string, ip: string): AdminSession {
  const now = Date.now();
  const session: AdminSession = {
    token: randomHex(32),
    csrf: randomHex(24),
    username,
    ip,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + ADMIN_SESSION_MS,
  };
  sessions.set(session.token, session);
  return session;
}

function checkAdminApiRate(ip: string): boolean {
  const key = ip || '-';
  const now = Date.now();
  const state = adminApiRates.get(key);
  if (!state || now - state.windowStart >= 60_000) {
    adminApiRates.set(key, { windowStart: now, count: 1 });
    return true;
  }
  state.count += 1;
  return state.count <= runtimeSettings.adminApiMaxPerMinute;
}

function checkWsHandshakeRate(ip: string): boolean {
  if (!ip) return true;
  const now = Date.now();
  const state = wsHandshakeRates.get(ip);
  if (!state || now - state.windowStart >= 60_000) {
    wsHandshakeRates.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  state.count += 1;
  return state.count <= runtimeSettings.maxWsHandshakesPerMinute;
}

function checkGlobalLoginRate(): boolean {
  const now = Date.now();
  if (now - globalLoginRate.windowStart >= 60_000) globalLoginRate = { windowStart: now, count: 0 };
  globalLoginRate.count += 1;
  return globalLoginRate.count <= runtimeSettings.adminGlobalLoginMaxPerMinute;
}

function loginRateStatus(ip: string): { allowed: boolean; retryAfter: number } {
  const key = ip || '-';
  const now = Date.now();
  const state = loginRates.get(key);
  if (!state) return { allowed: true, retryAfter: 0 };
  if (state.lockedUntil > now) return { allowed: false, retryAfter: Math.ceil((state.lockedUntil - now) / 1000) };
  if (now - state.windowStart >= runtimeSettings.adminLoginWindowSeconds * 1000) {
    loginRates.delete(key);
    return { allowed: true, retryAfter: 0 };
  }
  return { allowed: true, retryAfter: 0 };
}

function recordLoginFailure(ip: string): void {
  const key = ip || '-';
  const now = Date.now();
  let state = loginRates.get(key);
  if (!state || now - state.windowStart >= runtimeSettings.adminLoginWindowSeconds * 1000) {
    state = { windowStart: now, attempts: 0, lockedUntil: 0 };
    loginRates.set(key, state);
  }
  state.attempts += 1;
  if (state.attempts >= runtimeSettings.adminLoginMaxAttempts) state.lockedUntil = now + runtimeSettings.adminLoginLockoutSeconds * 1000;
}

function requireAdmin(req: Request, requireCsrf = false, allowForcedChange = false): { session?: AdminSession; response?: Response } {
  const ip = requestIp(req);
  if (!checkAdminApiRate(ip)) return { response: jsonResponse({ ok: false, error: 'rate_limited' }, 429, { 'Retry-After': '60' }) };
  const session = getSession(req);
  if (!session) return { response: jsonResponse({ ok: false, error: 'unauthorized' }, 401) };
  if (!allowForcedChange && security.admin.forcePasswordChange) return { response: jsonResponse({ ok: false, error: 'password_change_required' }, 428) };
  if (requireCsrf) {
    if (!sameSiteRequest(req)) return { response: jsonResponse({ ok: false, error: 'cross_site_request_denied' }, 403) };
    const csrf = req.headers.get('x-csrf-token') || '';
    if (!csrf || csrf !== session.csrf) return { response: jsonResponse({ ok: false, error: 'csrf_failed' }, 403) };
  }
  return { session };
}

async function readJsonBody(req: Request): Promise<JsonObject | null> {
  const length = Number(req.headers.get('content-length') || '0');
  if (length > ADMIN_MAX_BODY_BYTES) return null;
  const text = await req.text();
  if (Buffer.byteLength(text, 'utf8') > ADMIN_MAX_BODY_BYTES) return null;
  try {
    const value = JSON.parse(text);
    return isJsonObject(value) ? value : null;
  } catch { return null; }
}

function validNewPassword(value: string): string | null {
  if (value.length < 12) return '新密码至少 12 个字符';
  if (value.length > 128) return '新密码不能超过 128 个字符';
  if (value.toLowerCase() === 'admin') return '不能继续使用 admin 作为密码';
  const classes = [/[a-z]/.test(value), /[A-Z]/.test(value), /[0-9]/.test(value), /[^A-Za-z0-9]/.test(value)].filter(Boolean).length;
  if (classes < 3) return '新密码至少包含大写、小写、数字、符号中的三类';
  return null;
}

async function handleAdminApi(req: Request, relay: RelayServer): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const ip = requestIp(req);

  if (!requestIsHttps(req) && !ADMIN_ALLOW_INSECURE_HTTP) {
    return jsonResponse({ ok: false, error: 'https_required', message: '管理后台仅允许 HTTPS。' }, 403);
  }

  if (path === `${ADMIN_PREFIX}/api/login` && req.method === 'POST') {
    if (!sameSiteRequest(req)) return jsonResponse({ ok: false, error: 'cross_site_request_denied' }, 403);
    if (!checkGlobalLoginRate()) {
      addSecurityEvent('全局登录限流', ip, '一分钟登录请求超过服务器全局上限');
      return jsonResponse({ ok: false, error: 'global_login_rate_limited' }, 429, { 'Retry-After': '60' });
    }
    const rate = loginRateStatus(ip);
    if (!rate.allowed) {
      addSecurityEvent('登录锁定', ip, `剩余 ${rate.retryAfter}s`);
      return jsonResponse({ ok: false, error: 'login_locked', retryAfter: rate.retryAfter }, 429, { 'Retry-After': String(rate.retryAfter) });
    }
    const body = await readJsonBody(req);
    if (!body) return jsonResponse({ ok: false, error: 'bad_request' }, 400);
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const hash = username === security.admin.username ? security.admin.passwordHash : dummyPasswordHash;
    let valid = false;
    try { valid = await Bun.password.verify(password, hash); } catch { valid = false; }
    if (!valid || username !== security.admin.username) {
      recordLoginFailure(ip);
      addSecurityEvent('登录失败', ip, '账号或密码错误');
      return jsonResponse({ ok: false, error: 'invalid_credentials', message: '账号或密码错误' }, 401);
    }
    loginRates.delete(ip || '-');
    const session = makeSession(username, ip);
    addSecurityEvent('登录成功', ip, `用户=${username}`);
    return jsonResponse({ ok: true, username, forcePasswordChange: security.admin.forcePasswordChange, csrf: session.csrf, expiresAt: new Date(session.expiresAt).toISOString() }, 200, {
      'Set-Cookie': sessionCookie(session.token, req, Math.floor(ADMIN_SESSION_MS / 1000)),
    });
  }

  if (path === `${ADMIN_PREFIX}/api/me` && req.method === 'GET') {
    const session = getSession(req);
    if (!session) return jsonResponse({ ok: true, authenticated: false });
    return jsonResponse({
      ok: true,
      authenticated: true,
      username: session.username,
      csrf: session.csrf,
      forcePasswordChange: security.admin.forcePasswordChange,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  }

  if (path === `${ADMIN_PREFIX}/api/change-password` && req.method === 'POST') {
    const auth = requireAdmin(req, true, true);
    if (auth.response) return auth.response;
    const body = await readJsonBody(req);
    if (!body) return jsonResponse({ ok: false, error: 'bad_request' }, 400);
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    const passwordError = validNewPassword(newPassword);
    if (passwordError) return jsonResponse({ ok: false, error: 'weak_password', message: passwordError }, 400);
    const currentOk = await Bun.password.verify(currentPassword, security.admin.passwordHash);
    if (!currentOk) {
      addSecurityEvent('改密失败', ip, '当前密码错误');
      return jsonResponse({ ok: false, error: 'current_password_invalid', message: '当前密码错误' }, 401);
    }
    security.admin.passwordHash = await Bun.password.hash(newPassword);
    security.admin.forcePasswordChange = false;
    security.admin.updatedAt = new Date().toISOString();
    persistSecurityState();
    sessions.clear();
    const newSession = makeSession(security.admin.username, ip);
    addSecurityEvent('密码修改', ip, '管理员密码已更新，其他会话已失效');
    return jsonResponse({ ok: true, csrf: newSession.csrf, forcePasswordChange: false }, 200, {
      'Set-Cookie': sessionCookie(newSession.token, req, Math.floor(ADMIN_SESSION_MS / 1000)),
    });
  }

  if (path === `${ADMIN_PREFIX}/api/logout` && req.method === 'POST') {
    const auth = requireAdmin(req, true, true);
    if (auth.response) return auth.response;
    if (auth.session) sessions.delete(auth.session.token);
    addSecurityEvent('退出登录', ip, '管理员主动退出');
    return jsonResponse({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', req, 0) });
  }

  if (path === `${ADMIN_PREFIX}/api/dashboard` && req.method === 'GET') {
    const auth = requireAdmin(req, false, false);
    if (auth.response) return auth.response;
    return jsonResponse({
      ok: true,
      stats: relay.stats(),
      system: systemSnapshot(),
      connections: relay.connectionSnapshots(),
      clients: relay.clientReportSummaries(),
      blockedIps: security.blockedIps,
      securityEvents: securityEvents.slice(0, 80),
      limits: runtimeSettings,
      reportingPolicy: reportingPolicy(),
    });
  }

  if (path === `${ADMIN_PREFIX}/api/client-detail` && req.method === 'GET') {
    const auth = requireAdmin(req, false, false);
    if (auth.response) return auth.response;
    const id = (url.searchParams.get('id') || '').trim();
    if (!id) return jsonResponse({ ok: false, error: 'bad_request' }, 400);
    const client = relay.clientReportDetail(id);
    if (!client) return jsonResponse({ ok: false, error: 'not_found' }, 404);
    return jsonResponse({ ok: true, client });
  }

  if (path === `${ADMIN_PREFIX}/api/client-logs` && req.method === 'GET') {
    const auth = requireAdmin(req, false, false);
    if (auth.response) return auth.response;
    const id = (url.searchParams.get('id') || '').trim();
    const limit = clampInteger(url.searchParams.get('limit'), 300, 1, 5000);
    if (!id) return jsonResponse({ ok: false, error: 'bad_request' }, 400);
    return jsonResponse({ ok: true, logs: readClientLogs(id, limit) });
  }

  if (path === `${ADMIN_PREFIX}/api/server-logs` && req.method === 'GET') {
    const auth = requireAdmin(req, false, false);
    if (auth.response) return auth.response;
    const limit = clampInteger(url.searchParams.get('limit'), 400, 1, 1500);
    return jsonResponse({ ok: true, logs: readServerLogs(limit) });
  }

  if (path === `${ADMIN_PREFIX}/api/settings` && req.method === 'GET') {
    const auth = requireAdmin(req, false, false);
    if (auth.response) return auth.response;
    return jsonResponse({ ok: true, settings: runtimeSettings });
  }

  if (path === `${ADMIN_PREFIX}/api/settings` && req.method === 'POST') {
    const auth = requireAdmin(req, true, false);
    if (auth.response) return auth.response;
    const body = await readJsonBody(req);
    if (!body) return jsonResponse({ ok: false, error: 'bad_request' }, 400);
    runtimeSettings = normalizeRuntimeSettings({ ...runtimeSettings, ...body });
    security.runtime = runtimeSettings;
    persistSecurityState();
    relay.broadcastPolicy();
    addSecurityEvent('安全设置更新', ip, `日志=${runtimeSettings.logMode}; 连接上限=${runtimeSettings.maxConnections}; 单IP=${runtimeSettings.maxConnectionsPerIp}`);
    return jsonResponse({ ok: true, settings: runtimeSettings, policy: reportingPolicy() });
  }

  if (path === `${ADMIN_PREFIX}/api/kick` && req.method === 'POST') {
    const auth = requireAdmin(req, true, false);
    if (auth.response) return auth.response;
    const body = await readJsonBody(req);
    const clientId = body && typeof body.clientId === 'string' ? body.clientId.trim() : '';
    if (!clientId) return jsonResponse({ ok: false, error: 'bad_request' }, 400);
    const reason = body && typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '管理员踢下线';
    const kicked = relay.kickClient(clientId, reason || '管理员踢下线');
    if (!kicked) return jsonResponse({ ok: false, error: 'not_found' }, 404);
    addSecurityEvent('踢出连接', ip, `连接=${clientId} 原因=${reason || '-'}`);
    return jsonResponse({ ok: true });
  }

  if (path === `${ADMIN_PREFIX}/api/block-ip` && req.method === 'POST') {
    const auth = requireAdmin(req, true, false);
    if (auth.response) return auth.response;
    const body = await readJsonBody(req);
    const targetIp = body && typeof body.ip === 'string' ? body.ip.trim() : '';
    const reason = body && typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
    if (!targetIp || isIP(targetIp) === 0) return jsonResponse({ ok: false, error: 'invalid_ip', message: '请输入有效 IPv4/IPv6 地址' }, 400);

    let changed = false;
    const existing = security.blockedIps.find(item => item.ip === targetIp);
    if (!existing) {
      security.blockedIps.push({ ip: targetIp, reason: reason || '管理员手动封禁', createdAt: new Date().toISOString() });
      security.blockedIps.sort((a, b) => a.ip.localeCompare(b.ip));
      changed = true;
    } else if (reason && existing.reason !== reason) {
      existing.reason = reason;
      changed = true;
    }
    if (changed) {
      persistSecurityState();
      bumpBlocklistRevision();
    }

    const kicked = relay.kickIp(targetIp, reason || existing?.reason || '管理员手动封禁');
    addSecurityEvent('封禁 IP', ip, `目标=${targetIp} 踢出=${kicked} 原因=${reason || existing?.reason || '-'}`);
    return jsonResponse({ ok: true, kicked, changed, revision: blocklistRevision });
  }

  if (path === `${ADMIN_PREFIX}/api/unblock-ip` && req.method === 'POST') {
    const auth = requireAdmin(req, true, false);
    if (auth.response) return auth.response;
    const body = await readJsonBody(req);
    const targetIp = body && typeof body.ip === 'string' ? body.ip.trim() : '';
    if (!targetIp) return jsonResponse({ ok: false, error: 'bad_request' }, 400);
    const before = security.blockedIps.length;
    security.blockedIps = security.blockedIps.filter(item => item.ip !== targetIp);
    const changed = before !== security.blockedIps.length;
    if (changed) {
      persistSecurityState();
      // Wake all blocked clients currently long-polling /relay-status.  Each
      // response only reveals the caller's own IP state.
      bumpBlocklistRevision();
    }
    addSecurityEvent('解除封禁', ip, `目标=${targetIp}`);
    return jsonResponse({ ok: true, changed, revision: blocklistRevision });
  }

  return jsonResponse({ ok: false, error: 'not_found' }, 404);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const isMessageFrame = (value: unknown): value is MessageFrame => isJsonObject(value) && value.type === 'message';
function numberFromEnv(name: string, fallback: number): number {
  const value = Number(Bun.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
function stringFromEnv(name: string, fallback: string): string { return Bun.env[name]?.trim() || fallback; }
function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = Bun.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}
function prefixFromEnv(name: string, fallback: string): string {
  const value = Bun.env[name]?.trim();
  if (!value) return fallback;
  const prefixed = value.startsWith('/') ? value : `/${value}`;
  return prefixed.length > 1 ? prefixed.replace(/\/+$/, '') : prefixed;
}
function logLevelFromEnv(): LogLevel {
  const value = Bun.env.LOG_LEVEL?.toLowerCase();
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
  return 'info';
}

const relay = new RelayServer();
const handleFetch = async (req: Request, server: Server<WSData>): Promise<Response | undefined> => {
  const url = new URL(req.url);

  if (url.pathname === '/healthz') {
    return Response.json(relay.stats(), { status: 200, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }

  if (url.pathname === '/relay-status' && req.method === 'GET') {
    const ip = requestIp(req);
    const sinceRaw = Number(url.searchParams.get('since'));
    const waitRaw = Number(url.searchParams.get('wait'));
    const since = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? Math.trunc(sinceRaw) : -1;
    const waitSeconds = Number.isFinite(waitRaw) ? Math.max(0, Math.min(30, waitRaw)) : 0;

    // HTTPS long-poll: if nothing changed, hold the response briefly.  An
    // administrator block/unblock wakes it instantly by bumping the revision.
    if (waitSeconds > 0 && since === blocklistRevision) {
      await waitForBlocklistChange(since, waitSeconds * 1000);
    }

    const blocked = blockedIpRecord(ip);
    return Response.json({
      ok: true,
      blocked: !!blocked,
      reason: blocked?.reason || '',
      revision: blocklistRevision,
      time: new Date().toISOString(),
    }, { status: 200, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }

  if (url.pathname === ADMIN_PREFIX) {
    return new Response(null, { status: 308, headers: { Location: `${ADMIN_PREFIX}/` } });
  }
  if (url.pathname === `${ADMIN_PREFIX}/` && req.method === 'GET') {
    return new Response(Bun.file('/app/admin.html'), { headers: adminSecurityHeaders('text/html; charset=utf-8') });
  }
  if (url.pathname === `${ADMIN_PREFIX}/admin.css` && req.method === 'GET') {
    return new Response(Bun.file('/app/admin.css'), { headers: adminSecurityHeaders('text/css; charset=utf-8') });
  }
  if (url.pathname === `${ADMIN_PREFIX}/admin.js` && req.method === 'GET') {
    return new Response(Bun.file('/app/admin.js'), { headers: adminSecurityHeaders('text/javascript; charset=utf-8') });
  }
  if (url.pathname.startsWith(`${ADMIN_PREFIX}/api/`)) return handleAdminApi(req, relay);

  if (url.pathname !== PREFIX) return new Response('Not Found', { status: 404 });
  const wantsWebSocket = (req.headers.get('upgrade') || '').toLowerCase() === 'websocket';
  if (!wantsWebSocket && req.method === 'GET') {
    return new Response(null, { status: 302, headers: { Location: `${ADMIN_PREFIX}/` } });
  }
  if (!relay.canAccept()) return new Response('Server Busy', { status: 503 });
  const tid = url.searchParams.get('targetId') ?? url.searchParams.get('tid') ?? undefined;
  const remoteIp = requestIp(req);
  const blocked = blockedIpRecord(remoteIp);
  if (blocked) return Response.json({ ok: false, error: 'blocked', reason: blocked.reason || '管理员封禁' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  if (!checkWsHandshakeRate(remoteIp)) return new Response('Too Many Handshakes', { status: 429, headers: { 'Retry-After': '60' } });
  if (!relay.canAcceptIp(remoteIp)) return new Response('Too Many Connections', { status: 429 });
  const userAgent = (req.headers.get('user-agent') || '').slice(0, 300);
  if (server.upgrade(req, { data: { tid, remoteIp, userAgent } })) return;
  return new Response('WebSocket upgrade required', { status: 426 });
};

Bun.serve<WSData>({
  hostname: HOST,
  port: relay.port,
  fetch: handleFetch,
  websocket: {
    data: {} as WSData,
    open: ws => relay.onOpen(ws),
    message: (ws, msg) => relay.onMessage(ws, msg),
    pong: ws => relay.onPong(ws),
    close: (ws, code, reason) => relay.onClose(ws, code, reason),
    maxPayloadLength: HARD_MAX_MESSAGE_BYTES,
    idleTimeout: 0,
  },
});
relay.startHeartbeat();
relay.startWsPing();
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
  for (const [ip, state] of loginRates) if (state.lockedUntil <= now && now - state.windowStart > runtimeSettings.adminLoginWindowSeconds * 1000) loginRates.delete(ip);
  for (const [ip, state] of adminApiRates) if (now - state.windowStart > 60_000) adminApiRates.delete(ip);
  for (const [ip, state] of wsHandshakeRates) if (now - state.windowStart > 60_000) wsHandshakeRates.delete(ip);
}, 60_000);
log('info', `服务启动 host=${HOST} port=${PORT} path=${PREFIX} max=${runtimeSettings.maxConnections} admin=${ADMIN_PREFIX}/`);
