// The tab's tscache client, as React state. When the worker behind it is
// lost, as when the tab hosting the SharedWorker crashes, the client is
// replaced by a new one, which starts a new worker with an empty cache
// (docs/guides/worker-setup.md). Everything built on the client (the
// refresh snippet, the cache, the polling) depends on this state and is
// rebuilt by its own effect.

import fetcherModule from "@examples/mock-backend/fetcher?fetcher";
import { useEffect, useState } from "react";
import { createClient, type TscacheClient } from "tscache";
import workerUrl from "tscache/worker?worker&url";
import { log, message } from "./log";
import { currentTokens, toContext } from "./tokens";

async function connect(): Promise<TscacheClient> {
  const { access } = await currentTokens();
  return createClient({
    workerUrl,
    fetcher: { module: fetcherModule, context: toContext(access) },
  });
}

/** The connected client; undefined while connecting or reconnecting. */
export function useClient(): TscacheClient | undefined {
  const [client, setClient] = useState<TscacheClient>();
  useEffect(() => {
    let mounted = true;
    let current: TscacheClient | undefined;
    const start = () => {
      connect().then(
        (next) => {
          if (!mounted) return void next.dispose();
          current = next;
          log(`client connected (${next.mode})`);
          next.on("workerLost", ({ reason }) => {
            log(`worker lost (${reason}); connecting a new client`);
            setClient(undefined);
            start();
          });
          setClient(next);
        },
        (error) => log(`could not connect: ${message(error)}`),
      );
    };
    start();
    return () => {
      mounted = false;
      void current?.dispose();
    };
  }, []);
  return client;
}
