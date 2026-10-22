/* Recipe: screens and tabs.
   A screen is visible between two marks; the tab follows the scene the viewer is in.
   Marks live in the spec: { id: "browse", marks: { open: 11400 } }  (scene-relative ms). */
var scrBrowse = $("#scrBrowse"), scrReserve = $("#scrReserve"), scrLoans = $("#scrLoans");
var tabBrowse = $("#tabBrowse"), tabLoans = $("#tabLoans");

WT.own("screens", function (t, k) {
  var toReserve = k.at("browse", "open"), toLoans = k.at("pickup", "toLoans");
  // win(t, from, to, fadeIn, fadeOut): 0..1, "to" null means it stays
  op(scrBrowse, win(t, -1, toReserve + 250, 1, 250));
  op(scrReserve, win(t, toReserve + 150, toLoans + 250, 300, 250));
  op(scrLoans, win(t, toLoans + 150, null, 300));
  cls(tabBrowse, "on", t < toLoans);
  cls(tabLoans, "on", t >= toLoans);
});
