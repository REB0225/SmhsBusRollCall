/*
 * ESP32-C3 SuperMini RC522 RFID Reader with BLE
 *
 * ── BLE BEEP PROTOCOL ──────────────────────────────────────────────────────
 * Write a UTF-8 string to CHARACTERISTIC_UUID to trigger the buzzer remotely.
 * A new command immediately cancels any beep currently in progress.
 *
 * Format A – single beep:
 *   "BEEP:<duration_ms>"
 *   Example: "BEEP:500"   → one 500 ms beep
 *
 * Format B – repeated beeps:
 *   "BEEP:<count>:<duration_ms>:<gap_ms>"
 *   Example: "BEEP:3:200:100" → three 200 ms beeps, 100 ms silence between
 *
 * Constraints (enforced in firmware):
 *   duration_ms  : 10 – 5000 ms
 *   count        : 1  – 20
 *   gap_ms       : 0  – 5000 ms
 * ───────────────────────────────────────────────────────────────────────────
 */

#include <SPI.h>
#include <MFRC522.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ── Pin definitions ──────────────────────────────────────────────────────────
#define SS_PIN      32
#define SCK_PIN     33
#define MOSI_PIN    25
#define MISO_PIN    26
#define RST_PIN     27
#define BATTERY_PIN 17
#define BUZZER_PIN  16

// ── BLE UUIDs ────────────────────────────────────────────────────────────────
#define SERVICE_UUID         "4fafc201-1fb5-459e-8fcc-c5c9c331914c"
#define CHARACTERISTIC_UUID  "beb5483e-36e1-4688-b7f5-ea07361b26ac"
#define BATTERY_SERVICE_UUID          (uint16_t)0x180F
#define BATTERY_LEVEL_CHARACTERISTIC  (uint16_t)0x2A19

// ── Non-blocking buzzer state machine ────────────────────────────────────────
struct BuzzerState {
  bool          active    = false;
  bool          inGap     = false; // true while in the silence between beeps
  int           remaining = 0;     // beeps still to play
  int           duration  = 0;     // ms per beep
  int           gap       = 0;     // ms of silence between beeps
  unsigned long nextAt    = 0;     // millis() of next transition
};

BuzzerState bz;

// Drive the buzzer — call every loop(), never blocks.
void buzzerTick() {
  if (!bz.active) return;
  if (millis() < bz.nextAt) return;

  if (!bz.inGap) {
    // Beep just finished → go silent
    noTone(BUZZER_PIN);
    bz.remaining--;
    if (bz.remaining <= 0) {
      bz.active = false;
      return;
    }
    bz.inGap  = true;
    bz.nextAt = millis() + bz.gap;
  } else {
    // Gap finished → start next beep
    tone(BUZZER_PIN, 2000);
    bz.inGap  = false;
    bz.nextAt = millis() + bz.duration;
  }
}

// Start a new pattern — immediately cuts off whatever is playing.
void startBeep(int count, int duration, int gap) {
  count    = constrain(count,    1,  20);
  duration = constrain(duration, 10, 5000);
  gap      = constrain(gap,      0,  5000);

  noTone(BUZZER_PIN);       // kill any ongoing tone instantly
  tone(BUZZER_PIN, 2000);   // first beep starts immediately

  bz.active    = true;
  bz.inGap     = false;
  bz.remaining = count;
  bz.duration  = duration;
  bz.gap       = gap;
  bz.nextAt    = millis() + duration;
}

void startSingleBeep(int duration) {
  startBeep(1, duration, 0);
}

// ── BLE beep command parser ──────────────────────────────────────────────────
bool handleBeepCommand(const String &cmd) {
  if (!cmd.startsWith("BEEP:")) return false;

  String args       = cmd.substring(5);
  int    firstColon = args.indexOf(':');
  int    secondColon = (firstColon >= 0) ? args.indexOf(':', firstColon + 1) : -1;

  if (firstColon < 0) {
    // Format A: BEEP:<duration_ms>
    int dur = args.toInt();
    if (dur <= 0) return false;
    startSingleBeep(dur);
    return true;
  }

  if (secondColon > firstColon) {
    // Format B: BEEP:<count>:<duration_ms>:<gap_ms>
    int cnt = args.substring(0, firstColon).toInt();
    int dur = args.substring(firstColon + 1, secondColon).toInt();
    int gap = args.substring(secondColon + 1).toInt();
    if (cnt <= 0 || dur <= 0) return false;
    startBeep(cnt, dur, gap);
    return true;
  }

  return false;
}

// ── BLE globals ───────────────────────────────────────────────────────────────
BLECharacteristic *pCharacteristic;
BLECharacteristic *pBatteryCharacteristic;
BLEServer         *pServer;
bool deviceConnected    = false;
bool oldDeviceConnected = false;
unsigned long lastBatteryUpdate = 0;

class CharacteristicCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *pChar) override {
    String value = pChar->getValue().c_str();
    value.trim();
    if (value.startsWith("BEEP:")) {
      bool ok = handleBeepCommand(value);
    }
  }
};

class MyServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *pServer) override {
    deviceConnected = true;
  }
  void onDisconnect(BLEServer *pServer) override {
    deviceConnected = false;
  }
};

// ── Battery & RFID ────────────────────────────────────────────────────────────
MFRC522 rfid(SS_PIN, RST_PIN);

int getBatteryLevel() {
  int raw = analogRead(BATTERY_PIN);
  float voltage = (raw / 4095.0) * 3.3 * 2.0;
  int percentage = map((int)(voltage * 100), 330, 420, 0, 100);
  return constrain(percentage, 0, 100);
}

// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  SPI.begin(SCK_PIN, MISO_PIN, MOSI_PIN, SS_PIN);
  rfid.PCD_Init();
  pinMode(BATTERY_PIN, INPUT);

  BLEDevice::init("Smhs-Scanner-2");
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);
  pCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_UUID,
    BLECharacteristic::PROPERTY_READ  |
    BLECharacteristic::PROPERTY_WRITE |
    BLECharacteristic::PROPERTY_NOTIFY
  );
  pCharacteristic->addDescriptor(new BLE2902());
  pCharacteristic->setCallbacks(new CharacteristicCallbacks());
  pService->start();

  BLEService *pBatteryService = pServer->createService(BATTERY_SERVICE_UUID);
  pBatteryCharacteristic = pBatteryService->createCharacteristic(
    BATTERY_LEVEL_CHARACTERISTIC,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  pBatteryCharacteristic->addDescriptor(new BLE2902());
  pBatteryService->start();

  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->addServiceUUID(BATTERY_SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  startSingleBeep(100); // Startup beep
}

// ── Loop ──────────────────────────────────────────────────────────────────────
void loop() {
  buzzerTick(); // Non-blocking buzzer driver — must be first

  if (!deviceConnected && oldDeviceConnected) {
    delay(500);
    pServer->startAdvertising();
    oldDeviceConnected = deviceConnected;
  }

  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = deviceConnected;
    startSingleBeep(200);
    uint8_t level = getBatteryLevel();
    pBatteryCharacteristic->setValue(&level, 1);
    pBatteryCharacteristic->notify();
    lastBatteryUpdate = millis();
  }

  if (deviceConnected && (millis() - lastBatteryUpdate > 30000)) {
    uint8_t level = getBatteryLevel();
    pBatteryCharacteristic->setValue(&level, 1);
    pBatteryCharacteristic->notify();
    lastBatteryUpdate = millis();
  }

  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;

  uint32_t card_ID = 0;
  if (rfid.uid.size == 4) {
    card_ID = (uint32_t)rfid.uid.uidByte[3] << 24 |
              (uint32_t)rfid.uid.uidByte[2] << 16 |
              (uint32_t)rfid.uid.uidByte[1] << 8  |
              (uint32_t)rfid.uid.uidByte[0];
  }

  char buffer[11];
  sprintf(buffer, "%010u", card_ID);
  String output = String(buffer);
  Serial.println(output);
  if (!deviceConnected){
    startSingleBeep(100); // Scan beep (non-blocking)
  }

  if (deviceConnected) {
    pCharacteristic->setValue(output.c_str());
    pCharacteristic->notify();
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  delay(150);
}
