// What an app's bundler declares for these imports. Vite's client types
// declare `?worker&url`; `?fetcher` is tscache/vite's (the worker setup
// guide).
declare module "*?worker&url" {
  const url: string;
  export default url;
}
declare module "*?fetcher" {
  const url: string;
  export default url;
}
