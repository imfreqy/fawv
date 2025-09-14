# PermaVault Starter (Vite + React + Tailwind + shadcn/ui + Lucide)

A ready-to-run starter for macOS with Vite, React, Tailwind CSS, shadcn/ui Button, and Lucide icons.

## Prereqs
- Node.js 18+ (use `nvm` on macOS)
- npm (or pnpm/yarn)

## Quickstart
```bash
npm install
npm run dev
```
Open http://localhost:5173

## What's included
- Vite + React + TypeScript
- Tailwind CSS preconfigured
- `shadcn/ui`-style `Button` component (local, no generator needed)
- Lucide icons (`lucide-react`)
- Path alias `@` -> `src`
- Minimal landing UI

## Add more shadcn/ui components
This starter includes only `Button`. To add more:
- Install generator: `npx shadcn-ui@latest init`
- Generate components: `npx shadcn-ui@latest add card input ...`

## Scripts
- `npm run dev` — start dev server
- `npm run build` — typecheck and build
- `npm run preview` — preview the production build

Enjoy!
