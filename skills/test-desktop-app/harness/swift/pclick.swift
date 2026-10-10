// pclick <pid> <x> <y> [windowId] [count]
// Mouse down/up at GLOBAL screen point (x, y) posted to <pid> with CGEvent.postToPid. The real cursor does not
// move. If windowId is non-zero it is stamped on the event so AppKit routes it to that window.
// Whether an INACTIVE app acts on it depends on the view's acceptsFirstMouse (see the guide, probe P2).
import Foundation
import CoreGraphics

let a = CommandLine.arguments
guard a.count >= 4, let pid = pid_t(a[1]), let x = Double(a[2]), let y = Double(a[3]) else {
    FileHandle.standardError.write("usage: pclick <pid> <x> <y> [windowId] [count]\n".data(using: .utf8)!); exit(2)
}
let wid = a.count > 4 ? Int64(a[4]) ?? 0 : 0
let count = a.count > 5 ? Int64(a[5]) ?? 1 : 1
let p = CGPoint(x: x, y: y)
let src = CGEventSource(stateID: .privateState)
for t in [CGEventType.leftMouseDown, .leftMouseUp] {
    let e = CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: p, mouseButton: .left)!
    e.setIntegerValueField(.mouseEventClickState, value: count)
    if wid != 0 {
        e.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: wid)
        e.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: wid)
    }
    e.postToPid(pid)
    usleep(80_000)
}
