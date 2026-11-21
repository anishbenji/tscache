import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine/engine";
import { ConfigError, type ConfigErrorCode } from "../src/errors";
import { Orchestrator } from "../src/orchestrator/orchestrator";
import { deferred } from "./persist-memory-store";

const fetcherConflict: ConfigErrorCode = "fetcher-conflict";
const dataUrl = (source: string) =>
  `data:text/javascript,${encodeURIComponent(source)}`;
const fetcherSource = "export default { async fetch() {} };";
const firstModule = dataUrl(`${fetcherSource} // first`);
const otherModule = dataUrl(`${fetcherSource} // other`);

function gatedModule(tag: string) {
  const entered = deferred<void>();
  const release = deferred<void>();
  vi.stubGlobal("__m5Import", {
    entered: entered.resolve,
    wait: release.promise,
  });
  const module = dataUrl(`
    const gate = globalThis.__m5Import;
    gate.entered();
    await gate.wait;
    ${fetcherSource} // ${tag}
  `);
  return { module, entered: entered.promise, release: release.resolve };
}

afterEach(() => vi.unstubAllGlobals());

async function expectConflict(
  orchestrator: Orchestrator,
  currentModule: string,
): Promise<void> {
  const refusal = orchestrator.load({ module: otherModule });
  await expect(refusal).rejects.toBeInstanceOf(ConfigError);
  await expect(refusal).rejects.toHaveProperty("name", "ConfigError");
  await expect(refusal).rejects.toHaveProperty(
    "message",
    `this worker already runs fetcher ${currentModule}; cannot also load ${otherModule}`,
  );
  await expect(refusal).rejects.toHaveProperty("code", fetcherConflict);
}

describe("M5 §6 test 35: Orchestrator.load refusal identity", () => {
  it("35: a different module is refused with fetcher-conflict after the first loads", async () => {
    const orchestrator = new Orchestrator(new Engine(), () => {});
    await orchestrator.load({ module: firstModule });
    await expectConflict(orchestrator, firstModule);
  });

  it("35: a different module is refused with fetcher-conflict while the first loads", async () => {
    const orchestrator = new Orchestrator(new Engine(), () => {});
    const gate = gatedModule("conflict");
    const loading = orchestrator.load({ module: gate.module });
    try {
      await gate.entered;
      await expectConflict(orchestrator, gate.module);
    } finally {
      gate.release();
      await loading;
    }
  });

  it("35: callers naming the same module share the pending load and both answer", async () => {
    const orchestrator = new Orchestrator(new Engine(), () => {});
    const gate = gatedModule("shared");
    const first = orchestrator.load({ module: gate.module });
    await gate.entered;
    const answered = vi.fn();
    const second = orchestrator.load({ module: gate.module }).then(answered);
    try {
      await Promise.resolve();
      expect(answered).not.toHaveBeenCalled();
    } finally {
      gate.release();
      await Promise.all([first, second]);
    }
    expect(answered).toHaveBeenCalledTimes(1);
    await expect(
      orchestrator.load({ module: gate.module }),
    ).resolves.toBeUndefined();
  });

  it("35: a failed module load leaves the slot free for another module", async () => {
    const orchestrator = new Orchestrator(new Engine(), () => {});
    const broken = dataUrl('throw new Error("bad fetcher");');
    await expect(orchestrator.load({ module: broken })).rejects.toThrow(
      "bad fetcher",
    );
    await expect(
      orchestrator.load({ module: otherModule }),
    ).resolves.toBeUndefined();
  });

  it.each([
    {
      kind: "an invalid memory budget",
      run: () => new Engine({ memoryBudget: -1 }),
    },
    {
      kind: "a conflicting cache structure",
      run: () => {
        const engine = new Engine();
        const config = {
          id: "persist",
          interval: 1,
          fields: { value: "f64" },
        } as const;
        engine.cache(config);
        engine.cache({ ...config, interval: 2 });
      },
    },
  ])("35: ConfigError has no code for $kind", ({ run }) => {
    let thrown: unknown;
    try {
      run();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).code).toBeUndefined();
  });
});
