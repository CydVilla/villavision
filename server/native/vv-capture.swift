// vv-capture: Villavisión's screen and window capture for macOS.
//
// It uses ScreenCaptureKit, the same system framework OBS uses, so it can
// capture one window on its own and the computer's sound without extra
// drivers. The server compiles this file once with `swiftc` and runs it.
//
//   vv-capture list
//       prints {"displays":[…],"windows":[…]} as JSON
//   vv-capture capture display|window <id> <width> <height> <fps> [audio]
//       writes raw NV12 frames of exactly width x height to stdout at a
//       steady rate, and (with "audio") 48 kHz stereo float samples to
//       file descriptor 3. ffmpeg reads both and does the encoding.
import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import CoreGraphics
import AppKit

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

func content(onScreenOnly: Bool) async -> SCShareableContent {
  do {
    return try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: onScreenOnly)
  } catch {
    fail("permission: \(error.localizedDescription)")
  }
}

// Points to pixels, so sizes describe what will actually be captured.
func pixelScale(_ display: SCDisplay?) -> Double {
  guard let d = display, let mode = CGDisplayCopyDisplayMode(d.displayID), d.width > 0 else { return 1 }
  return max(1, Double(mode.pixelWidth) / Double(d.width))
}

func list() async {
  // Include windows on other desktops and full-screen apps, not just this one.
  let c = await content(onScreenOnly: false)
  let scale = pixelScale(c.displays.first)
  var displays: [[String: Any]] = []
  for d in c.displays {
    let s = pixelScale(d)
    displays.append(["id": Int(d.displayID), "width": Int(Double(d.width) * s), "height": Int(Double(d.height) * s)])
  }
  var windows: [[String: Any]] = []
  for w in c.windows {
    guard w.windowLayer == 0, w.frame.width >= 160, w.frame.height >= 120 else { continue }
    // A browser playing a video full screen shows it in a second window with
    // no title. Keep untitled windows when they are big enough to be one, and
    // leave out the many small untitled ones (toolbars, popovers).
    let title = (w.title ?? "").trimmingCharacters(in: .whitespaces)
    if title.isEmpty && (w.frame.width < 480 || w.frame.height < 270) { continue }
    // System overlays that are not real windows.
    let bundle = w.owningApplication?.bundleIdentifier ?? ""
    if ["com.apple.WindowManager", "com.apple.dock", "com.apple.controlcenter", "com.apple.notificationcenterui"].contains(bundle) { continue }
    windows.append([
      "id": Int(w.windowID),
      "app": w.owningApplication?.applicationName ?? "",
      "title": title,
      "width": Int(Double(w.frame.width) * scale),
      "height": Int(Double(w.frame.height) * scale),
    ])
  }
  let json = try! JSONSerialization.data(withJSONObject: ["displays": displays, "windows": windows])
  FileHandle.standardOutput.write(json)
}

// write(2) until everything is out. A closed pipe means ffmpeg has gone: stop.
func writeAll(_ fd: Int32, _ base: UnsafeRawPointer, _ count: Int) {
  var done = 0
  while done < count {
    let n = write(fd, base + done, count - done)
    if n > 0 { done += n; continue }
    if n < 0 && errno == EINTR { continue }
    raise(SIGTERM) // ends the capture cleanly (see the signal handlers below)
    Thread.sleep(forTimeInterval: 3)
    exit(0)
  }
}

final class Output: NSObject, SCStreamOutput, SCStreamDelegate {
  let width: Int, height: Int
  private let lock = NSLock()
  private var frame: [UInt8]   // the newest picture, NV12
  private var scratch: [UInt8]
  private var interleaved: [Float32] = []

  init(width: Int, height: Int) {
    self.width = width
    self.height = height
    // Start on black (video range: Y 16, chroma 128) until the first picture.
    var black = [UInt8](repeating: 16, count: width * height * 3 / 2)
    for i in (width * height)..<black.count { black[i] = 128 }
    frame = black
    scratch = black
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fail("stopped: \(error.localizedDescription)")
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard sample.isValid else { return }
    if type == .screen { video(sample) } else if type == .audio { audio(sample) }
  }

  // The screen only sends a picture when something changed; keep the newest.
  private func video(_ sample: CMSampleBuffer) {
    guard let pixels = CMSampleBufferGetImageBuffer(sample), CVPixelBufferGetPlaneCount(pixels) == 2 else { return }
    CVPixelBufferLockBaseAddress(pixels, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
    let planes = [(offset: 0, rows: height, bytes: width), (offset: width * height, rows: height / 2, bytes: width)]
    for (i, plane) in planes.enumerated() {
      guard let base = CVPixelBufferGetBaseAddressOfPlane(pixels, i) else { return }
      let stride = CVPixelBufferGetBytesPerRowOfPlane(pixels, i)
      let rows = min(plane.rows, CVPixelBufferGetHeightOfPlane(pixels, i))
      let bytes = min(plane.bytes, stride)
      scratch.withUnsafeMutableBytes { out in
        for row in 0..<rows {
          memcpy(out.baseAddress! + plane.offset + row * plane.bytes, base + row * stride, bytes)
        }
      }
    }
    lock.lock()
    swap(&frame, &scratch)
    lock.unlock()
  }

  // Called on a steady timer: send the newest picture again, changed or not,
  // so the stream keeps a constant frame rate while the screen is still.
  func emitFrame() {
    lock.lock()
    let copy = frame
    lock.unlock()
    copy.withUnsafeBytes { writeAll(1, $0.baseAddress!, $0.count) }
  }

  private func audio(_ sample: CMSampleBuffer) {
    var needed = 0
    CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: &needed, bufferListOut: nil,
      bufferListSize: 0, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
    guard needed > 0 else { return }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: needed, alignment: 16)
    defer { raw.deallocate() }
    let listPointer = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
    var block: CMBlockBuffer?
    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: nil,
      bufferListOut: listPointer, bufferListSize: needed, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
      flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &block)
    guard status == noErr else { return }
    let buffers = UnsafeMutableAudioBufferListPointer(listPointer)
    let frames = CMSampleBufferGetNumSamples(sample)
    guard frames > 0, let first = buffers.first, let left = first.mData else { return }

    if buffers.count == 1 && first.mNumberChannels == 2 {
      writeAll(3, left, frames * 2 * MemoryLayout<Float32>.size) // already left/right interleaved
      return
    }
    // One buffer per channel (or mono): weave into left/right pairs.
    let l = left.assumingMemoryBound(to: Float32.self)
    let r = (buffers.count > 1 ? buffers[1].mData : nil)?.assumingMemoryBound(to: Float32.self) ?? l
    if interleaved.count < frames * 2 { interleaved = [Float32](repeating: 0, count: frames * 2) }
    for i in 0..<frames { interleaved[2 * i] = l[i]; interleaved[2 * i + 1] = r[i] }
    interleaved.withUnsafeBytes { writeAll(3, $0.baseAddress!, frames * 2 * MemoryLayout<Float32>.size) }
  }
}

var keepAlive: [Any] = []

func capture(kind: String, id: UInt32, width: Int, height: Int, fps: Int, audio: Bool) async {
  let c = await content(onScreenOnly: false)
  let filter: SCContentFilter
  if kind == "display" {
    guard let d = c.displays.first(where: { $0.displayID == id }) else { fail("gone: that screen is no longer connected") }
    filter = SCContentFilter(display: d, excludingWindows: [])
  } else {
    guard let w = c.windows.first(where: { $0.windowID == id }) else { fail("gone: that window is closed") }
    filter = SCContentFilter(desktopIndependentWindow: w)
  }
  let config = SCStreamConfiguration()
  config.width = width
  config.height = height
  config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
  config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
  // Say which colours these are, so every player shows them the same way.
  config.colorSpaceName = CGColorSpace.sRGB
  config.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
  if #available(macOS 14.0, *) { config.captureResolution = .best }
  config.showsCursor = true
  config.scalesToFit = true
  config.queueDepth = 5
  // Don't let macOS pop its screen-sharing panel over the screen being shared.
  if #available(macOS 14.0, *) { config.presenterOverlayPrivacyAlertSetting = .never }
  if audio {
    config.capturesAudio = true
    config.sampleRate = 48000
    config.channelCount = 2
  }
  let output = Output(width: width, height: height)
  let stream = SCStream(filter: filter, configuration: config, delegate: output)
  do {
    try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "vv.video", qos: .userInteractive))
    if audio { try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: DispatchQueue(label: "vv.audio", qos: .userInteractive)) }
    try await stream.startCapture()
  } catch {
    fail("permission: \(error.localizedDescription)")
  }
  let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "vv.clock", qos: .userInteractive))
  timer.schedule(deadline: .now(), repeating: 1.0 / Double(fps), leeway: .milliseconds(2))
  timer.setEventHandler { output.emitFrame() }
  timer.resume()
  // When asked to stop, end the stream properly first. Just dying can leave
  // macOS showing its "currently sharing" indicator after nothing is shared.
  var handlers: [Any] = []
  for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: DispatchQueue(label: "vv.signal"))
    source.setEventHandler {
      timer.cancel()
      Task {
        try? await stream.stopCapture()
        exit(0)
      }
    }
    source.resume()
    handlers.append(source)
  }
  keepAlive = [stream, output, timer, handlers]
}

signal(SIGPIPE, SIG_IGN)
_ = NSApplication.shared // connects to the window server; window capture needs it
let args = CommandLine.arguments
Task {
  if args.count == 2 && args[1] == "list" {
    await list()
    exit(0)
  }
  guard args.count >= 7, args[1] == "capture", args[2] == "display" || args[2] == "window",
        let id = UInt32(args[3]), let width = Int(args[4]), let height = Int(args[5]), let fps = Int(args[6]),
        width >= 16, height >= 16, width % 2 == 0, height % 2 == 0, width <= 4096, height <= 4096, fps >= 1, fps <= 60
  else { fail("usage: vv-capture list | capture display|window <id> <width> <height> <fps> [audio]") }
  await capture(kind: args[2], id: id, width: width, height: height, fps: fps, audio: args.count > 7 && args[7] == "audio")
}
dispatchMain()
