/* Recipe: a button that is pressed, shows a spinner, then becomes a result badge.
   Spec: marks: { press: 9600, reserved: 10400 } and a click at 9600 on "#reserveBtn".
   The spinner is a pure function of t (spin() rotates by t), so there is no CSS animation. */
var btn = $("#reserveBtn"), label = $("#reserveTx"), spinner = $("#spRes"), badge = $("#resBadge");

WT.own("reserve.button", function (t, k) {
  var press = k.at("reserve", "press"), done = k.at("reserve", "reserved");
  txt(label, t >= press && t < done ? "Reserving" : "Reserve");
  spin(spinner, t, press, done);
  cls(btn, "pressed", t >= press && t < press + 200);
  op(btn, t >= done ? 0 : 1);              // the button gives way to the badge
  op(badge, rp(t, done, 300, "lin"));
});
