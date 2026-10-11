// The example apps under examples/ and the port `vite preview` serves each
// on. A port of its own gives each app its own origin, so its own
// SharedWorker, BroadcastChannel and mock backend.

export const apps = {
  "vanilla-uplot": 5101,
  "solid-uplot": 5102,
} as const;

export type App = keyof typeof apps;

export function appUrl(app: App): string {
  return `http://127.0.0.1:${apps[app]}/`;
}
