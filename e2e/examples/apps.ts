// The example apps under examples/, the reference clients under
// reference/, and the port `vite preview` serves each on. A port of its own gives each app its own origin, so its own
// SharedWorker, BroadcastChannel and mock backend.

export const apps = {
  "vanilla-uplot": 5101,
  "solid-uplot": 5102,
  "solid-lwcharts": 5103,
  "react-lwcharts": 5104,
  "react-ssr": 5105,
  "solid-ssr": 5106,
  "reference-vanilla": 5201,
  "reference-react": 5202,
  "reference-solid": 5203,
} as const;

export type App = keyof typeof apps;

export function appUrl(app: App): string {
  return `http://127.0.0.1:${apps[app]}/`;
}

/** The app's directory from the repository root. */
export function appDir(app: App): string {
  return app.startsWith("reference-")
    ? `reference/${app.slice("reference-".length)}`
    : `examples/${app}`;
}
