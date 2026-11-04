// `?fetcher` imports, served by tscache's fetcherUrl plugin
// (@anishbenji/tscache/vite).
declare module "*?fetcher" {
  const url: string;
  export default url;
}
