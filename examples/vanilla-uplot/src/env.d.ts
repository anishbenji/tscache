// `?fetcher` imports, served by tscache's fetcherUrl plugin
// (tscache/vite).
declare module "*?fetcher" {
  const url: string;
  export default url;
}
