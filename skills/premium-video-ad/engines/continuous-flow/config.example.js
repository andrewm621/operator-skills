// Northwind Studio: "How Northwind works" continuous-shot walkthrough.
// All times are seconds on a 120 BPM grid (one beat = 0.5 s).
// Placeholder data (names, emails, balances, property, links) is invented.
window.AD = {
  name: "example-walkthrough",
  layout: "flow",
  bpm: 120,

  brand: {
    bg: "oklch(0.979 0.007 88.6)",
    surface: "oklch(1 0 0)",
    surface2: "oklch(0.959 0.01 87.5)",
    border: "oklch(0.919 0.015 90.2)",
    border2: "oklch(0.867 0.02 90.6)",
    track: "oklch(0.892 0.02 90.6)",
    text: "oklch(0.245 0.008 118.4)",
    muted: "oklch(0.478 0.013 118.3)",
    accent: "#BFF752",
    onAccent: "oklch(0.12 0 0)",
    accentText: "oklch(0.538 0.137 126.2)",
    good: "oklch(0.581 0.12 155.6)",
    goodSoft: "oklch(0.955 0.017 159.1)",
    info: "oklch(0.528 0.104 251.5)",
    mark: "#0a0a0a",
    dot: "oklch(0.86 0.02 90)",
    shadow: "0 1px 2px rgba(40,38,20,.06), 0 14px 34px -10px rgba(40,38,20,.16), 0 34px 70px -28px rgba(40,38,20,.14)",
    shadowSoft: "0 1px 2px rgba(40,38,20,.05), 0 8px 20px -10px rgba(40,38,20,.12)",
    display: "Fraunces",
    body: "Inter",
    radius: 8,
  },

  timing: {
    stations: [0, 6, 12, 18, 24], // camera lands
    hold: 4.5,                    // then travels 1.5 s
    pullback: [30, 33],
    headline: 32,
    end: 36,
    total: 40,
  },

  chrome: { tagLeft: "Northwind Studio", tagRight: "How Northwind works" },

  // Card centres in world units. Heights are measured after fonts load.
  stations: [
    {
      id: "s1", n: "01", caption: "Sign up with your code", cx: 640, cy: 660, w: 600,
      title: "Create your account",
      emailLabel: "Email", email: "dana@northwindmedia.co", emailPh: "you@company.com",
      codeLabel: "Welcome code", codeOpt: "(optional)", code: "NORTHWIND",
      button: "Create account", toast: "Welcome credits added",
      at: { email: 0.8, emailCps: 22, code: 2.2, codeCps: 15, btn: 3.0, toast: 3.45 },
    },
    {
      id: "s2", n: "02", caption: "Add credits when you need them", cx: 1420, cy: 1460, w: 620,
      title: "Credits", chip: "Your balance",
      from: 120, packs: [100, 250, 500], pick: 1, button: "Add credits",
      note: ["Credits ", "never expire", "."],
      at: { pack: 1.0, btn: 1.6, count: 1.75, countDur: 0.9, delta: 2.65, note: 3.0 },
    },
    {
      id: "s3", n: "03", caption: "Submit footage and brief", cx: 2240, cy: 700, w: 780,
      title: "New order", property: "142 Alder Lane",
      formatLabel: "Format", formats: ["30 sec", "60 sec", "120 sec"], format: 1,
      tierLabel: "Package", tiers: ["Standard", "Premium"], tier: 1,
      // credits: Standard 30 sec = 60, Standard 60 sec = 70, Premium 60 sec = 90 (src/lib/order-packages.ts)
      costs: [60, 70, 90],
      footageLabel: "Footage link", footageHint: "Google Drive", footage: "drive.google.com/drive/folders/alder-lane-raw",
      musicLabel: "Music vibe", music: "Warm acoustic, upbeat",
      notesLabel: "Editing notes", notes: "Open on the porch at golden hour",
      totalLabel: "Total", button: "Place order", done: "Order placed",
      at: { format: 0.6, tier: 1.1, footage: 1.6, music: 2.05, musicCps: 40, notes: 2.75, notesCps: 52, btn: 3.65, done: 3.75 },
    },
    {
      id: "s4", n: "04", caption: "An editor picks it up", cx: 3040, cy: 1480, w: 720,
      title: "142 Alder Lane", meta: "Premium · 60 sec · 90 credits",
      steps: ["Placed", "Pending", "In progress", "Ready for delivery", "Delivered"],
      editor: "Your editor", editorSub: "Assigned to this order", editorTag: "Assigned",
      waiting: "Matching an editor", waitingSub: "Your order is in the queue",
      system: "Order placed", message: "First cut is underway", composerPh: "Write a message",
      at: { editor: 0.45, progress: 1.05, msg: 1.6, msgCps: 30, send: 2.5, bubble: 2.62 },
    },
    {
      id: "s5", n: "05", caption: "Delivered, ready to publish", cx: 3840, cy: 700, w: 720,
      title: "142 Alder Lane", meta: "Premium · 60 sec",
      steps: ["Placed", "Pending", "In progress", "Ready for delivery", "Delivered"],
      deliverBtn: "Mark delivered", openBtn: "Open in Google Drive", finalChip: "Final cut",
      notes: ["Revision rounds included", "Most edits delivered in ~48 hours, ~24 with Rush."],
      at: { deliver: 0.95, status: 1.05, morph: 1.35, open: 2.85, note1: 3.2, note2: 3.55 },
    },
  ],

  headline: { words: ["From", "footage", "to", "final", "cut."], highlight: [3, 4] },

  end: {
    word: "Northwind", word2: "Editing",
    pill: ["Welcome code", "NORTHWIND"],
    url: "northwind.example/start",
    small: "A service by Northwind Studio Inc.",
  },

  // Cursor keys: arrive at `t` on element `sel` at anchor (ax, ay) of its box.
  // `o` opacity, `click` presses on arrival, `jump` teleports while hidden, `move` travel time.
  cursors: [
    {
      id: "you", label: "You", style: "ink", keys: [
        { t: 0.0, sel: "#s1-email", ax: 1.05, ay: 2.6, o: 0, jump: true },
        { t: 0.72, sel: "#s1-email", ax: 0.88, ay: 0.62, o: 1, click: true, move: 0.6 },
        { t: 2.1, sel: "#s1-code", ax: 0.88, ay: 0.62, click: true },
        { t: 2.95, sel: "#s1-btn", ax: 0.8, ay: 0.62, click: true },
        { t: 4.3, sel: "#s1-btn", ax: 0.95, ay: 1.8, o: 0, move: 0.8 },

        { t: 6.2, sel: "#s2-p1", ax: 1.2, ay: 1.9, o: 0, jump: true },
        { t: 6.95, sel: "#s2-p1", ax: 0.78, ay: 0.72, o: 1, click: true, move: 0.6 },
        { t: 7.55, sel: "#s2-btn", ax: 0.74, ay: 0.62, click: true },
        { t: 10.3, sel: "#s2-btn", ax: 0.9, ay: 1.9, o: 0, move: 0.8 },

        { t: 12.15, sel: "#s3-f1", ax: 1.3, ay: 2.2, o: 0, jump: true },
        { t: 12.55, sel: "#s3-f1", ax: 0.72, ay: 0.7, o: 1, click: true, move: 0.4 },
        { t: 13.05, sel: "#s3-t1", ax: 0.72, ay: 0.7, click: true, move: 0.45 },
        { t: 13.55, sel: "#s3-footage", ax: 0.95, ay: 0.62, click: true, move: 0.45 },
        { t: 14.0, sel: "#s3-music", ax: 0.9, ay: 0.62, click: true, move: 0.4 },
        { t: 14.7, sel: "#s3-notes", ax: 0.93, ay: 0.62, click: true, move: 0.45 },
        { t: 15.6, sel: "#s3-btn", ax: 0.78, ay: 0.62, click: true, move: 0.55 },
        { t: 16.3, sel: "#s3-btn", ax: 0.95, ay: 1.8, o: 0, move: 0.6 },

        { t: 25.6, sel: "#s5-btn", ax: 1.6, ay: 2.4, o: 0, jump: true },
        { t: 26.8, sel: "#s5-btn", ax: 0.8, ay: 0.62, o: 1, click: true, move: 0.7 },
        { t: 28.6, sel: "#s5-btn", ax: 0.8, ay: 0.62, o: 1 },
        { t: 29.4, sel: "#s5-btn", ax: 1.0, ay: 1.8, o: 0, move: 0.7 },
      ],
    },
    {
      id: "editor", label: "Editor", style: "neon", keys: [
        { t: 18.0, sel: "#s4-node2", ax: 6, ay: -4, o: 0, jump: true },
        { t: 19.0, sel: "#s4-node2", ax: 0.72, ay: 0.38, o: 1, click: true, move: 0.7, pill: "up" },
        { t: 19.5, sel: "#s4-msg", ax: 0.93, ay: 0.62, click: true, move: 0.45 },
        { t: 20.45, sel: "#s4-send", ax: 0.55, ay: 0.6, click: true, move: 0.4 },
        { t: 22.3, sel: "#s4-send", ax: 1.6, ay: 1.6, o: 0, move: 0.7 },

        { t: 24.1, sel: "#s5-btn", ax: 1.2, ay: -3.0, o: 0, jump: true },
        { t: 24.9, sel: "#s5-btn", ax: 0.8, ay: 0.62, o: 1, click: true, move: 0.7 },
        { t: 25.9, sel: "#s5-btn", ax: 1.7, ay: -1.6, o: 0, move: 0.7 },
      ],
    },
  ],
};
