# AI disclosure

Space Apps asks teams to say where and how AI tools were used. One line per meaningful use.

| Date | Tool | What it did | Who reviewed |
|---|---|---|---|
| 2026-11-14 | Claude Code | Wrote the shared "deep space" UI layer (`web/ui.css`, `web/ui.js`): star field, constellation buttons, demo sign-in dialog, skippable tour; restyled the Explore, Comet and Guide pages; replaced the Explore headline. The design direction and reference images came from the team. | Hardik |
| 2026-11-14 | Claude Code | Second pass on the UI: restyled the patch viewer (`web/patch.css`), rebuilt the time bar, gave the Comets and Guide pages the home page's sky, renamed the app to Comet Catcher, and cut render cost (no live blur, 30 fps star field, smaller coverage canvas, one draw per frame while scrubbing). | Hardik |
| 2026-11-14 | Claude Code | Third UI pass: the guide is now a notebook that opens over any page (`web/ui.js`, `web/ui.css`), softer constellation outlines, uneven rounded panel corners, tooltip and phone top bar fixes. | Hardik |
| 2026-11-14 | Claude Code | Fourth UI pass: fixed a stray CSS selector that threw disabled buttons to the top-left, play/pause icon, dotted comet trails on the map (illustrative for example comets), faster sky-photo loading with a placeholder, where-it-is map on example comet pages, removed the hero eyebrow, tidied the guide and button outlines. | Hardik |
| 2026-11-15 | Codex (OpenAI, image generation) | Generated the Trailblazer mark from a written brief (comet with stars); one of four options picked by the team, then cut to the comet and stars on a transparent background in code. Used as the site icon (`web/favicon.ico`, `web/apple-touch-icon.png`, `web/img/mark-*.png`). | Ed |
