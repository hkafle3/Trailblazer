# AI disclosure

Space Apps asks teams to say where and how AI tools were used. One line per meaningful use.

| Date | Tool | What it did | Who reviewed |
|---|---|---|---|
| 2026-11-14 | Claude Code | Wrote the shared "deep space" UI layer (`web/ui.css`, `web/ui.js`): star field, constellation buttons, demo sign-in dialog, skippable tour; restyled the Explore, Comet and Guide pages; replaced the Explore headline. The design direction and reference images came from the team. | Hardik |
| 2026-11-14 | Claude Code | Second pass on the UI: restyled the patch viewer (`web/patch.css`), rebuilt the time bar, gave the Comets and Guide pages the home page's sky, renamed the app to Comet Catcher, and cut render cost (no live blur, 30 fps star field, smaller coverage canvas, one draw per frame while scrubbing). | Hardik |
