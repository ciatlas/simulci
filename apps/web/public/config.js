// The host's mode, which src/app/config.ts reads once the app boots. This is the static host's (Vercel, `vite
// preview`): no server, anonymous reads of github.com. The container image serves its own /config.js in its place, in
// the same shape, so one build serves every host.
globalThis.simulciConfig = { mode: 'static', githubUrl: 'https://github.com' };
