// vv-vm: Villavisión's own little computer for macOS.
//
// Boots a Linux virtual machine with Apple's Virtualization framework: a real,
// separate computer that shares none of the host's files. The server compiles
// and signs this file once (the framework requires the
// com.apple.security.virtualization entitlement) and runs it.
//
//   vv-vm run <disk.raw> <seed.iso> <efi-vars> <cpus> <memory-mb> <mac-address>
//
// The machine has no screen of its own: the desktop runs inside it and is
// reached over its private network. Its serial console is this process's
// stdin and stdout, which the guest uses to report when it is ready.
// SIGTERM asks the guest to shut down, then stops it.
import Foundation
import Virtualization

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

final class Watcher: NSObject, VZVirtualMachineDelegate {
  func guestDidStop(_ virtualMachine: VZVirtualMachine) { exit(0) }
  func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
    fail("stopped: \(error.localizedDescription)")
  }
}

let args = CommandLine.arguments
guard args.count == 8, args[1] == "run", let cpus = Int(args[5]), let memoryMB = UInt64(args[6]),
      let mac = VZMACAddress(string: args[7])
else { fail("usage: vv-vm run <disk.raw> <seed.iso> <efi-vars> <cpus> <memory-mb> <mac-address>") }
let (diskPath, seedPath, varsPath) = (args[2], args[3], args[4])

let config = VZVirtualMachineConfiguration()
config.platform = VZGenericPlatformConfiguration()
config.cpuCount = max(VZVirtualMachineConfiguration.minimumAllowedCPUCount, min(cpus, VZVirtualMachineConfiguration.maximumAllowedCPUCount))
config.memorySize = max(VZVirtualMachineConfiguration.minimumAllowedMemorySize, min(memoryMB * 1024 * 1024, VZVirtualMachineConfiguration.maximumAllowedMemorySize))

do {
  let boot = VZEFIBootLoader()
  let varsURL = URL(fileURLWithPath: varsPath)
  boot.variableStore = FileManager.default.fileExists(atPath: varsPath)
    ? VZEFIVariableStore(url: varsURL)
    : try VZEFIVariableStore(creatingVariableStoreAt: varsURL)
  config.bootLoader = boot

  let disk = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: diskPath), readOnly: false)
  let seed = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: seedPath), readOnly: true)
  config.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: disk), VZVirtioBlockDeviceConfiguration(attachment: seed)]

  let network = VZVirtioNetworkDeviceConfiguration()
  network.attachment = VZNATNetworkDeviceAttachment()
  network.macAddress = mac
  config.networkDevices = [network]

  let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
  serial.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: FileHandle.standardInput, fileHandleForWriting: FileHandle.standardOutput)
  config.serialPorts = [serial]
  config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
  config.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
  try config.validate()
} catch {
  fail("config: \(error.localizedDescription)")
}

let watcher = Watcher()
let machine = VZVirtualMachine(configuration: config)
machine.delegate = watcher
machine.start { result in
  if case .failure(let error) = result { fail("start: \(error.localizedDescription)") }
  FileHandle.standardError.write("started\n".data(using: .utf8)!)
}

// Stop politely, then firmly.
var stopping = false
var signals: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
  signal(sig, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  source.setEventHandler {
    if stopping { exit(0) }
    stopping = true
    try? machine.requestStop()
    DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
      machine.stop { _ in exit(0) }
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) { exit(0) }
    }
  }
  source.resume()
  signals.append(source)
}
RunLoop.main.run()
