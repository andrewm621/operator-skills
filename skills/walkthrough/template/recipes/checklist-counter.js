/* Recipe: ticks that land one by one, a status that flips, a counter that goes up or down.
   A text that changes more than once is ONE owner choosing by t, never several writers. */
var chks = [$("#chk1"), $("#chk2"), $("#chk3")], loanStatus = $("#loanStatus"), openCount = $("#openCount");

WT.own("return", function (t, k) {
  var closed = k.at("return", "closed"), zero = k.at("return", "zero");
  [4900, 5900, 6900].forEach(function (at, i) { cls(chks[i], "on", t >= k.at("return", at)); });
  txt(loanStatus, t >= closed ? "Returned" : "Out");
  cls(loanStatus, "b-ok", t >= closed); cls(loanStatus, "b-warn", t < closed);
  txt(openCount, t >= zero ? "0" : "1");           // counting up instead? num(el, t, at, dur, to)
});
