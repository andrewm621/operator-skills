// winlist <pid>  -> JSON array of the windows owned by pid, including off-screen and minimized ones.
// Fields: id, title, layer, x, y, w, h, onscreen, minimized (minimized needs Accessibility; null if unknown).
// Needs no permission for ids/bounds; titles of other apps' windows need Screen Recording on recent macOS.
import Foundation
import CoreGraphics
import ApplicationServices

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

guard CommandLine.arguments.count > 1, let pid = Int32(CommandLine.arguments[1]) else {
    FileHandle.standardError.write("usage: winlist <pid>\n".data(using: .utf8)!); exit(2)
}

var minimized: [CGWindowID: Bool] = [:]
if AXIsProcessTrusted() {
    let app = AXUIElementCreateApplication(pid)
    var ref: CFTypeRef?
    if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &ref) == .success, let wins = ref as? [AXUIElement] {
        for w in wins {
            var id: CGWindowID = 0
            guard _AXUIElementGetWindow(w, &id) == .success else { continue }
            var m: CFTypeRef?
            if AXUIElementCopyAttributeValue(w, kAXMinimizedAttribute as CFString, &m) == .success, let b = m as? Bool {
                minimized[id] = b
            }
        }
    }
}

let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
var out: [[String: Any]] = []
for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid {
    let id = (w[kCGWindowNumber as String] as? Int) ?? 0
    let b = (w[kCGWindowBounds as String] as? [String: Any]) ?? [:]
    func num(_ k: String) -> Double { (b[k] as? NSNumber)?.doubleValue ?? 0 }
    out.append([
        "id": id,
        "title": (w[kCGWindowName as String] as? String) ?? "",
        "layer": (w[kCGWindowLayer as String] as? Int) ?? 0,
        "x": num("X"), "y": num("Y"), "w": num("Width"), "h": num("Height"),
        "onscreen": (w[kCGWindowIsOnscreen as String] as? Bool) ?? false,
        "minimized": minimized[CGWindowID(id)].map { $0 as Any } ?? NSNull(),
    ])
}
let data = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
