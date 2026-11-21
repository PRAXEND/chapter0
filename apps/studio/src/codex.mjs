import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

// No project directory or media file is ever exposed as an execution environment.
// The host supplies the explicitly selected project data through typed dynamic tools.
const disabledFeatures = [
  'shell_tool',
  'unified_exec',
  'apps',
  'plugins',
  'hooks',
  'multi_agent',
  'multi_agent_v2',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
  'image_generation',
  'code_mode',
  'view_image',
  'skill_search',
  'skill_mcp_dependency_install',
  'memories',
  'shell_snapshot',
];
const baseConfig = Object.fromEntries(disabledFeatures.map((name) => ['features.' + name, false]));
Object.assign(baseConfig, { web_search: 'disabled', project_doc_max_bytes: 0 });
const profile = 'video_studio_editor';

async function binary() {
  const candidates = [
    process.env.VIDEO_STUDIO_CODEX,
    '/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    ...(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, 'codex')),
  ];
  for (const name of candidates.filter(Boolean)) {
    try {
      await access(name, constants.X_OK);
      return name;
    } catch {}
  }
  throw new Error('找不到 Codex。安装 Codex 或在工作台启动环境设置 VIDEO_STUDIO_CODEX。');
}

export class CodexClient {
  constructor({ launch, directory } = {}) {
    this.launch = launch;
    this.directory = directory;
    this.events = new EventEmitter();
    this.routes = new Map();
    this.pending = new Map();
    this.next = 0;
  }

  async connect() {
    if (!this.ready)
      this.ready = this.open().catch((error) => {
        this.close();
        throw error;
      });
    return this.ready;
  }

  async open() {
    if (!this.directory) {
      this.directory = await mkdtemp(path.join(tmpdir(), 'video-studio-agent-'));
      this.temporary = true;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const args = ['app-server', '--listen', 'stdio://'];
    for (const [key, value] of Object.entries(baseConfig)) args.push('-c', key + '=' + JSON.stringify(value));
    const child = this.launch
      ? await this.launch(args, this.directory)
      : spawn(await binary(), args, { cwd: this.directory, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    // stderr can contain account diagnostics; drain it without copying it into project logs.
    child.stderr?.resume();
    child.stdin.on('error', () => {});
    const stopped = (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      const reason = error instanceof Error ? error : new Error('Codex App Server 已断开，工程可继续打开。');
      for (const wait of this.pending.values()) wait.reject(reason);
      this.pending.clear();
      this.events.emit('stopped', reason);
    };
    child.once('error', stopped);
    child.once('exit', stopped);
    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (this.child !== child) return;
      if (msg.method && Object.hasOwn(msg, 'id')) {
        void this.hostRequest(msg, child);
        return;
      }
      if (msg.method) {
        this.events.emit('notice', msg);
        return;
      }
      const wait = this.pending.get(msg.id);
      if (!wait) return;
      this.pending.delete(msg.id);
      if (msg.error) wait.reject(new Error(msg.error.message || 'Codex 请求失败'));
      else wait.resolve(msg.result);
    });
    await this.request('initialize', {
      clientInfo: { name: 'video_studio', title: 'Video Studio', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized' });
    // Empty TOML maps can merge with user configuration. Explicitly disable every installed
    // custom MCP server for this thread, in addition to disabling plugin and app discovery.
    const { config } = await this.request('config/read', { includeLayers: false, cwd: this.directory });
    this.config = {
      ...baseConfig,
      ['permissions.' + profile + '.filesystem']: { ':minimal': 'read' },
      ['permissions.' + profile + '.network.enabled']: false,
    };
    for (const name of Object.keys(config?.mcp_servers || {})) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('当前 MCP 服务名无法安全隔离，请调整后重试。');
      this.config['mcp_servers.' + name + '.enabled'] = false;
    }
    return this;
  }

  write(value) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex App Server 已断开。');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }

  request(method, params) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + ' 请求超时。'));
      }, 60_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pending.get(id).reject(error);
        this.pending.delete(id);
      }
    });
  }

  async hostRequest(msg, child) {
    let response;
    try {
      const route = this.routes.get(msg.params?.threadId);
      if (
        msg.method === 'item/tool/call' &&
        route &&
        route.turnId === msg.params?.turnId &&
        !route.signal?.aborted
      ) {
        const result = await route.tool(msg.params);
        response = { result };
      } else if (msg.method.endsWith('requestApproval') && msg.method.includes('permissions')) {
        response = { result: { permissions: {}, scope: 'turn' } };
      } else if (msg.method.endsWith('requestApproval')) {
        response = { result: { decision: 'decline' } };
      } else {
        response = { error: { code: -32601, message: '此操作不在工程授权范围内。' } };
      }
    } catch (error) {
      response = {
        result: {
          success: false,
          contentItems: [{ type: 'inputText', text: error.message || '工程工具执行失败' }],
        },
      };
    }
    if (this.child === child) {
      try {
        this.write({ id: msg.id, ...response });
      } catch {}
    }
  }

  async account() {
    try {
      await this.connect();
      const result = await this.request('account/read', { refreshToken: false });
      return { available: true, connected: Boolean(result.account), accountType: result.account?.type || null };
    } catch (error) {
      return { available: false, connected: false, message: error.message };
    }
  }
  async login() {
    await this.connect();
    return this.request('account/login/start', { type: 'chatgpt' });
  }

  async thread(threadId, tools, instructions, settings) {
    await this.connect();
    const common = {
      cwd: this.directory,
      runtimeWorkspaceRoots: [],
      approvalPolicy: 'never',
      permissions: profile,
      config: this.config,
      developerInstructions: instructions,
    };
    if (settings?.model) common.model = settings.model;
    const result = threadId
      ? await this.request('thread/resume', { ...common, threadId, excludeTurns: true })
      : await this.request('thread/start', {
          ...common,
          ephemeral: false,
          environments: [],
          selectedCapabilityRoots: [],
          dynamicTools: tools,
        });
    // Fail closed if a globally managed connector survived the thread overrides.
    let cursor = null;
    do {
      const inventory = await this.request('mcpServerStatus/list', {
        threadId: result.thread.id,
        detail: 'full',
        cursor,
        limit: 100,
      });
      if (
        inventory.data.some(
          (s) => Object.keys(s.tools || {}).length || s.resources?.length || s.resourceTemplates?.length
        )
      ) {
        throw new Error('当前 Codex 环境仍有工程以外的工具启用，已停止向模型发送素材。');
      }
      cursor = inventory.nextCursor;
    } while (cursor);
    return result.thread.id;
  }

  async findTurn(threadId, turnId) {
    const { thread } = await this.request('thread/read', { threadId, includeTurns: false });
    let cursor = null;
    do {
      const page = await this.request('thread/turns/list', {
        threadId,
        cursor,
        limit: 16,
        sortDirection: 'desc',
        itemsView: 'summary',
      });
      const turn = page.data.find((t) => t.id === turnId);
      if (turn) return { turn, status: thread.status };
      cursor = page.nextCursor;
    } while (cursor);
    return { turn: null, status: thread.status };
  }

  async runTurn({ threadId, existingTurnId, prompt, tool, signal, onEvent, onStart, effort }) {
    if (this.routes.has(threadId)) throw new Error('当前工程已有创作任务。');
    signal?.throwIfAborted();
    let turnId = existingTurnId,
      message = '',
      settled = false,
      resolveDone,
      rejectDone;
    const done = new Promise((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    // A disconnect may arrive before turn/start returns its id.
    done.catch(() => {});
    const finish = (error) => {
      if (!settled) {
        settled = true;
        error ? rejectDone(error) : resolveDone(message);
      }
    };
    const notice = ({ method, params }) => {
      if (params?.threadId !== threadId || (turnId && (params.turnId || params.turn?.id) !== turnId)) return;
      if (method === 'turn/started') {
        turnId = params.turn.id;
        this.routes.get(threadId).turnId = turnId;
      }
      if (method === 'item/completed' && params.item?.type === 'agentMessage') {
        message = params.item.text;
        onEvent?.({ type: 'message', message });
      }
      if (method === 'turn/completed')
        finish(
          params.turn.status === 'completed'
            ? null
            : new Error(
                params.turn.error?.message ||
                  'Codex 任务' + (params.turn.status === 'interrupted' ? '已取消' : '失败')
              )
        );
    };
    const abort = () => {
      if (turnId) this.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      finish(signal.reason || new DOMException('已取消', 'AbortError'));
    };
    this.routes.set(threadId, { tool, signal, turnId: existingTurnId || null });
    this.events.on('notice', notice);
    this.events.on('stopped', finish);
    signal?.addEventListener('abort', abort, { once: true });
    let poll;
    try {
      if (existingTurnId) {
        let checking = false;
        const check = async () => {
          if (settled || checking) return;
          checking = true;
          try {
            const { turn, status } = await this.findTurn(threadId, existingTurnId);
            if (!turn) throw Error('未找到原轮次，保留现有工程。');
            if (turn.status === 'inProgress') {
              if (status?.type !== 'active') throw Error('原轮次已离线，保存的工程编辑可继续使用。');
            } else {
              const final = turn.items?.findLast((item) => item.type === 'agentMessage');
              if (final?.text) message = final.text;
              finish(
                turn.status === 'completed' ? null : new Error(turn.error?.message || '上一轮 Codex 已中断。')
              );
            }
          } catch (error) {
            finish(error);
          } finally {
            checking = false;
          }
        };
        // Subscribe before reading: a completion between snapshot and subscription must not be lost.
        await check();
        poll = setInterval(() => void check(), 15000);
        poll.unref?.();
      } else {
        const params = {
          threadId,
          input: [{ type: 'text', text: prompt }],
          environments: [],
          runtimeWorkspaceRoots: [],
          approvalPolicy: 'never',
          permissions: profile,
        };
        if (effort) params.effort = effort;
        const result = await this.request('turn/start', params);
        turnId = result.turn.id;
        this.routes.get(threadId).turnId = turnId;
      }
      await onStart?.(turnId);
      if (signal?.aborted) abort();
      return await done;
    } finally {
      clearInterval(poll);
      this.routes.delete(threadId);
      this.events.off('notice', notice);
      this.events.off('stopped', finish);
      signal?.removeEventListener('abort', abort);
    }
  }
  close() {
    const child = this.child;
    if (child) child.kill();
    const reason = new Error('Codex 连接已关闭。');
    for (const wait of this.pending.values()) wait.reject(reason);
    this.pending.clear();
    this.events.emit('stopped', reason);
    this.child = null;
    this.ready = null;
    if (this.temporary && this.directory) {
      rm(this.directory, { recursive: true, force: true }).catch(() => {});
      this.directory = null;
    }
  }
}
