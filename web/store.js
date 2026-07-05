// 应用状态与逻辑（petite-vue 根 scope）。视图切换、发起表单、事件流消费、
// 历史回放都在此。传输细节隔离在 transport.js，markdown 净化隔离在 md.js。
import { renderMarkdown, escapeText } from './md.js';
import { liveTransport, mockTransport } from './transport.js';

const MOCK = new URLSearchParams(location.search).has('mock');

// 面向用户的 5 个阶段停靠点；orchestrator 的细粒度 phase 折叠到这些停靠点。
const PHASE_STOPS = [
  { key: 'route', label: '路由', phases: ['route'] },
  { key: 'broadcast', label: '并行回答', phases: ['broadcast'] },
  { key: 'review', label: '交叉评审', phases: ['review', 'cross_examine'] },
  { key: 'consensus', label: '共识判定', phases: ['consensus', 'human_gate'] },
  { key: 'synthesis', label: '主席综合', phases: ['synthesis', 'pre_synthesis_compression'] },
];
const STOP_OF_PHASE = {};
PHASE_STOPS.forEach((s, i) => s.phases.forEach((p) => { STOP_OF_PHASE[p] = i; }));

const MODE_LABELS = { auto: '自动', quick: '快速', compare: '对比', debate: '辩论' };

// 传输实例与 markdown 节流计时器存在 reactivity 之外。
let transport = null;
let renderTimer = null;

function freshDebate() {
  return {
    id: '', question: '', mode: '',
    currentStop: -1, crossExamineRound: 0, completed: false,
    experts: [], review: null, synthesis: null,
    consensus: null, degradations: [], session: null,
    conn: 'idle', activeTab: '',
    error: '',
  };
}

export function createStore() {
  return {
    // ---- 全局 ----
    route: { name: 'launch', params: {} },
    theme: 'auto',
    modeLabels: MODE_LABELS,
    phaseStopDefs: PHASE_STOPS,

    // ---- 发起表单 ----
    form: { question: '', mode: 'auto', models: [], chairman: '', devilAdvocate: false },
    models: [], modes: [], defaultChairman: '',
    modelsError: '', launching: false, launchError: '',

    // ---- 观看 / 回放 ----
    debate: freshDebate(),

    // ---- 历史 ----
    sessions: [], historyLoading: false, historyError: '',

    // ================= 生命周期 =================
    init() {
      this.applyTheme(localStorage.getItem('council-theme') || 'auto');
      window.addEventListener('hashchange', () => this.syncRoute());
      startRenderLoop(this);
      this.syncRoute();
    },

    // ================= 主题 =================
    applyTheme(t) {
      this.theme = t;
      if (t === 'auto') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = t;
      localStorage.setItem('council-theme', t);
    },
    cycleTheme() {
      const order = ['auto', 'light', 'dark'];
      this.applyTheme(order[(order.indexOf(this.theme) + 1) % order.length]);
    },
    themeIcon() { return this.theme === 'dark' ? '🌙' : this.theme === 'light' ? '☀️' : '◐'; },

    // ================= 路由 =================
    syncRoute() {
      const hash = location.hash.replace(/^#\/?/, '');
      const [seg, param] = hash.split('/');
      teardownTransport();
      if (seg === 'watch' && param) {
        this.route = { name: 'watch', params: { debateId: param } };
        this.startWatch(param);
      } else if (seg === 'session' && param) {
        this.route = { name: 'replay', params: { id: param } };
        this.loadReplay(param);
      } else if (seg === 'history') {
        this.route = { name: 'history', params: {} };
        this.loadHistory();
      } else {
        this.route = { name: 'launch', params: {} };
        this.loadModels();
      }
    },
    go(path) { location.hash = path; },
    modeLabel(m) { return MODE_LABELS[m] || m; },

    // ================= 发起表单 =================
    async loadModels() {
      if (this.models.length) return;
      this.modelsError = '';
      try {
        const data = MOCK
          ? { models: mockModels(), modes: ['auto', 'quick', 'compare', 'debate'], defaultChairman: 'claude-opus-4' }
          : await getJSON('/api/models');
        this.models = data.models || [];
        this.modes = data.modes || ['auto', 'quick', 'compare', 'debate'];
        this.defaultChairman = data.defaultChairman || '';
        this.form.chairman = this.defaultChairman;
      } catch (e) {
        this.modelsError = `无法加载模型列表：${e.message}`;
      }
    },
    toggleModel(name) {
      const i = this.form.models.indexOf(name);
      if (i >= 0) this.form.models.splice(i, 1);
      else this.form.models.push(name);
    },
    canSubmit() { return this.form.question.trim().length > 0 && !this.launching; },

    async submitDebate() {
      if (!this.canSubmit()) return;
      this.launching = true;
      this.launchError = '';
      try {
        if (MOCK) {
          this.launching = false;
          this.go('/watch/mock-debate-01');
          return;
        }
        const body = {
          question: this.form.question.trim(),
          mode: this.form.mode,
          models: this.form.models.length ? this.form.models : undefined,
          chairman: this.form.chairman || undefined,
          devilAdvocate: this.form.devilAdvocate || undefined,
        };
        const res = await postJSON('/api/debates', body);
        this.go(`/watch/${res.debateId}`);
      } catch (e) {
        this.launchError = `发起失败：${e.message}`;
      } finally {
        this.launching = false;
      }
    },

    // ================= 观看（实时 SSE / mock 回放）=================
    async startWatch(debateId) {
      this.debate = freshDebate();
      this.debate.id = debateId;
      const handlers = {
        onEvent: (evt) => this.applyEvent(evt),
        onState: (s) => { this.debate.conn = s; },
      };
      if (MOCK) {
        const fx = await getJSON('./dev-fixtures/debate-sample.json');
        transport = mockTransport(fx.events, handlers);
      } else {
        transport = liveTransport(debateId, handlers);
      }
    },

    applyEvent(evt) {
      const d = this.debate;
      const p = evt.data;
      switch (evt.type) {
        case 'debate_start':
          d.id = p.debateId; d.question = p.question; d.mode = p.mode; break;
        case 'phase': {
          const stop = STOP_OF_PHASE[p.phase];
          if (stop != null) d.currentStop = Math.max(d.currentStop, stop);
          if (p.phase === 'cross_examine') d.crossExamineRound += 1;
          if (p.phase === 'completed') { d.completed = true; d.currentStop = PHASE_STOPS.length - 1; }
          break;
        }
        case 'agent_start': this.upsertPanel(p.agent); break;
        case 'agent_progress': {
          const t = this.panelFor(p.agentId);
          if (t) { t.buffer += p.chunk; t._dirty = true; }
          break;
        }
        case 'agent_complete': {
          const t = this.upsertPanel(p.agent);
          t.buffer = p.result.response;
          t.result = p.result;
          t.status = 'done';
          t._dirty = true;
          break;
        }
        case 'consensus': d.consensus = p.consensus; break;
        case 'degradation': d.degradations.push(p.event); break;
        case 'result':
          d.session = p.session;
          d.completed = true;
          d.currentStop = PHASE_STOPS.length - 1;
          d.experts.forEach((e) => { e.status = 'done'; });
          break;
        case 'error':
          d.error = p.message; d.conn = 'error'; break;
      }
    },

    // 根据 AgentDTO 定位或创建面板（专家 / 评审 / 综合）。
    upsertPanel(agent) {
      const d = this.debate;
      if (agent.agentId === '__review__') {
        d.review = d.review || basePanel(agent);
        return d.review;
      }
      if (agent.agentId === '__synthesis__') {
        d.synthesis = d.synthesis || basePanel(agent);
        return d.synthesis;
      }
      let e = d.experts.find((x) => x.agentId === agent.agentId);
      if (!e) {
        e = basePanel(agent);
        d.experts.push(e);
        if (!d.activeTab) d.activeTab = e.agentId;
      }
      return e;
    },
    panelFor(agentId) {
      const d = this.debate;
      if (agentId === '__review__') return d.review;
      if (agentId === '__synthesis__') return d.synthesis;
      return d.experts.find((x) => x.agentId === agentId) || null;
    },

    // ---- 观看视图辅助（petite-vue 无 computed，用方法）----
    stopState(i) {
      const d = this.debate;
      if (d.completed) return 'done';
      if (i < d.currentStop) return 'done';
      if (i === d.currentStop) return 'active';
      return 'pending';
    },
    connLabel() {
      return {
        idle: '待机', connecting: '连接中…', live: '实时', reconnecting: '重连中…',
        closed: '已结束', error: '连接中断', 'idle ': '',
      }[this.debate.conn] || this.debate.conn;
    },
    pct(x) { return Math.round((x || 0) * 100); },
    fmtScore(x) { return (x == null ? '—' : Number(x).toFixed(1)); },
    fmtMs(ms) { return ms == null ? '' : (ms / 1000).toFixed(1) + 's'; },
    consensusTone() {
      const s = this.debate.consensus?.consensus_score ?? 0;
      return s >= 0.66 ? 'high' : s >= 0.4 ? 'mid' : 'low';
    },
    dimEntries() {
      const dim = this.debate.consensus?.dimension_scores || {};
      return Object.keys(dim).map((k) => ({ name: k, ...dim[k] }));
    },

    // ================= 历史 =================
    async loadHistory() {
      this.historyLoading = true;
      this.historyError = '';
      try {
        const data = MOCK
          ? await getJSON('./dev-fixtures/sessions-sample.json')
          : await getJSON('/api/sessions?limit=50');
        this.sessions = data.sessions || [];
      } catch (e) {
        this.historyError = `无法加载历史：${e.message}`;
      } finally {
        this.historyLoading = false;
      }
    },

    // 只读回放：复用观看视图组件，从终态 Session 重建。
    async loadReplay(id) {
      this.debate = freshDebate();
      this.debate.conn = 'closed';
      try {
        if (MOCK) {
          // mock：把录制事件瞬时喂完，得到完整静态视图。
          const fx = await getJSON('./dev-fixtures/debate-sample.json');
          fx.events.forEach((f) => this.applyEvent({ type: f.event, data: f.data }));
          this.debate.experts.forEach((e) => this.renderPanel(e));
          if (this.debate.review) this.renderPanel(this.debate.review);
          if (this.debate.synthesis) this.renderPanel(this.debate.synthesis);
        } else {
          const data = await getJSON(`/api/sessions/${encodeURIComponent(id)}`);
          this.hydrateFromSession(data.session);
        }
      } catch (e) {
        this.debate.error = `无法加载会话：${e.message}`;
      }
    },

    hydrateFromSession(s) {
      const d = this.debate;
      d.id = s.session_id; d.question = s.question; d.mode = s.resolved_mode || s.mode;
      d.completed = true; d.currentStop = PHASE_STOPS.length - 1;
      d.consensus = s.consensus || null;
      d.degradations = s.degradation_events || [];
      d.session = s;
      // 专家面板：非主席 agent，终答取自各阶段最后一次 invocation。
      const finalText = {};
      (s.stages || []).forEach((st) => (st.invocations || []).forEach((inv) => {
        finalText[inv.agent_id] = inv.response_compressed || inv.response_raw || finalText[inv.agent_id] || '';
      }));
      (s.agents || []).filter((a) => !a.is_chairman).forEach((a) => {
        const e = basePanel({
          agentId: a.agent_id, role: a.role, roleDescription: a.role_description,
          modelName: a.config?.name || '', isChairman: false, isDevilAdvocate: a.is_devil_advocate,
        });
        e.buffer = finalText[a.agent_id] || '';
        e.status = 'done';
        this.renderPanel(e);
        d.experts.push(e);
        if (!d.activeTab) d.activeTab = e.agentId;
      });
      if (s.synthesis) {
        d.synthesis = basePanel({ agentId: '__synthesis__', role: '🏛️ 主席', roleDescription: '综合结论', modelName: '', isChairman: true, isDevilAdvocate: false });
        d.synthesis.buffer = s.synthesis; d.synthesis.status = 'done';
        this.renderPanel(d.synthesis);
      }
    },

    renderPanel(panel) { panel.html = renderMarkdown(panel.buffer); panel._dirty = false; },

    // ---- 通用文本工具（模板用）----
    preview(text, n = 90) {
      const t = escapeText(text || '');
      return t.length > n ? t.slice(0, n) + '…' : t;
    },
    fmtDate(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },
  };
}

// ============ 模块级辅助（非响应式） ============
function basePanel(agent) {
  return {
    agentId: agent.agentId, role: agent.role, roleDescription: agent.roleDescription || '',
    modelName: agent.modelName || '', isChairman: !!agent.isChairman, isDevilAdvocate: !!agent.isDevilAdvocate,
    status: 'running', buffer: '', html: '', result: null, _dirty: false,
  };
}

// markdown 渲染节流：每 60ms 把 dirty 面板的 buffer 渲染为净化 HTML，
// 避免每个 chunk 都跑 marked（性能 + 防闪烁）。
function startRenderLoop(store) {
  if (renderTimer) return;
  renderTimer = setInterval(() => {
    const d = store.debate;
    if (!d) return;
    const panels = [...(d.experts || [])];
    if (d.review) panels.push(d.review);
    if (d.synthesis) panels.push(d.synthesis);
    for (const p of panels) {
      if (p._dirty) { p.html = renderMarkdown(p.buffer); p._dirty = false; }
    }
  }, 60);
}

function teardownTransport() {
  if (transport) { transport.close(); transport = null; }
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function postJSON(url, body) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
function pad(n) { return String(n).padStart(2, '0'); }

function mockModels() {
  return [
    { name: 'claude-opus-4', provider: 'anthropic', invocation: 'api', capabilities: ['reasoning'] },
    { name: 'claude-sonnet-4', provider: 'anthropic', invocation: 'api', capabilities: ['reasoning'] },
    { name: 'gpt-4o', provider: 'openai', invocation: 'api', capabilities: ['reasoning'] },
    { name: 'gemini-1.5-pro', provider: 'google', invocation: 'api', capabilities: ['long-context'] },
    { name: 'deepseek-chat', provider: 'deepseek', invocation: 'cli', capabilities: ['reasoning'] },
  ];
}
