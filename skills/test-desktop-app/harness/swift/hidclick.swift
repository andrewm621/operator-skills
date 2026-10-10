// hidclick <x> <y>   REAL click: moves the user's cursor and posts at the HID tap. FOREGROUND MODE ONLY.
// The Python wrapper (desktop_test.hid_click) refuses unless focus-mode says foreground; call it only through
// focus-guard --foreground.
import Foundation
import CoreGraphics

let a = CommandLine.arguments
guard a.count >= 3, let x = Double(a[1]), let y = Double(a[2]) else {
    FileHandle.standardError.write("usage: hidclick <x> <y>\n".data(using: .utf8)!); exit(2)
}
let p = CGPoint(x: x, y: y)
CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(150_000)
for t in [CGEventType.leftMouseDown, .leftMouseUp] {
    let e = CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: .left)!
    e.setIntegerValueField(.mouseEventClickState, value: 1)
    e.post(tap: .cghidEventTap)
    usleep(80_000)
}
