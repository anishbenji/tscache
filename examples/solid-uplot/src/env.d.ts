// `?fetcher` imports, served by the fetcherUrl plugin of
// @examples/mock-backend/vite.
declare module "*?fetcher" {
  const url: string;
  export default url;
}
