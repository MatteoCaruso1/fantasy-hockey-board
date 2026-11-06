// A minimal `process` for the browser build: no arguments, and exit() throws so a failed step
// stops cleanly instead of closing the page.
if (typeof globalThis.process === 'undefined' || !globalThis.process.versions?.node) {
  globalThis.process = {
    argv: ['node', 'board'], env: {}, platform: 'browser', versions: {},
    cwd: () => '/app',
    exit: (code) => { throw new Error(`step stopped (exit ${code})`); },
    on: () => {}, stdout: { write: (s) => console.log(String(s).trimEnd()) }, stderr: { write: (s) => console.warn(String(s).trimEnd()) },
  };
}
