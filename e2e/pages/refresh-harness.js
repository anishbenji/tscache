// In-page harness for the refresh snippet (auth-refresh.js). Stand-in
// clients share one token store and one Web Lock, as tabs of one origin
// would, and their updateAuth answers only when the scenario says so, so a
// scenario can deliver authInvalid events in any order a real port could.

import { refreshOnAuthInvalid } from "/auth-refresh.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness({ tokens, failSave = () => false }) {
  const lockName = `refresh-harness-${crypto.randomUUID()}`;
  const store = { tokens };
  const log = { refreshed: [], updates: [], lost: [] };
  const answers = [];

  function tab(name, access = store.tokens.access) {
    const handlers = [];
    const client = {
      on: (_event, fn) => {
        handlers.push(fn);
        return () => {};
      },
      updateAuth: (context) => {
        log.updates.push(`${name}:${context.token}`);
        return new Promise((resolve) => answers.push(resolve));
      },
    };
    refreshOnAuthInvalid(client, {
      access,
      load: async () => store.tokens,
      save: async (next) => {
        if (failSave(next)) throw new Error("storage full");
        store.tokens = next;
      },
      refresh: async (token) => {
        log.refreshed.push(token);
        const n = log.refreshed.length;
        return { access: `at-x${n}`, refresh: `rt-x${n}` };
      },
      toContext: (token) => ({ token }),
      onSessionLost: () => log.lost.push(name),
      lockName,
    });
    return () => {
      for (const handler of handlers) handler();
    };
  }

  // Answers every update until no recovery holds or awaits the lock.
  async function drain() {
    for (;;) {
      for (const answer of answers.splice(0)) answer();
      const { held = [], pending = [] } = await navigator.locks.query();
      if (![...held, ...pending].some((lock) => lock.name === lockName)) {
        return;
      }
      await tick();
    }
  }

  async function until(done) {
    while (!done()) await tick();
  }

  return { store, log, tab, drain, until };
}

export const scenarios = {
  // A busy tab receives the events of two recoveries another tab already
  // completed (the tokens moved from the first pair to the third), then a
  // refusal of the pair it adopted.
  async queuedStaleEvents() {
    const h = harness({ tokens: { access: "at-0", refresh: "rt-0" } });
    const emit = h.tab("a");
    h.store.tokens = { access: "at-2", refresh: "rt-2" };
    emit();
    emit();
    await h.drain();
    emit();
    await h.drain();
    return h.log;
  },

  // A refusal that arrives while the recovery's updateAuth is unanswered is
  // acted on: it may concern the token just handed over.
  async refusalDuringUpdate() {
    const h = harness({ tokens: { access: "at-0", refresh: "rt-0" } });
    const emit = h.tab("a");
    emit();
    await h.until(() => h.log.updates.length > 0);
    emit();
    await h.drain();
    return h.log;
  },

  // The tab was created with the first pair, but another tab refreshed
  // before this one installed the snippet; the refusal is about the first
  // pair, so the tab adopts the current one.
  async installedAfterRefresh() {
    const h = harness({ tokens: { access: "at-1", refresh: "rt-1" } });
    const emit = h.tab("a", "at-0");
    // The event comes long after the install.
    await tick();
    emit();
    await h.drain();
    return h.log;
  },

  // The new tokens cannot be stored after the refresh token was spent: the
  // tab waiting behind the lock must not present the spent token again.
  async saveFailsAfterRefresh() {
    const h = harness({
      tokens: { access: "at-0", refresh: "rt-0" },
      failSave: (next) => next.refresh !== null,
    });
    const emitA = h.tab("a");
    const emitB = h.tab("b");
    emitA();
    emitB();
    await h.drain();
    return { ...h.log, stored: h.store.tokens };
  },

  // Nothing can be stored at all: the refresh token is never spent.
  async storageUnavailable() {
    const h = harness({
      tokens: { access: "at-0", refresh: "rt-0" },
      failSave: () => true,
    });
    const emit = h.tab("a");
    emit();
    await h.drain();
    return { ...h.log, stored: h.store.tokens };
  },
};
