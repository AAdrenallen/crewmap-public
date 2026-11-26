# Bluetooth LE transport (deferred on both platforms)
- **Android:** `BluetoothLeAdvertiser` + `BluetoothLeScanner`, GATT server for payloads; permissions BLUETOOTH_SCAN/ADVERTISE/CONNECT.
- **iOS:** CoreBluetooth `CBPeripheralManager`/`CBCentralManager`; background advertising strips the local name and uses the overflow area — scan by service UUID only.
- **Plug-in point:** implements `DirectLinks` (`packages/p2p/src/transport/types.ts`) so the router can use it like WebRTC.
