// pkey <pid> key <name> [mods]   |   pkey <pid> type "<text>"
// Posts keyboard events straight to <pid>'s event queue with CGEvent.postToPid. No HID tap: the frontmost app
// and the user's keyboard are untouched. Needs Accessibility for the calling process.
// name: a-z 0-9 return tab space escape delete left right up down home end pageup pagedown, or a raw keycode.
// mods: comma list of cmd,shift,alt,ctrl.
import Foundation
import CoreGraphics

let codes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
    "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26,
    "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
    "return": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53,
    "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
]
let a = CommandLine.arguments
guard a.count >= 4, let pid = pid_t(a[1]) else {
    FileHandle.standardError.write("usage: pkey <pid> key <name> [mods] | pkey <pid> type <text>\n".data(using: .utf8)!); exit(2)
}
let src = CGEventSource(stateID: .privateState)

if a[2] == "key" {
    guard let code = codes[a[3].lowercased()] ?? UInt16(a[3]).map({ CGKeyCode($0) }) else {
        FileHandle.standardError.write("unknown key \(a[3])\n".data(using: .utf8)!); exit(2)
    }
    var flags: CGEventFlags = []
    let mods = a.count > 4 ? a[4] : ""
    if mods.contains("cmd") { flags.insert(.maskCommand) }
    if mods.contains("shift") { flags.insert(.maskShift) }
    if mods.contains("alt") { flags.insert(.maskAlternate) }
    if mods.contains("ctrl") { flags.insert(.maskControl) }
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)!
        e.flags = flags
        e.postToPid(pid)
        usleep(50_000)
    }
} else if a[2] == "type" {
    for var ch in a[3].utf16 {
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)!
            e.keyboardSetUnicodeString(stringLength: 1, unicodeString: &ch)
            e.postToPid(pid)
            usleep(20_000)
        }
    }
} else {
    FileHandle.standardError.write("unknown mode \(a[2])\n".data(using: .utf8)!); exit(2)
}
