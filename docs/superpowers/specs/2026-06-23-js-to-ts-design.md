# JS → TypeScript Conversion Design

**Date:** 2026-06-23  
**Project:** hpam-translation-server  
**Scope:** Convert all JS source files (server + frontend) to TypeScript with esbuild bundling for the browser.

---

## Approach

In-place conversion: rename `.js` → `.ts` in their existing directories. No files move. Git history is preserved on the files. esbuild compiles frontend TS to `public/dist/`; tsc compiles the server to `dist/server/`.

---

## File Structure Changes

```
hpam-translation/
├── package.json            ← updated: new scripts + new deps
├── tsconfig.json           ← NEW: root tsconfig for frontend (browser, noEmit)
├── server/
│   ├── index.ts            ← renamed from index.js
│   └── tsconfig.json       ← NEW: server tsconfig (CommonJS, outDir: ../dist/server)
└── public/
    ├── index.html          ← updated: /src/index.js → /dist/index.js
    ├── translator.html     ← updated: remove CDN socket.io tag, /src/translator.js → /dist/translator.js
    ├── listener.html       ← updated: remove CDN socket.io tag, /src/listener.js → /dist/listener.js
    ├── src/
    │   ├── index.ts        ← renamed from index.js
    │   ├── translator.ts   ← renamed from translator.js
    │   └── listener.ts     ← renamed from listener.js
    └── dist/               ← NEW: esbuild output (gitignored)
        ├── index.js
        ├── translator.js
        └── listener.js
```

`public/dist/` is added to `.gitignore` — it is build output, not source.

---

## TypeScript Configuration

### Root `tsconfig.json` (frontend)

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "lib": ["DOM", "ES2020"],
    "strict": true,
    "noEmit": true,
    "moduleResolution": "bundler"
  },
  "include": ["public/src"]
}
```

- `noEmit: true` — esbuild handles transpilation; tsc is type-check only for the frontend.
- `lib: ["DOM"]` — gives access to WebRTC types, Canvas API, MediaDevices, etc.
- `strict: true` — catches null/undefined issues across all frontend code.

### `server/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "lib": ["ES2020"],
    "strict": true,
    "outDir": "../dist/server",
    "rootDir": "."
  },
  "include": ["."]
}
```

- `module: "CommonJS"` — matches existing `require()` style; Node.js compatible.
- `outDir: "../dist/server"` — server output lands at `dist/server/index.js`.

---

## Dependencies

### New devDependencies
| Package | Purpose |
|---|---|
| `typescript` | TypeScript compiler |
| `ts-node` | Run server TS directly in dev without pre-compiling |
| `@types/node` | Node.js built-in types (http, path, process, etc.) |
| `@types/express` | Express types |
| `esbuild` | Frontend bundler (TS → JS for browser) |
| `concurrently` | Run server + esbuild watcher in parallel during dev |

### New dependencies
| Package | Purpose |
|---|---|
| `socket.io-client` | Bundled into frontend by esbuild; ships its own TS types |

**Note:** socket.io-client is moved from CDN to npm. The two `<script src="https://cdn.socket.io/...">` tags are removed from `translator.html` and `listener.html`. esbuild bundles socket.io-client directly into each output file.

---

## Scripts

```json
"scripts": {
  "build":     "tsc -p server/tsconfig.json && esbuild public/src/index.ts public/src/translator.ts public/src/listener.ts --bundle --outdir=public/dist --minify",
  "dev":       "concurrently \"nodemon --exec ts-node server/index.ts\" \"esbuild public/src/index.ts public/src/translator.ts public/src/listener.ts --bundle --outdir=public/dist --watch\"",
  "start":     "node dist/server/index.js",
  "typecheck": "tsc --noEmit && tsc -p server/tsconfig.json --noEmit"
}
```

- `dev` — nodemon watches server TS and restarts via ts-node; esbuild rebuilds frontend on file save.
- `build` — production: compiles server, bundles + minifies all 3 frontend entry points.
- `start` — runs compiled production server (requires `npm run build` first).
- `typecheck` — validates both frontend and server types without emitting any files.

---

## Types Added Per File

### `server/index.ts`
- `Room` interface: `{ translator: string | null; listeners: Set<string> }`
- `rooms` typed as `Record<string, Room>`
- Socket event handler parameters typed inline (payload shapes for `translator:join`, `listener:join`, `signal:offer`, `signal:answer`, `signal:ice`)

### `public/src/translator.ts`
- `peers` → `Record<string, RTCPeerConnection>`
- `localStream` → `MediaStream | null`
- `socket` → `ReturnType<typeof io> | null`
- `iceServers` → `RTCIceServer[]`
- All DOM refs typed with specific HTML element types (`HTMLButtonElement`, `HTMLSelectElement`, `HTMLElement`, `NodeListOf<HTMLElement>`)

### `public/src/listener.ts`
- `peerConn` → `RTCPeerConnection | null`
- `socket` → `ReturnType<typeof io> | null`
- `audioEl` → `HTMLAudioElement | null`
- `iceServers` → `RTCIceServer[]`
- Canvas typed as `HTMLCanvasElement` / `CanvasRenderingContext2D`
- Volume slider typed as `HTMLInputElement`

### `public/src/index.ts`
- `badge` → `HTMLElement`
- `liveText` → `HTMLElement`
- Fetch response typed with inline interface `{ live: boolean; listeners: number }`

No shared types file — all types are simple enough to live inline in each file.

---

## Error Handling

- Strict null checks will surface existing nullable DOM queries (`getElementById` returns `HTMLElement | null`). These will be handled with non-null assertions (`!`) where the element is guaranteed by the HTML, or proper null guards where appropriate.
- The existing optional chaining (`peers[from]?.setRemoteDescription`) already satisfies strict null checks.

---

## What Does Not Change

- All runtime behavior remains identical.
- HTML markup, CSS, and all UI logic are unchanged.
- Server socket event names and signaling protocol are unchanged.
- `.env` / TURN credential handling is unchanged.
- PWA manifest and service worker (if any) are unchanged.