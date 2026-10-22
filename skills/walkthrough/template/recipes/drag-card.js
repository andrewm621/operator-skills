/* Recipe (not exercised by the fixture): a card that lifts out of a rail, follows the cursor and drops into a lane.
   Distilled from the Langston weekly walkthrough. The cursor does not drag the card; the owner positions the card
   from layout (rel()) and a `follow` move keeps the cursor on it:
     moves:  [[1600, 700, "#rcRosa", 0.35, 0.5], [2400, 0, "#rcRosa", 0.35, 0.5, { follow: true }]]
     marks:  { lift: 2400, drag: 2600, drop: 3700 }
   Position is relative to the rail's list box; off() is the same layout walk the cursor uses. */
var rlist = $("#rlist"), laneCard = $("#cardRosa"), railCard = $("#rcRosa");

function slot(i) { return { x: 0, y: i * 58 }; }                              // rail slot i, in rail-list pixels
function rel(el) { var a = WT.off(el), b = WT.off(rlist); return { x: a.x - b.x, y: a.y - b.y }; }
function mix(a, b, f) { return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }; }

WT.own("plan.drag", function (t, k) {
  var lift = k.at("plan", "lift"), drag = k.at("plan", "drag"), drop = k.at("plan", "drop");
  var pos = slot(4);
  pos = mix(pos, rel(laneCard), rp(t, drag, drop - drag - 100, "inOut"));       // travel to the lane card's spot
  var lifted = t >= lift && t < drop;
  var lp = rp(t, lift, 180, "out");
  cls(railCard, "lift", lifted);
  tr(railCard, pos.x, pos.y, lifted ? " rotate(" + (2 * lp).toFixed(2) + "deg) scale(" + (1 + 0.04 * lp).toFixed(3) + ")" : "");
  op(railCard, t >= drop ? 0 : 1);                                              // the rail copy vanishes on drop
  op(laneCard, t >= drop ? 1 : 0);                                              // and the lane card pops in
  css(laneCard, "transform", "scale(" + (t >= drop ? (0.94 + 0.06 * rp(t, drop, 320, "back")).toFixed(3) : "1") + ")");
});
