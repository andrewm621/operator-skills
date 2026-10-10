// pscroll <pid> <x> <y> <dy>   dy in pixels; negative = scroll down. Posted to <pid>, cursor untouched.
import Foundation
import CoreGraphics

let a = CommandLine.arguments
guard a.count >= 5, let pid = pid_t(a[1]), let x = Double(a[2]), let y = Double(a[3]), let dy = Int32(a[4]) else {
    FileHandle.standardError.write("usage: pscroll <pid> <x> <y> <dy>\n".data(using: .utf8)!); exit(2)
}
let src = CGEventSource(stateID: .privateState)
let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0)!
e.location = CGPoint(x: x, y: y)
e.postToPid(pid)
