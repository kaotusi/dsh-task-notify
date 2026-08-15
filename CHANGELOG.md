# Changelog

## 0.2.0 — 2026-08-16

- feat: dedupe OS notification pushes via localStorage (refresh / extra tabs no longer re-bomb historical unread items)
- feat: reconcile panel against the host snapshot (ghosts vanish after another tab clears or the host restarts)
- feat: skip polling while the tab is hidden; poll immediately on returning to the foreground
- feat: budget at most 3 new OS pushes per poll round
- feat: `ntfy_status` reports staleness (older than two minutes)
- feat: `subagent/end` notifications carry the child session id and an output summary
- fix: panel keeps server order (newest first)
- fix: mount diagnostic failure path is now reachable
- fix: widen `zod` peer range to `^3.0.0 || ^4.0.0` (DSH rc.6 installs zod 4.4.3)
- fix: declare `sideEffects` for the client entry
- test: node:test suites for client and host (19 tests), `npm test`

## 0.1.0 — 2026-08-14

- Initial release: approval requests, awaited replies, and finished background jobs / subagents / workflows pushed to the OS notification center with chimes, plus an in-app bell panel, toasts, and a clear button.
