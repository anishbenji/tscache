// The example apps under examples/ and the port `vite preview` serves each
// on. A port of its own gives each app its own origin, so its own
// SharedWorker, BroadcastChannel and mock backend.

export const apps = {
  "vanilla-uplot": 5101,
  "solid-uplot": 5102,
  "solid-lwcharts": 5103,
  "react-lwcharts": 5104,
  "react-ssr": 5105,
  "solid-ssr": 5106,
} as const;

export type App = keyof typeof apps;

export function appUrl(app: App): string {
  return `http://127.0.0.1:${apps[app]}/`;
}
