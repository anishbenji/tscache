// Candles across tabs: every tab of the origin charts the same candles
// through one SharedWorker, so history one tab fetched is never fetched for
// another; an expired access token is refreshed once for all tabs; and when
// the tab hosting the worker crashes, the others connect a new client.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { type Auth, useAuth } from "./auth";
import { CandleChart } from "./Chart";
import { useCandles } from "./candles";
import { useClient } from "./client";
import { useLog } from "./log";
import { Panel } from "./Panel";
import "./style.css";

function SessionLost({ auth }: { auth: Auth }) {
  if (auth.status !== "lost") return null;
  return (
    <p className="lost" role="alert">
      Session lost: the tokens could not be refreshed.{" "}
      <button type="button" onClick={() => void auth.signInAgain()}>
        Sign in again
      </button>
    </p>
  );
}

function Log() {
  const entries = useLog();
  return (
    <ol id="log" reversed>
      {entries.map((entry) => (
        <li key={entry.id}>{entry.text}</li>
      ))}
    </ol>
  );
}

function App() {
  const client = useClient();
  const auth = useAuth(client);
  const frame = useCandles(client, auth.answered);
  const ready = frame !== undefined && frame.client === client;
  return (
    <>
      <header>
        <h1>ACME · 5-minute candles</h1>
        <p className="lede">The last three days, refreshed every 5 seconds.</p>
      </header>
      <p className="stats">
        <output data-testid="status">{ready ? "ready" : "connecting"}</output> ·
        auth{" "}
        <output data-testid="auth">
          {auth.status === "ok" ? "ok" : "pending"}
        </output>{" "}
        · bars{" "}
        <output data-testid="bars">
          {frame?.result.timestamps.length ?? 0}
        </output>{" "}
        · updated{" "}
        <output data-testid="updated">
          {frame ? new Date(frame.at).toLocaleTimeString() : "never"}
        </output>
      </p>
      <SessionLost auth={auth} />
      <CandleChart result={frame?.result} />
      <Panel mode={client?.mode} heard={auth.heard} />
      <h2>Log</h2>
      <Log />
    </>
  );
}

const root = document.querySelector("#root");
if (root === null) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
