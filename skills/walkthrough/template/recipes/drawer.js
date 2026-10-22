/* Recipe: a scrim plus a drawer that slides in from the right on wide, up from the bottom on narrow.
   k.mode() is "wide" or "narrow"; the canvas CSS gives the drawer its geometry per mode (.is-narrow).
   Open and close are marks or fixed offsets in the scene. */
var scrim = $("#dScrim"), drawer = $("#drawer"), digits = $$("#passCode .digit");

WT.own("pass", function (t, k) {
  var open = k.at("pickup", "open"), close = k.at("pickup", "toLoans") - 500;
  var p = rp(t, open, 480, "out") * (1 - rp(t, close, 420, "inOut"));   // 0 closed .. 1 open
  op(scrim, p);
  css(drawer, "visibility", p <= 0 ? "hidden" : "visible");
  if (k.mode() === "wide") tr(drawer, (1 - p) * 420, 0); else tr(drawer, 0, (1 - p) * 460);
  digits.forEach(function (d, i) { op(d, rp(t, open + 700 + i * 200, 260, "lin")); });
});
