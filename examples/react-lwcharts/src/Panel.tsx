// The multi-tab panel: what this tab saw of every tab's fetches and of the
// token recovery, next to the backend's own counters. Open a second tab and
// both count the same fetches, because one SharedWorker serves them all.

import { onFetchNotice } from "@examples/mock-backend/notices";
import { useEffect, useState } from "react";
import type { HostingMode } from "tscache";
import { log, message } from "./log";

/** The fields of the backend's GET /api/stats this page shows. */
interface AuthStats {
  refreshes: number;
  reused: number;
  refused: number;
}

const moment = (t: number) =>
  new Date(t).toLocaleString([], { dateStyle: "short", timeStyle: "short" });

/** Fetch notices from every tab's worker since this page opened. */
function useFetchCount(): number {
  const [count, setCount] = useState(0);
  useEffect(
    () =>
      onFetchNotice(({ cacheId, range, pages, outcome }) => {
        setCount((n) => n + 1);
        const span = `${moment(range.start)} – ${moment(range.end)}`;
        log(`fetched ${cacheId} ${span}: ${outcome}, ${pages} page(s)`);
      }),
    [],
  );
  return count;
}

function useBackendStats(): AuthStats | undefined {
  const [stats, setStats] = useState<AuthStats>();
  useEffect(() => {
    let mounted = true;
    const read = async () => {
      const response = await fetch("/api/stats");
      const next = (await response.json()) as AuthStats;
      if (mounted) setStats(next);
    };
    // A failed read keeps the last counters; the next second tries again.
    const tick = () => void read().catch(() => {});
    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);
  return stats;
}

async function expireAccess(): Promise<void> {
  try {
    await fetch("/api/control", {
      method: "POST",
      body: JSON.stringify({ expireAccess: true }),
    });
    log("the backend replaced the access token; the refresh token still works");
  } catch (error) {
    log(`could not expire the token: ${message(error)}`);
  }
}

export function Panel({
  mode,
  heard,
}: {
  mode: HostingMode | undefined;
  heard: number;
}) {
  const fetches = useFetchCount();
  const stats = useBackendStats();
  return (
    <section className="panel" aria-labelledby="tabs-heading">
      <h2 id="tabs-heading">Tabs and tokens</h2>
      <p className="stats">
        Mode <output data-testid="mode">{mode ?? "…"}</output> · backend fetches
        seen <output data-testid="fetches">{fetches}</output> · authInvalid
        heard <output data-testid="authInvalid">{heard}</output>
      </p>
      <p className="stats">
        Backend: token refreshes{" "}
        <output data-testid="refreshes">{stats?.refreshes ?? "…"}</output> ·
        reused refresh tokens{" "}
        <output data-testid="reused">{stats?.reused ?? "…"}</output> · refused
        requests <output data-testid="refused">{stats?.refused ?? "…"}</output>
      </p>
      <p className="actions">
        <button type="button" onClick={() => window.open(location.href)}>
          Open another tab
        </button>
        <button type="button" onClick={() => void expireAccess()}>
          Expire access token
        </button>
      </p>
    </section>
  );
}
