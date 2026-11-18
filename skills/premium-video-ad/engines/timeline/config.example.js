// Example skin: Northwind Studio (invented). Timeline template, 25 s at 120 BPM.
// Copy to config.<name>.js, swap brand tokens (read them from the live site or the app CSS), copy and timing.
// The canvas is a video editor: bin, preview monitor, order panel and a V2 / V1 / A1 timeline.
// Hook and payoff are editorial type pages (folio, crop marks, a marker stroke over `mark.text`).
// Proof card types: "form" | "counter" | "track". Films in tension.items (entries with `kind`) snap onto V1
// one per beat from the drop; the entry with `music: true` lands on A1 on the drop.
// Footage kinds (abstract gradient art, no photos): aerial, day, interior, dusk, twilight, gold.
window.AD = {
  name: "example",
  brand: {
    bg: "oklch(0.17 0.012 250)",
    surface: "oklch(0.225 0.014 250)",
    surface2: "oklch(0.255 0.018 250)",
    row: "oklch(0.2 0.013 250)",
    bar: "oklch(0.195 0.013 250)",
    tl: "oklch(0.19 0.013 250)",
    border: "oklch(0.285 0.016 250)",
    border2: "oklch(0.36 0.018 250)",
    track: "oklch(0.32 0.016 250)",
    text: "oklch(0.96 0.008 250)",
    muted: "oklch(0.72 0.016 250)",
    faint: "oklch(0.53 0.014 250)",
    accent: "#FFB547",
    onAccent: "oklch(0.18 0.02 60)",
    accentSoft: "rgba(255,181,71,0.14)",
    accentText: "#FFB547",
    accentGlow: "rgba(255,181,71,0.7)",
    musicClip: "oklch(0.28 0.035 70)",
    musicWave: "rgba(255,181,71,0.55)",
    good: "oklch(0.74 0.14 155)",
    goodSoft: "rgba(86,196,128,0.16)",
    shadow: "0 40px 90px rgba(0,0,0,0.55), 0 8px 24px rgba(0,0,0,0.35)",
    glowA: "rgba(255,181,71,0.14)",
    glowB: "rgba(120,160,240,0.10)",
    gridLine: "rgba(240,242,250,0.045)",
    vig: "rgba(0,0,0,0.6)",
    display: "'Fraunces', Georgia, serif",
    displayWeight: 600,
    tracking: "-0.025em",
    body: "'Inter', system-ui, sans-serif",
  },
  // Cut times in seconds. rate = edit seconds the playhead covers per real second.
  // Keep every value in timeline.cuts a multiple of rate * 0.5 so the playhead crosses cuts on the beat.
  timing: { hook: 0, tension: 3, reveal: 7, proof: [10, 13, 16], payoff: 19, end: 22, total: 25, bpm: 120 },
  timeline: { length: 60, rate: 4, cuts: [0, 8, 16, 26, 34, 60], music: "track_warm_final.mp3 · 120 BPM", titleTag: "Title · V2" },
  project: {
    name: "12 Harbor View", preview: "Preview · 12 Harbor View",
    rows: [["Client", "Acme Homes"], ["Package", "Standard · 60 sec"], ["Formats", "16:9 · 9:16"], ["Music", "Warm"]],
    editorLabel: "Editor", unassigned: "Unassigned", editor: "Your editor", status: "In progress",
    empty: "No footage on the timeline",
  },
  hook: {
    folio: ["Northwind Studio", "Issue 01 · Listing video", "No. 01"],
    lines: ["Shoot all day.", "Edit all night.", "Not anymore."],
    mark: { line: 2, text: "Not anymore." },
  },
  tension: {
    bin: "Incoming",
    items: [
      { icon: "film", label: "DRONE_0101.MP4", kind: "aerial", len: "0:09" },
      { icon: "link", label: "drive.example/…/harbor-view" },
      { icon: "film", label: "CAM_0204.MOV", kind: "day", len: "0:08" },
      { icon: "chat", label: "Agent: can we add music?" },
      { icon: "film", label: "CAM_0211.MOV", kind: "interior", len: "0:10" },
      { icon: "music", label: "track_warm_final.mp3", music: true },
      { icon: "film", label: "DRONE_0107.MP4", kind: "dusk", len: "0:08" },
      { icon: "film", label: "CAM_0230.MOV", kind: "twilight", len: "0:26" },
    ],
    question: ["Who's editing", "all of this?"],
  },
  reveal: { claim: ["Hand it off.", "We edit it.", "You post it."] },
  proof: [
    {
      type: "form", title: ["One form,", "every detail."], sub: "Footage link, brand assets, music notes.",
      card: { head: "New order", lengths: ["30 sec", "60 sec", "120 sec"], pick: 1, link: "drive.example/…/harbor-view", linked: "Linked",
        music: ["Calm", "Warm", "Cinematic"], musicPick: 1, cta: "Place order · 70 credits", tag: "Order placed",
        labels: ["Length", "Footage link", "Music"], placeholder: "Paste a footage link" },
    },
    {
      type: "counter", title: ["Pay once,", "edit anytime."], sub: "Credits never expire.",
      card: { head: "Credit balance", from: 0, to: 500, spend: 70, unit: "credits", packLabel: "Credit pack added", spendLabel: "12 Harbor View · Standard 60 sec", badge: "Never expires" },
    },
    {
      type: "track", title: ["Tracked to", "delivery."], sub: "Most edits back in about two days.",
      card: { head: "12 Harbor View", meta: "Standard · 60 sec", steps: ["Placed", "Pending", "In progress", "Ready for delivery", "Delivered"], button: "Open delivery folder" },
    },
  ],
  payoff: {
    folio: ["Northwind Studio", "Issue 01 · Listing video", "No. 07"],
    lines: ["More listings shot.", "Fewer nights editing."],
    mark: { line: 1, text: "Fewer nights" },
    export: "12_Harbor_View_final.mp4 · 60 sec", exporting: "Exporting", exported: "Exported",
  },
  end: {
    monitor: "Final cut · 12 Harbor View", word: "Northwind", word2: "Studio",
    pill: "Welcome code · NORTHWIND", url: "northwind.example/start",
    chips: ["16:9 Wide", "9:16 Reel"], button: "Open delivery folder",
  },
};
