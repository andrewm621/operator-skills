/* The review hub's content. index.html reads this file; edit here, not in the page.
   Internal: this text may name people and quote them. The prototype pages must not. */
window.PROTO_HUB = {
  meta: {
    client: "Northfield Bakery",
    title: "Northfield prototypes",
    slug: "northfield-2026-01",
    devices: ["desktop", "ipadL", "ipadP", "phone"],
    barTitle: "Internal review copy",
    barSub: "Made-up data. Not connected to anything.",
    intro: "Clickable options for the morning order sheet and the delivery run, to review here before Tuesday's meeting. Look through each one, set a direction for each track, sort the open decisions, then sign off at the bottom and Copy my review back into the chat.",
    notice: "All data is made up, and nothing connects to the point-of-sale system. This hub names people and quotes them, so it stays internal.",
    showTitle: "A suggested order for Tuesday",
    checklistTitle: "Before you show this"
  },
  tracks: [
    {
      key: "orders",
      title: "Morning orders",
      prefix: "Orders",
      /* "options" = real alternatives, reviewed as Keep, Combine or Drop, and you pick one to start from. */
      shape: "options",
      lead: "What the owner described: orders in by 6, and the baker sees one list.",
      note: "One way to read the morning's orders. More options would sit beside it.",
      compareDevice: "ipadL",
      options: [
        {
          slug: "orders-a-one-list",
          letter: "A",
          name: "One list",
          file: "orders/orders-a-one-list.html",
          device: "ipadL",
          deviceShort: "iPad landscape",
          forWho: "The baker",
          concept: "Every order for the morning in one list, sorted by the time it has to be ready.",
          summary: "Tap an order to mark it done. Late orders stay at the top.",
          bestDevice: "iPad landscape, on the counter.",
          demoTip: "Tap the first order, then Reset demo to start again.",
          answers: [["One list instead of three paper sheets", "Call notes, Jan 12"]],
          tradeoffs: "The simplest to read, but it doesn't show which oven is free.",
          questions: ["Is 6:00 AM the real cutoff, or is it earlier on Saturdays?"],
          gaps: ["No real orders. Sorting by oven isn't built here."]
        }
      ]
    },
    {
      key: "delivery",
      title: "Delivery run",
      prefix: "Delivery",
      /* "stages" = one flow in parts, so don't invent a choice. Each part gets OK, Change or Later, and needs part: "Part 1". */
      shape: "stages",
      lead: "One flow from loading the van to the last drop.",
      note: "These are parts of one flow, not options to choose between.",
      compareDevice: "ipadP",
      options: [
        {
          slug: "delivery-a-load",
          letter: "A",
          part: "Part 1",
          name: "Load the van",
          file: "delivery/delivery-a-load.html",
          device: "ipadP",
          deviceShort: "iPad portrait",
          forWho: "The driver",
          concept: "A loading list in reverse drop order.",
          summary: "Check each tray as it goes in the van.",
          bestDevice: "iPad portrait, in the loading bay.",
          demoTip: "Check the first tray, then Reset demo.",
          answers: [["Trays stop getting left behind", "Call notes, Jan 12"]],
          tradeoffs: "Assumes the drop order is known before loading.",
          questions: ["Who sets the drop order?"],
          gaps: ["Drop order is made up."]
        },
        {
          slug: "delivery-b-drop",
          letter: "B",
          part: "Part 2",
          name: "Make the drop",
          file: "delivery/delivery-b-drop.html",
          device: "ipadP",
          deviceShort: "iPad portrait",
          forWho: "The driver",
          concept: "One screen per stop, with what to leave there.",
          summary: "Mark the stop done and the next one opens.",
          bestDevice: "iPad portrait, in the van.",
          demoTip: "Tap Done on the first stop.",
          answers: [["The driver can see what each cafe gets", "Call notes, Jan 12"]],
          tradeoffs: "Needs a signal at each stop, or an offline copy.",
          questions: ["Does anyone sign for a drop?"],
          gaps: ["Nothing is sent anywhere."]
        }
      ]
    }
  ],
  showOrder: [{ slug: "orders-a-one-list", why: "It's their words" }],
  showHolding: "",
  /* Each one becomes something to tick before the sign-off. Say what has to be done, not what to remember. */
  checklist: ["Tap Reset demo on any page you've been clicking around in."],
  /* What a reviewer found and nobody confirmed fixed. Each one blocks the sign-off until it's accepted as a known gap. */
  openFindings: [{ slug: "delivery-b-drop", problem: "Done on the last stop doesn't say the run is finished." }],
  /* Optional. Replaces the default "Opened it on a real iPad" check.
     manualChecks: [{ label: "Opened it on the shop's own iPad", why: "Its Safari is several versions old." }], */
  decisions: [
    {
      group: "Morning orders",
      items: [
        /* who: the person or role who answers it, in a few words. The agenda groups by this exact text, so spell a name the same way every time. */
        { title: "What's the real cutoff?", who: "The owner", why: "The call said 6:00 AM, but the sheet says 5:30.", affects: "Orders A", source: "Call notes, Jan 12" }
      ]
    }
  ]
};
