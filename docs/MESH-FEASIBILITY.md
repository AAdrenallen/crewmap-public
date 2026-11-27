# Offline crew mesh: feasibility (D69)

Question: can phones in a convoy exchange presence (location) and emotes directly, over BLE, Wi-Fi Direct, Wi-Fi Aware
or Google Nearby Connections, when the internet path (WebRTC / Nostr, D2–D13) is down?

**Verdict: narrower scope, Android-only, prototype first.** Build a *connectionless* BLE "convoy beacon": each phone
broadcasts its sealed presence in BLE 5 extended advertising (Coded PHY when both phones support it, 1M otherwise) and
scans for crew beacons. It is single-hop with no GATT connections, no Wi-Fi Direct, no Nearby Connections and no
multi-hop mesh. It only runs during a drive (the location foreground service already runs then) and only when the
internet transport has failed. Expect 50–150 m car to car on 1M and roughly 150–400 m on Coded PHY (estimated, not measured), and
about +0.3–1 %/h of battery. A two-phone range test decides whether the feature gets built.

Sources: published figures (Bluetooth SIG Core 5.x PHY specs, Android developer docs on BLE/FGS/Doze, the Bitchat,
Briar, Berty and Meshtastic repos and docs, Google Nearby Connections docs/ToS), plus on-device checks below. Range numbers for
phones inside cars are estimates. Nobody publishes good car-to-car phone measurements, so the prototype has to produce them.

## On-device facts (OnePlus 8, IN2015, Android 13, via adb 2026-11-26)
- `pm list features`: `bluetooth_le` and `wifi.direct` present; **`wifi.aware` absent**, so Wi-Fi Aware is ruled out on
  the test phone.
- Coded PHY / extended advertising support is not shown in `dumpsys`. The Snapdragon 865 (BT 5.1) normally has both,
  and `BluetoothAdapter.isLeCodedPhySupported()` / `isLeExtendedAdvertisingSupported()` /
  `getLeMaximumAdvertisingDataLength()` must be read in the prototype. Unverified.
- Battery baseline of the current transport: `tools/device/battery-window.sh 5 app.crewmap.preview` (only the preview
  build is installed), results in the section "Measured baseline" below.

## Options compared

| Option | Car-to-car range (est.) | Setup while moving | Android limits | iOS | Verdict |
|---|---|---|---|---|---|
| BLE legacy adv (1M, 31 B) | 30–100 m | none (broadcast) | filtered scan needed with screen off | background adv is iOS-only "overflow" | too small for a sealed presence |
| **BLE 5 extended adv, 1M / Coded S=8** | **50–150 m / 150–400 m** | **none (broadcast), first beacon in about 1 s** | BLUETOOTH_SCAN/ADVERTISE; FGS; scan filters | no ext-adv API, no Coded PHY control | **prototype** |
| BLE GATT mesh (Bitchat style) | as above | 0.5–3 s per link; links break | 5-ish concurrent links, OEM GATT bugs | works in fg, limited bg | not needed for ~100 B messages |
| Wi-Fi Direct | 100–200 m | 2–10 s group negotiation, often a user prompt | NEARBY_WIFI_DEVICES, one group, drops Wi-Fi STA on some OEMs | no API | no-go |
| Wi-Fi Aware (NAN) | 100–200 m | 1–3 s | **not on OnePlus 8**; Android 8+ only on some chipsets | no | no-go |
| Nearby Connections | BT+BLE+Wi-Fi, 30–150 m | 2–10 s (discover, then connect, then upgrade bandwidth) | needs Google Play services; closed, proprietary SDK under Google APIs ToS | separate beta SDK | no-go (closed, GMS, slow setup) |
| LoRa (Meshtastic radio) | 1–10 km | none | extra hardware per car (~40 USD), BLE to the phone | yes, via BLE | option for later if the owner buys hardware |

What the open-source projects show:
- **Bitchat**: BLE GATT mesh, TTL relay, Noise encryption. It shows phone-to-phone BLE messaging works, but it is
  chat-oriented and connection-based, and its own docs give about 30–100 m per hop. Connection-based links are the
  fragile part when phones move.
- **Briar**: Bluetooth Classic RFCOMM and LAN Wi-Fi. Close range, connection setup takes seconds, and it keeps a
  foreground service running all the time for that. It fits a protest or a building, not moving cars.
- **Berty**: BLE plus Apple Multipeer and Android Nearby. iOS-to-Android over BLE in the background is its documented
  weak spot.
- **Meshtastic**: the only one with real road range, and only because it uses separate LoRa radios.

## Physics of the use case
- **Payload**: an existing envelope (`packages/p2p/src/crypto/envelope.ts`) is ~250–350 B (JSON inner + Ed25519 sig +
  XChaCha20-Poly1305). A compact binary beacon fits one 255 B extended-adv PDU: version 1 + epoch 4 + nonce 24 +
  MAC 16 + sig 64 + presence (lat/lon int32, speed/heading/accuracy u16, ts u32, emote u8) ≈ 20 + rotating sender tag 8
  ≈ **140 B**. Coded PHY S=8 is 125 kbit/s, so about 10 ms on air. At 1 beacon/s per phone, 10 phones use well
  under 1 % of the channel. Throughput is never the limit.
- **Relative speed**: in the same direction, convoy cars are within 0–30 km/h of each other, so a 100 m radius gives
  contact that lasts minutes. Oncoming cars close at 200+ km/h, so 2 × 100 m of range gives about 3.6 s, which is
  enough for 2–3 beacons but not for a GATT connect plus a service discovery. That is why the design is connectionless.
- **Range**: Coded PHY gains ~12 dB over 1M (4× in free space). Car bodies and people cost 10–20 dB each way, and
  metallized windshields cost more. Highway spacing at 100 km/h with a 2–3 s gap is 55–85 m, so cars that follow each other stay in range. Cars that
  end up 1 km apart (a red light, a wrong exit) do not.
- **When it helps**: (1) tunnels and short dead zones while the cars are still close together: it keeps the friend markers
  moving and emotes flowing. (2) Rural dead zones, only while the convoy stays together. Exactly when the cars get
  separated it cannot help. (3) Car-to-car emotes with no data plan or roaming. It does **not** reunite a
  separated convoy, and it does not replace store-and-forward (Nostr already queues for later).
- **Gateway (later)**: a phone that has signal could forward neighbours' beacons to Nostr. That gives partial internet
  reach for a car in a dead zone. It is a one-hop relay, not a mesh. Defer it until the beacon proves its range.

## Android constraints
- Permissions: Android 12+ `BLUETOOTH_SCAN` declared with `usesPermissionFlags="neverForLocation"` (we derive no location
  from scans, and our filtered scans don't need beacons from unknown devices), `BLUETOOTH_ADVERTISE`; one more runtime prompt group ("Nearby
  devices"). Ask only when the user turns the beacon on, never during onboarding.
- Background: scans with the screen off **must** use a `ScanFilter` (service UUID or manufacturer ID), or Android 8.1+
  delivers nothing. Starting more than 5 scans in 30 s gets the app throttled. Run the scan and the advertiser inside the
  existing location foreground service during drives (add FGS type `connectedDevice` on Android 14+). Doze does not
  stop an FGS, but OnePlus "battery optimization" kills apps that are not exempted. The existing device-testing note
  already covers exempting CrewMap.
- Scan mode: `SCAN_MODE_BALANCED` (about a 25 % duty cycle) while the cars are within range of each other.
  `LOW_LATENCY` only in tunnels (when GPS and the network drop together).
- Library: `react-native-ble-plx` only acts as a central (it cannot advertise), and the old advertiser packages
  support legacy advertising only. We need a small Kotlin Expo module in `packages/platform/android`
  (`BluetoothLeAdvertiser.startAdvertisingSet` with `PHY_LE_CODED`, `BluetoothLeScanner` with filters), exposed as a
  `ProximityRadio` interface (`advertise(bytes)`, `onBeacon(cb)`, `capabilities()`).

## iOS
CoreBluetooth gives no control over extended advertising or Coded PHY, and it advertises only legacy 28 B packets.
In the background the payload moves to an Apple-only "overflow area" that Android cannot read. An iPhone in a
convoy would need GATT connections (Bitchat style), with connection-setup latency and background limits. Keep iOS
out of scope and record it as a contract gap in `packages/platform/ios`.

## Fit with packages/p2p
- New transport `transport/proximity.ts` beside `nostr.ts`. The `Router` adds it as one more delivery path for kinds
  `presence` and `emote` only. Inbound beacons go through the same dedupe and `PresenceBook` path, and the existing
  newest-timestamp-wins rule settles conflicts with the internet path.
- Crypto: keep libsodium only. The compact beacon reuses the circle epoch key and AEAD, plus the member Ed25519 signature
  (so a member cannot forge another member's position). A rotating 8 B sender tag =
  `crypto_generichash(epochKey, deviceId ‖ floor(t/15 min))` stops outsiders from tracking a device by its beacon.
  Members resolve the tag against the member list. The beacon carries no MAC-address-stable identifier, because
  Android already randomises the advertising address. Replay: drop a beacon whose ts is more than 30 s old or not newer than the last one seen.
- The beacon is a second wire format for the same `Presence` payload (binary, not JSON), with its own tests in
  `packages/p2p/test`. It is not a new protocol.
- `tools/replay` simulator: add a range-limited proximity link model (distance between replayed traces < R, plus a loss
  curve) so router behaviour in tunnels can be tested without phones.

## Battery estimate
Published phone BLE figures: advertising at 1 Hz costs about 0.1–0.5 mA, and a balanced filtered scan costs 2–6 mA
(LOW_LATENCY costs 10–15 mA). On a 4300 mAh battery, 3–7 mA is **about 0.1–0.2 %/h in radio terms; budget 0.3–1 %/h**
for CPU wakeups to open beacons. Compare GPS in navigation at about 30–50 mA, and an LTE radio that keeps waking for
Nostr/WebRTC at about 100–250 mA while active. The beacon only runs during drives, and it can let the app *skip*
cellular retries when peers are in range, so the net cost can be about zero. The prototype must confirm this with
`battery-window.sh` (BT on-time and CPU per UID).

## Effort
- Prototype (Kotlin module + a dev screen showing RSSI, loss %, PHY, max adv length): 2–3 days.
- Production (proximity transport, compact beacon format with tests, router integration, FGS/permission flow,
  Settings toggle, simulator link model, i18n): about 1.5–2 weeks for Android.
- Gateway forwarding: +3–4 days. GATT mesh / iOS: not recommended (2–4 weeks, poor background behaviour).

## Prototype first (go/no-go gate)
1. Read the `isLeCodedPhySupported` / `isLeExtendedAdvertisingSupported` / max-adv-length values on the OnePlus 8 and on
   every crew phone. If most of the crew lack ext-adv, stop.
2. Two phones in two cars, one following the other: log RSSI and beacon loss per second against GPS distance on 1M and on Coded. Then
   an oncoming pass, and a tunnel (Ville-Marie / Louis-H.-La Fontaine are public landmarks). **Go** if 90 % of beacons
   arrive at 100 m on Coded with the phones in pockets or cradles. **No-go** under 50 m.
3. 20 min `battery-window.sh` with the beacon on and off while the location FGS runs.

## Measured baseline
`battery-window.sh 5 app.crewmap.preview` on 2026-11-26, screen off, phone still, not driving: no GPS, no radio
time, no app CPU time, and only the usual system wake locks. While the app is parked it costs nothing, so a beacon
that runs only during drives adds nothing outside drives. A comparison during a drive (location FGS on, beacon on vs off)
is still needed and belongs in prototype step 3.
