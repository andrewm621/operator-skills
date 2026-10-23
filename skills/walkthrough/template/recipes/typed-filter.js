/* Recipe: a typed query that filters a grid.
   The text is a pure slice of the string, so any frame is reproducible.
   Cards rise in on a stagger; after the mark, non-matching cards dim and matching ones get a class. */
var search = $("#search"), searchPh = $("#searchPh"), searchTx = $("#searchTx"), count = $("#count");
var cards = $$("#grid .tool");   // mark the matching ones in the markup: class="tool hit-yes"

WT.own("browse", function (t, k) {
  var s0 = k.start("browse"), L = k.local(t, "browse");
  var typed = t >= k.at("browse", "typed");
  cls(search, "focus", L >= 1300 && L < 10000);
  op(searchPh, L >= 1700 ? 0 : 1);
  txt(searchTx, "drill".slice(0, Math.round(5 * rp(t, s0 + 1700, 1800, "lin"))));
  txt(count, typed ? "2 of 214 tools match" : "Showing 214 tools");
  cards.forEach(function (c, i) {
    var hit = c.classList.contains("hit-yes");
    var rise = rp(t, s0 + 200 + i * 90, 420, "out");
    var dim = typed && !hit ? 1 - 0.7 * rp(t, k.at("browse", "typed"), 400, "lin") : 1;
    op(c, Math.min(rise, dim));          // one write of opacity per card: rise and dim are combined here
    tr(c, 0, (1 - rise) * 10);
    cls(c, "hit", typed && hit);
  });
});
