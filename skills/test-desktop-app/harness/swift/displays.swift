// displays  -> JSON array of the active displays in GLOBAL top-left-origin points (what CGEvent / winlist use):
// [{"main":true,"x":0,"y":0,"w":2560,"h":1440}, ...]. No permission needed.
import Foundation
import CoreGraphics

var ids = [CGDirectDisplayID](repeating: 0, count: 16)
var n: UInt32 = 0
CGGetActiveDisplayList(16, &ids, &n)
var out: [[String: Any]] = []
for id in ids.prefix(Int(n)) {
    let b = CGDisplayBounds(id)
    out.append(["main": CGDisplayIsMain(id) != 0, "x": b.origin.x, "y": b.origin.y, "w": b.size.width, "h": b.size.height])
}
print(String(data: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
