import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { childEnvironment, desktopProfileHome, prepareProfile, privateRollout, studioProfileHome, workbenchLegacy } from './codex-profile.mjs';

const readOnlyDesktop = Symbol('legacy workspace reader');
const readMethods = new Set(['initialize', 'config/read', 'thread/read', 'thread/turns/list']);
const absentThread = error => /no rollout found|(?:thread|conversation)[^\n]*(?:not found|not loaded|does not exist)|(?:not found|unknown) (?:thread|conversation)|could not find (?:a )?(?:thread|session|conversation)/i.test(error?.message || '');


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
  constructor({ launch, directory, home = studioProfileHome(), desktopHome = desktopProfileHome(), reader } = {}) {
    this.home = home;
    this.desktopHome = desktopHome;
    this.readOnly = reader === readOnlyDesktop;
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
    if (!this.readOnly) {
      this.profile = await prepareProfile({
        home: this.home,
        desktop: this.desktopHome,
        settings: () => this.withDesktop(reader => ({credentialMode: reader.credentialStore, sqliteHome: reader.sqliteHome, model: reader.defaultModel, effort: reader.defaultEffort})),
      });
      this.storeId = this.profile.storeId;
    }
    const home = this.readOnly ? this.desktopHome : this.profile.directory;
    const env = childEnvironment(home, { reader: this.readOnly });
    const args = ['app-server', '--listen', 'stdio://'];
    if (!this.readOnly) {
      args.push('-c', 'sqlite_home=' + JSON.stringify(home));
      if (this.profile.modelDefaults.model) args.push('-c', 'model=' + JSON.stringify(this.profile.modelDefaults.model));
      if (this.profile.modelDefaults.effort) args.push('-c', 'model_reasoning_effort=' + JSON.stringify(this.profile.modelDefaults.effort));
      if (['file','keyring','auto','ephemeral'].includes(this.profile.credentialStore))
        args.push('-c', 'cli_auth_credentials_store=' + JSON.stringify(this.profile.credentialStore));
    }
    for (const [key, value] of Object.entries(baseConfig)) args.push('-c', key + '=' + JSON.stringify(value));
    const child = this.launch
      ? await this.launch(args, this.directory, env)
      : spawn(await binary(), args, { cwd: this.directory, env, stdio: ['pipe', 'pipe', 'pipe'] });
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
    this.credentialStore = config?.cli_auth_credentials_store;
    this.sqliteHome = config?.sqlite_home;
    // Reuse ordinary creative defaults without copying the desktop settings (plugins,
    // credentials, alternate endpoints, or instructions). A project selection wins.
    if (!config?.model_provider || config.model_provider === 'openai') {
      this.defaultModel = config?.model;
      this.defaultEffort = config?.model_reasoning_effort;
    }
    if (this.readOnly) return this;
    if (config?.sqlite_home && path.resolve(config.sqlite_home) !== home)
      throw Error('当前 Codex 配置未采用工作台的独立会话索引。');
    this.config = {
      ...baseConfig,
      default_permissions: profile,
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

  async withDesktop(read) {
    const client = new CodexClient({
      launch: this.launch,
      directory: this.directory,
      desktopHome: this.desktopHome,
      reader: readOnlyDesktop,
    });
    try {
      await client.connect();
      return await read(client);
    } finally {
      client.close();
    }
  }

  request(method, params) {
    if (this.readOnly && !readMethods.has(method)) throw Error('旧工程目录仅允许读取指定工作台会话。');
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
      return { available: true, connected: Boolean(result.account), accountType: result.account?.type || null, accountSource: this.profile.accountSource };
    } catch (error) {
      return { available: false, connected: false, message: error.message };
    }
  }
  async login() {
    await this.connect();
    if (this.profile.accountSource === 'desktop-file') {
      const status = await this.request('account/read', { refreshToken: false });
      return {connected: Boolean(status.account), message: status.account
        ? '已连接本机 Codex 账号。' : '请在 Codex 桌面重新登录已共享的账号，然后重新打开工作台。'};
    }
    return this.request('account/login/start', { type: 'chatgpt' });
  }

  async legacyCopy(threadId, options) {
    return this.withDesktop(async reader => {
      let thread;
      try {
        ({thread} = await reader.request('thread/read', {threadId, includeTurns: false}));
      } catch (e) {
        if (absentThread(e) && options.allowFreshOnMissing) return null;
        throw e;
      }
      if (!workbenchLegacy(thread, threadId)) throw Error('原会话未通过工作台身份核对，请从当前工程另开制作。');
      const page = await reader.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
      if (thread.status?.type === 'active' || page.data.some(t => t.status === 'inProgress'))
        throw Error('旧版工作台回合仍在执行或缺少结束回执，请先确认原任务状态。');
      if (options.legacyTurnId && !options.allowFreshOnMissing) {
        const {turn} = await reader.findTurnHere(threadId, options.legacyTurnId);
        if (!turn) throw Error('未能核对旧任务的回合，请在当前工程新建制作任务。');
      }
      return privateRollout(this.profile, thread, threadId);
    });
  }

  async thread(threadId, tools, instructions, settings, options = {}) {
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
    const start = () => this.request('thread/start', {
      ...common, ephemeral: false, environments: [], selectedCapabilityRoots: [], dynamicTools: tools,
    });
    let result;
    if (threadId) {
      try {
        result = await this.request('thread/resume', { ...common, threadId, excludeTurns: true });
      } catch (error) {
        if (!absentThread(error) || (!options.allowLegacy && !options.allowFreshOnMissing)) throw error;
        const legacy = options.allowLegacy ? await this.legacyCopy(threadId, options) : null;
        if (legacy) {
          result = await this.request('thread/resume', { ...common, threadId, path: legacy, excludeTurns: true });
          if (result.thread.id !== threadId || !result.thread.path || await realpath(result.thread.path) !== await realpath(legacy))
            throw Error('Codex 没有从迁入工作台的记录恢复，工程已保留。');
        } else {
          result = await start();
        }
      }
    } else {
      result = await start();
    }
    // New rollouts may not yet be materialized. Their configured root and returned
    // absolute location must both belong to Studio before a paid turn can begin.
    if (result.thread.path && !this.ownsRolloutPath(result.thread.path))
      throw Error('Codex 未返回工作台目录中的会话，工程已保留。');
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
    this.threadModels ??= new Map();
    this.threadModels.set(result.thread.id, result.model || null);
    return result.thread.id;
  }
  ownsRolloutPath(file) {
    const relative = path.relative(this.profile.directory, path.resolve(file)).split(path.sep);
    return ['sessions', 'archived_sessions'].includes(relative[0]) && !relative.includes('..');
  }

  modelForThread(id) {
    return this.threadModels?.get(id) || null;
  }

  async recentTurnIds(threadId) {
    await this.connect();
    try {
      const page = await this.request('thread/turns/list', {threadId, limit: 2, sortDirection: 'desc', itemsView: 'notLoaded'});
      return page.data.map(turn => turn.id);
    } catch (error) {
      if (absentThread(error) || /not materialized|no persisted/i.test(error.message)) return [];
      throw error;
    }
  }

  async findTurn(threadId, turnId, { allowLegacy = false, allowMissing = false } = {}) {
    await this.connect();
    try {
      return await this.findTurnHere(threadId, turnId);
    } catch (error) {
      if (!absentThread(error)) throw error;
      if (!allowLegacy) {
        if (allowMissing) return {turn: null, status: null};
        throw error;
      }
      return this.withDesktop(async reader => {
        let thread;
        try {
          ({thread} = await reader.request('thread/read', {threadId, includeTurns: false}));
        } catch (e) {
          if (allowMissing && absentThread(e)) return {turn: null, status: null};
          throw e;
        }
        if (!workbenchLegacy(thread, threadId)) throw Error('该旧回合不是已登记的工作台会话。');
        return reader.findTurnHere(threadId, turnId);
      });
    }
  }

  async findTurnHere(threadId, turnId) {
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

  async steer(threadId, expectedTurnId, message) {
    const route = this.routes.get(threadId);
    if (!expectedTurnId || route?.turnId !== expectedTurnId || route.signal?.aborted) {
      throw Object.assign(new Error('这轮 Codex 已结束或尚未启动。'), { status: 409 });
    }
    const result = await this.request('turn/steer', {
      threadId,
      expectedTurnId,
      input: [{ type: 'text', text: message }],
    });
    if (result.turnId !== expectedTurnId) throw Object.assign(new Error('Codex 轮次已改变。'), { status: 409 });
    return { turnId: result.turnId };
  }

  async runTurn({ threadId, existingTurnId, prompt, images = [], tool, signal, onEvent, onStart, effort }) {
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
          input: [
            { type: 'text', text: prompt },
            ...images.flatMap((image) => [
              { type: 'text', text: image.label },
              { type: 'image', url: image.url },
            ]),
          ],
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
