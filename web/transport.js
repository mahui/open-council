// 事件传输抽象：真实 SSE 与 fixture 回放共用同一出口，
// 使得观看页组件对"实时 / mock"无感知（决策 2 + fixture 驱动开发）。
//
// 两种实现都向回调交付统一形状：
//   onEvent({ type, data })   —— 与 §4 DebateEvent 一一对应
//   onState(state)            —— 'connecting' | 'live' | 'reconnecting' | 'closed' | 'error'
//
// 终态事件（result / error）由调用方主动 close()，避免 EventSource 自动重连。

const TERMINAL = new Set(['result', 'error']);

/** 真实 SSE 传输。EventSource 原生断线重连 + Last-Event-ID 回放（决策 3）。 */
export function liveTransport(debateId, { onEvent, onState }) {
  const url = `/api/debates/${encodeURIComponent(debateId)}/events`;
  let es = null;
  let closed = false;

  const open = () => {
    // EventSource 重连时浏览器自动带上 Last-Event-ID，服务端据此回放缺失事件。
    es = new EventSource(url);
    onState('connecting');

    es.onopen = () => { if (!closed) onState('live'); };

    // 服务端为每个事件写了具名 event:，逐类型监听。
    for (const type of ['debate_start', 'phase', 'agent_start', 'agent_progress',
      'agent_complete', 'consensus', 'degradation', 'result', 'error']) {
      es.addEventListener(type, (e) => {
        if (closed) return;
        let data;
        try { data = JSON.parse(e.data); } catch { return; }
        onEvent({ type, data });
        if (TERMINAL.has(type)) close();
      });
    }

    es.onerror = () => {
      if (closed) return;
      // EventSource 在 CONNECTING 时会自动重连；CLOSED 说明服务端结束或 404。
      if (es.readyState === EventSource.CLOSED) {
        onState('error');
      } else {
        onState('reconnecting');
      }
    };
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (es) es.close();
    onState('closed');
  };

  open();
  return { close };
}

/**
 * Fixture 回放传输。?mock=1 时使用：从录制的事件序列按各帧 delay 回放，
 * 复现流式节奏，无需真 server。这是 UI 调试利器。
 */
export function mockTransport(frames, { onEvent, onState }) {
  let closed = false;
  let timer = null;
  let i = 0;

  onState('connecting');

  const step = () => {
    if (closed || i >= frames.length) {
      if (!closed) onState('closed');
      return;
    }
    const frame = frames[i++];
    if (i === 1) onState('live');
    onEvent({ type: frame.event, data: frame.data });
    if (TERMINAL.has(frame.event)) { onState('closed'); return; }
    const delay = Math.max(0, frame.delay ?? 40);
    timer = setTimeout(step, delay);
  };

  // 首帧稍作停顿，让"connecting"可见。
  timer = setTimeout(step, 120);

  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    onState('closed');
  };

  return { close };
}
