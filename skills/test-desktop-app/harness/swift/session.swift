// session  -> JSON {"present":bool,"locked":bool,"onConsole":bool} for the current GUI login session.
// present=false (no GUI session dictionary, e.g. over ssh), locked=true (screen locked / loginwindow showing) or
// onConsole=false all mean "nobody can be watching a window": focus-mode treats them as background. No permission needed.
import Foundation
import CoreGraphics

let d = (CGSessionCopyCurrentDictionary() as? [String: Any]) ?? [:]
let out: [String: Any] = [
    "present": !d.isEmpty,
    "locked": (d["CGSSessionScreenIsLocked"] as? Bool) ?? false,
    "onConsole": (d["kCGSSessionOnConsoleKey"] as? Bool) ?? true,
]
print(String(data: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
