/* Recipe (not exercised by the fixture): a paste box whose rows appear, a preview with counts, and a
   second paste that updates two rows. Distilled from a client weekly-board walkthrough.
   Everything is in the markup already; the owner only reveals it. Marks in the spec:
   marks: { paste: 1500, preview: 3900, apply: 6500, repaste: 9100 } */
var box = $("#pboxP"), placeholder = $("#phP"), lines = $$("#pboxP .ln"), kbd = $("#kbdP");
var previewBtn = $("#prevP"), previewTx = $("#prevPt"), spin1 = $("#spP");
var panelEmpty = $("#pp0"), panelA = $("#ppA"), panelDone = $("#ppB"), countNew = $("#cA1");
var lnTia = $("#lnTia"), tiaTitle = $("#tiaTitle");

WT.own("people.paste", function (t, k) {
  var paste = k.at("people", "paste"), prev = k.at("people", "preview"), apply = k.at("people", "apply"), again = k.at("people", "repaste");
  cls(box, "focus", t >= paste - 100 && t < prev);
  op(placeholder, 1 - rp(t, paste - 60, 120, "lin"));
  op(kbd, win(t, paste - 150, paste + 700, 120, 250));                       // the "Cmd V" hint
  lines.forEach(function (ln, i) {                                           // rows stream in
    op(ln, t < again ? rp(t, paste + i * 55, 140, "lin") : rp(t, again + 60 + i * 40, 140, "lin"));
  });
  txt(tiaTitle, t >= again ? "Foreman" : "Laborer");                          // a row that changed on re-paste
  cls(lnTia, "chg", t >= again + 300);
  txt(previewTx, t >= prev && t < prev + 800 ? "Checking people..." : "Preview 10 rows");
  spin(spin1, t, prev, prev + 800);
  cls(previewBtn, "pressed", t >= prev && t < prev + 200);
  op(panelEmpty, win(t, -1, prev + 900, 1, 200));
  var a = win(t, prev + 800, apply + 700, 280, 220); op(panelA, a); tr(panelA, 0, (1 - rp(t, prev + 800, 400)) * 10);
  var b = win(t, apply + 600, again + 200, 280, 220); op(panelDone, b); tr(panelDone, 0, (1 - rp(t, apply + 600, 400)) * 10);
  num(countNew, t, prev + 900, 600, 10);                                      // 0 -> 10
});
