# QC Note Builder App

A small React/Vite app for generating semicolon-separated QC review notes from a configurable set of sections.

## Run locally

1. Open a terminal in `qc-notes-builder-app`
2. Install dependencies with `npm install`
3. Start the app with `npm run dev`

## Config

- Default sections live in `public/config.json`
- The app loads that file at runtime
- `Manage Config` lets you:
  - edit section labels and helper text
  - switch sections between single-select and multi-select
  - add, remove, and reorder sections
  - add, remove, and reorder options
  - change the generated note text for each option

## Saving changes

- `Save in Browser` stores the current config in local storage on this machine
- `Download config.json` exports the current config so it can become the new default file
- `Reset to Workbook Defaults` reloads the original config from `public/config.json`

## Share on Vercel

This app is ready to deploy as a static Vite site on Vercel.

### Recommended repo setup

- Best option: create a dedicated repository for `qc-notes-builder-app`
- Alternate option: keep it in a larger repository and set the Vercel Root Directory to `qc-notes-builder-app`

### Deploy steps

1. Push this app folder to GitHub
2. In Vercel, create a new project from that repository
3. If the repository contains other folders, set the Root Directory to `qc-notes-builder-app`
4. Let Vercel auto-detect Vite
5. Deploy

### Notes

- `vercel.json` includes a rewrite to `index.html` so SPA-style routing keeps working if you add client-side routes later
- Browser-saved config changes are local to each person unless you replace `public/config.json` and redeploy
