// node:url for the browser build: the scripts locate their own folder from import.meta.url,
// which the build rewrites to file:///app/<path of the script>.
export const fileURLToPath = (u) => decodeURIComponent((u instanceof URL ? u : new URL(u)).pathname);
export const pathToFileURL = (p) => new URL('file://' + p);
const _URL = globalThis.URL;
export { _URL as URL };
export default { fileURLToPath, pathToFileURL, URL: _URL };
