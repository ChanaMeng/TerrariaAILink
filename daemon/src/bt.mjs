export const FAILURE = 'failure';
export const RUNNING = 'running';

export const action = (fn) => ({ tick: (ctx) => fn(ctx) });
export const condition = (fn) => ({ tick: (ctx) => (fn(ctx) ? SUCCESS : FAILURE) });

export function sequence(...nodes) {
  let i = 0;
  return {
    tick(ctx) {
      while (i < nodes.length) {
        const r = nodes[i].tick(ctx);
        if (r !== SUCCESS) return r;
        i++;
      }
      i = 0;
      return SUCCESS;
    },
    reset() { i = 0; },
  };
}

export function selector(...nodes) {
  let i = 0;
  return {
    tick(ctx) {
      while (i < nodes.length) {
        const r = nodes[i].tick(ctx);
        if (r !== FAILURE) return r;
        i++;
      }
      i = 0;
      return FAILURE;
    },
    reset() { i = 0; },
  };
}

export const inverter = (node) => ({
  tick: (ctx) => {
    const r = node.tick(ctx);
    return r === SUCCESS ? FAILURE : r === FAILURE ? SUCCESS : RUNNING;
  },
});

export const alwaysSucceed = (node) => ({
  tick: (ctx) => { node.tick(ctx); return SUCCESS; },
});

export function wait(ms, result = SUCCESS) {
  let until = 0;
  return {
    tick(ctx) {
      const now = ctx.now ?? Date.now();
      if (!until) until = now + ms;
      if (now >= until) { until = 0; return result; }
      return RUNNING;
    },
    reset() { until = 0; },
  };
}

export function cooldown(ms, node) {
  let readyAt = 0;
  return {
    tick(ctx) {
      const now = ctx.now ?? Date.now();
      if (now < readyAt) return FAILURE;
      const r = node.tick(ctx);
      if (r === SUCCESS) readyAt = now + ms;
      return r;
    },
  };
}

export function repeat(node, times = Infinity) {
  let n = 0;
  return {
    tick(ctx) {
      if (n >= times) { n = 0; return SUCCESS; }
      const r = node.tick(ctx);
      if (r === SUCCESS) n++;
      if (r === FAILURE) { n = 0; return FAILURE; }
      return n >= times ? SUCCESS : RUNNING;
    },
  };
}


