// In-page harness for the refresh snippet (auth-refresh.js). Stand-in
// clients share one token store and one Web Lock, as tabs of one origin
// would, and their updateAuth answers only when the scenario says so, so a
// scenario can deliver authInvalid events, each naming the refused token,
// in any order a real port could.

import { refreshOnAuthInvalid } from "/auth-refresh.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness({ tokens, failSave = () => false }) {
  const lockName = `refresh-harness-${crypto.randomUUID()}`;
  const store = { tokens };
  const log = { refreshed: [], updates: [], lost: [] };
  const answers = [];

  function tab(name) {
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
      accessOf: (context) => context.token,
      onSessionLost: () => log.lost.push(name),
      lockName,
    });
    // Delivers authInvalid for a refusal of `token`.
    return (token) => {
      const event = {
        error: { name: "AuthInvalidError", message: "refused" },
        context: { token },
      };
      for (const handler of handlers) handler(event);
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
    emit("at-0");
    emit("at-1");
    await h.drain();
    emit("at-2");
    await h.drain();
    return h.log;
  },

  // A refusal of the token just handed over, arriving while the recovery's
  // updateAuth is unanswered, is acted on.
  async refusalDuringUpdate() {
    const h = harness({ tokens: { access: "at-0", refresh: "rt-0" } });
    const emit = h.tab("a");
    emit("at-0");
    await h.until(() => h.log.updates.length > 0);
    emit("at-x1");
    await h.drain();
    return h.log;
  },

  // A refusal of the first pair arrives after the tab refreshed and adopted
  // the second (an event from before its update, delivered late): nothing
  // is rotated again.
  async lateStaleEvent() {
    const h = harness({ tokens: { access: "at-0", refresh: "rt-0" } });
    const emit = h.tab("a");
    emit("at-0");
    await h.drain();
    emit("at-0");
    await h.drain();
    return h.log;
  },

  // Two tabs hear the same refusal: one refreshes, the other adopts.
  async twoTabsOneRefusal() {
    const h = harness({ tokens: { access: "at-0", refresh: "rt-0" } });
    const emitA = h.tab("a");
    const emitB = h.tab("b");
    emitA("at-0");
    emitB("at-0");
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
    emitA("at-0");
    emitB("at-0");
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
    emit("at-0");
    await h.drain();
    return { ...h.log, stored: h.store.tokens };
  },
};
