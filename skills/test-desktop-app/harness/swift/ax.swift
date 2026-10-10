// ax <pid> tree [maxDepth] [nomenu]   dump the accessibility tree of <pid> (role, title/desc, value, actions)
// ax <pid> press <role> <title>       AXPress the first element whose role == <role> (e.g. AXButton, AXMenuItem)
//                                     and whose title/description/value contains <title> (case-insensitive)
// ax <pid> enable [attr]              set AXManualAccessibility (default) or the named attr (e.g. AXEnhancedUserInterface)
//                                     on the app element
//                                     (asks lazy AX implementations to build their tree)
// ax <pid> set <attr> <true|false>    set a boolean attribute on every window (e.g. AXMinimized)
// AX talks to the app by PID and does not need it frontmost. Needs Accessibility for the calling process.
// Caveat: AXPress on a native control does not move focus; on web content inside a WKWebView it depends on
// WebKit's lazy AX tree (see the guide, probe P3).
import Foundation
import ApplicationServices

let a = CommandLine.arguments
guard a.count >= 3, let pid = pid_t(a[1]) else {
    FileHandle.standardError.write("usage: ax <pid> tree [depth] | press <role> <title> | enable | set <attr> <bool>\n".data(using: .utf8)!); exit(2)
}
guard AXIsProcessTrusted() else {
    FileHandle.standardError.write("calling process lacks Accessibility permission\n".data(using: .utf8)!); exit(3)
}
let app = AXUIElementCreateApplication(pid)

func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}
func str(_ e: AXUIElement, _ name: String) -> String {
    if let s = attr(e, name) as? String { return s }
    if let n = attr(e, name) as? NSNumber { return n.stringValue }
    return ""
}
func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func actions(_ e: AXUIElement) -> [String] {
    var names: CFArray?
    return AXUIElementCopyActionNames(e, &names) == .success ? (names as? [String] ?? []) : []
}

func walk(_ e: AXUIElement, _ depth: Int, _ maxDepth: Int, _ visit: (AXUIElement, Int) -> Bool) {
    if !visit(e, depth) || depth >= maxDepth { return }
    for c in children(e) { walk(c, depth + 1, maxDepth, visit) }
}

switch a[2] {
case "tree":
    let maxDepth = a.count > 3 ? Int(a[3]) ?? 8 : 8
    let skipMenu = a.contains("nomenu")   // the menu bar is huge (Apple menu, Recent Items, ...)
    var count = 0
    walk(app, 0, maxDepth) { e, d in
        if skipMenu && str(e, kAXRoleAttribute) == "AXMenuBar" { return false }
        if d > 0 && str(e, kAXRoleAttribute) == "AXApplication" {   // seen once: the app element answered as its own child
            print("!AX-DEGRADED: the app element returned itself as a child; retry, or relaunch the app")
            return false
        }
        count += 1
        if count > 2000 { return false }
        let role = str(e, kAXRoleAttribute), title = str(e, kAXTitleAttribute), desc = str(e, kAXDescriptionAttribute)
        var val = str(e, kAXValueAttribute)
        if val.count > 60 { val = String(val.prefix(60)) + "…" }
        let acts = actions(e).map { $0.replacingOccurrences(of: "AX", with: "") }.joined(separator: ",")
        print(String(repeating: "  ", count: d) + role + (title.isEmpty ? "" : " title=\"\(title)\"") +
              (desc.isEmpty ? "" : " desc=\"\(desc)\"") + (val.isEmpty ? "" : " value=\"\(val)\"") +
              (acts.isEmpty ? "" : " [\(acts)]"))
        return true
    }
case "press":
    guard a.count >= 5 else { exit(2) }
    let role = a[3], needle = a[4].lowercased()
    var hit: AXUIElement?
    walk(app, 0, 12) { e, _ in
        if hit != nil { return false }
        if str(e, kAXRoleAttribute) == role {
            let hay = [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute].map { str(e, $0) }.joined(separator: "|").lowercased()
            if hay.contains(needle) { hit = e; return false }
        }
        return true
    }
    guard let h = hit else { print("no match"); exit(1) }
    let r = AXUIElementPerformAction(h, kAXPressAction as CFString)
    print(r == .success ? "pressed" : "AXPress failed: \(r.rawValue)")
    exit(r == .success ? 0 : 1)
case "enable":
    for name in [a.count > 3 ? a[3] : "AXManualAccessibility"] {
        let r = AXUIElementSetAttributeValue(app, name as CFString, kCFBooleanTrue)
        print("\(name): \(r == .success ? "ok" : "error \(r.rawValue)")")
    }
case "set":
    guard a.count >= 5 else { exit(2) }
    let value: CFBoolean = a[4] == "true" ? kCFBooleanTrue : kCFBooleanFalse
    var n = 0
    for w in (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] {
        if AXUIElementSetAttributeValue(w, a[3] as CFString, value) == .success { n += 1 }
    }
    print("set \(a[3])=\(a[4]) on \(n) window(s)")
default:
    exit(2)
}
