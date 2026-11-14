Generate 6 concept images (PNG, 16:9, 1920x1080) of screens from one web app, using your image generation tool. Save them in this folder with exactly these names: 10-explore.png, 11-unexplored-heatmap.png, 12-patch-viewer.png, 13-label-popup.png, 14-comet-page.png, 15-guide.png. Do not write any code. When done, list the six file paths.

The app is called "Comet Hunt". It is a public website where anyone can help find comets in real infrared images from NASA's SPHEREx space telescope. SPHEREx photographs the sky one square patch at a time and photographs the same patch again a few hours later. A comet moves between those two photos while the stars stay still. People look through patches, label moving dots (comet, asteroid, glitch), and discuss each comet in a comment thread. The labels build a community log of comets.

Style for all six, matching earlier images: dark, calm, scientific, like a polished planetarium app. Near-black blue background (#070b14), crisp white sans-serif labels, thin 1 px panel borders, translucent dark panels with 12 px rounded corners. Accent colors: warm orange (#ff9a4d) for comets, selection and primary buttons; soft blue (#7fb8ff) for known catalog objects and earlier photos; teal (#4fd1c5) for "explored by people". Stars are soft round points, never spiky. No people, no photos of faces, no logos, no lens flares. All text must be legible and spelled exactly as given. Leave generous spacing. Every screen has the same top bar: "Comet Hunt" at the left, three tabs "Explore" "Guide" "Comet log", a search box "Search RA Dec or comet name", and a small round avatar at the right.

Image 10, "Explore" (the home screen; "Explore" tab selected):
- Center: a large oval all-sky map (Mollweide projection) of the infrared sky with a faint grey Milky Way arc. Thin dashed line across it labeled "Ecliptic: most comets travel near here".
- On the map: five small orange comet markers, each with a short label: "C-0147", "C-0152", "3I/ATLAS", "C-0161", "C-0170". One of them ("C-0147") has a dotted orange curve behind it showing its path across the sky. Three small blue markers labeled "Known comet". A few pulsing white rings labeled "Needs labels".
- Under the map: a time slider from "Apr 2025" to "Oct 2026" with a play button, handle at about 70 percent, and text above it "Sky photographed by SPHEREx so far: 85%".
- Left panel titled "Layers" with five rows, each a name and a toggle switch: "SPHEREx photos" (on), "Unexplored by people" (off), "Labeled comets" (on), "Known comets" (on), "Needs labels" (on). Under it a second section "Recent labels" with three short rows: "C-0147 · comet · 12 votes", "C-0152 · asteroid · 5 votes", "C-0161 · comet · 3 votes".
- Right panel titled "Start here": a big orange button "Take me to an unexplored patch", below it "Patches checked by people: 1,284 of 39,000", and a small link "New? Learn how to find a comet".

Image 11, "Unexplored by people" (same layout as image 10, "Explore" tab selected):
- The "Unexplored by people" toggle in the left panel is on, the others are off.
- The oval map is shown as a heat map: large regions that people have checked are filled teal (#4fd1c5), brighter where more people looked; regions nobody has checked are dark with a subtle dotted texture. One large dark region is outlined with an orange dashed border and labeled "Nobody has looked here yet".
- A color legend at the bottom right: "Times checked by people" with ticks "0", "1", "5", "20+".
- Right panel: "Your exploring", "You checked 14 patches", "You labeled 6 dots", and the orange button "Take me to an unexplored patch".

Image 12, "Patch viewer" (opened after clicking a spot on the map):
- Breadcrumb at top left under the top bar: "Explore / Patch near RA 187.4, Dec +4.2".
- Center: two square grainy infrared star images side by side, titled "Photo 1 · Aug 28, 03:10" and "Photo 2 · Aug 28, 14:52". Most stars are identical in both. One small fuzzy dot with a faint short tail is at the lower left in Photo 1 and has moved to the upper right in Photo 2. It is circled in orange in both images.
- Above the images: a toolbar of toggle buttons in one row: "Blink", "Side by side" (selected), "Remove still stars", "Show known objects", "Invert", and a small slider labeled "Contrast".
- Below the images: a strip of six small thumbnail photos of the same patch with times under them, the second one outlined in orange, and a slider under the strip labeled "Photos of this patch".
- Left narrow panel titled "Moving dots here" listing three rows with status chips: "Dot A · not labeled", "Dot B · comet (4)", "Dot C · glitch (2)".
- Right panel titled "Dot A": "Moved 3.7 arcmin in 11.7 hours", "Fuzzy edge: yes", "Known object: none found", and an orange button "Label this dot".

Image 13, "Label a dot" (same patch viewer as image 12, with a popup open):
- The two side-by-side images are visible but slightly dimmed. A popup card is anchored to the circled fuzzy dot.
- Popup title: "What is this dot?"
- Four large choice buttons, each with a tiny icon and a one-line hint: "Comet: fuzzy, moves between photos" (selected, orange border), "Asteroid: sharp point, moves", "Glitch: only in one photo", "Not sure".
- A text box with placeholder "Add a note (optional)".
- Buttons at the bottom: "Cancel" and an orange "Save label".
- A small line under the buttons: "11 people have labeled this dot. 9 said comet."

Image 14, "Comet page" ("Comet log" tab selected):
- Header: "C-0147" in large text, a chip "Likely comet · 12 of 14 votes", and a chip "Not in known catalogs".
- Left column top: a horizontal strip of four small photos of the comet over time with dates "Aug 28", "Aug 29", "Feb 20", "Feb 21", the comet circled in each.
- Left column middle, a card titled "Measurements" with rows: "Speed: 19 arcsec per hour", "Direction: north-east", "First photographed: Aug 28, 2025", "Photos: 6".
- Left column bottom, a card with a line chart titled "Light by wavelength (SPHEREx spectrum)": x axis "wavelength (µm)" from 0.75 to 5, a mostly flat line with a clear peak labeled "CO2 4.26 µm" and a smaller bump labeled "Water 2.7 µm".
- Right column, a discussion thread titled "Discussion" with three posts, each with a small round avatar, a username, time ago, and text:
  "orbit_owl · 2 h ago: The tail points away from the Sun. Looks like a comet to me."
  "kepler_kid · 1 h ago: Checked the known catalogs, nothing at this spot."
  "mira_v · 20 min ago: Strong CO2 peak, same as 3I/ATLAS."
  Under the posts a reply box "Write a comment" and an orange button "Post".

Image 15, "Guide" ("Guide" tab selected):
- Title: "How to find a comet in 5 steps".
- Five step cards in a row, each with a big number, a short title, a small illustration, and one line of text:
  "1. Pick a patch": a small oval sky map with one dark unexplored area highlighted. "Start where nobody has looked."
  "2. Remove still stars": a star field that is mostly black with one bright dot left. "Stars cancel out. Movers stay."
  "3. Blink the photos": two small frames with a dot in different places and a curved arrow between them. "Look for a dot that jumps."
  "4. Fuzzy or sharp?": a fuzzy dot with a tail beside a sharp point. "Fuzzy with a tail is a comet."
  "5. Label and share": a small label chip "Comet" and a speech bubble. "Save it and start a thread."
- Below the cards: an orange button "Try a practice patch" and a line "Practice patches have a real comet hidden in them."
