// Vite's `?url` asset import, as used for the libheif wasm binary in
// bitmap-worker.js: resolves to the served asset's URL string.
declare module "*.wasm?url" {
  const url: string;
  export default url;
}
