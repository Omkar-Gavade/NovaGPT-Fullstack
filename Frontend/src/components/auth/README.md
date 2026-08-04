# Auth experience

Concept: **"Access Console over a live Model Constellation"** — one immersive,
centered experience (not a split SaaS login). The 11 models orbit a pulsing
NovaGPT core on a cursor-reactive canvas; a focused glass console sits on top.

## Files
- `pages/AuthPage.jsx` — the console: mode state (`login` / `register` / `forgot`),
  Firebase calls, inline validation, staggered entrance, `⌘↵` submit.
- `components/auth/AuthConstellation.jsx` — the signature canvas backdrop.
  11 nodes (from `data/models.js`) + core + edges, DPR-capped, cancels rAF on
  unmount, static frame under `prefers-reduced-motion`.
- `styles/auth.css` — stage, veil, console, fields, banners. 100% design tokens.

## Preserved auth logic (Firebase)
`signInWithEmailAndPassword`, `createUserWithEmailAndPassword`,
`signInWithPopup(googleProvider)`, `sendPasswordResetEmail`; all redirect to
`/chat` on success. Errors mapped to friendly copy in `prettyError()`.

## Accessibility
Labels tied to inputs via `htmlFor`/`id`; `aria-invalid` + `aria-describedby`
on error; onBlur validation (skips empty); visible focus rings; reduced-motion
honored; theme-aware contrast (WCAG AA).

## Add an auth mode
Add an entry to `COPY`, branch fields on `mode`, and wire the Firebase call in
`submit()`. No layout changes needed — the console adapts.
