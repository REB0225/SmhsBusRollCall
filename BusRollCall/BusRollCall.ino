/*
 * ESP32-C3 SuperMini RC522 RFID Reader with BLE
 */

#include <SPI.h>
#include <MFRC522.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ESP32-C3 SuperMini Pinout
#define SS_PIN    5
#define SCK_PIN   6
#define MOSI_PIN  7
#define MISO_PIN  8
#define RST_PIN   20
#define BATTERY_PIN 3
#define BUZZER_PIN  1

// BLE UUIDs
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

// Battery Service UUIDs
#define BATTERY_SERVICE_UUID        (uint16_t)0x180F
#define BATTERY_LEVEL_CHARACTERISTIC (uint16_t)0x2A19

MFRC522 rfid(SS_PIN, RST_PIN);
BLECharacteristic *pCharacteristic;
BLECharacteristic *pBatteryCharacteristic;
BLEServer *pServer;
bool deviceConnected = false;
bool oldDeviceConnected = false;
unsigned long lastBatteryUpdate = 0;

class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) { 
      deviceConnected = true; 
      Serial.println("BLE Client Connected");
    };
    void onDisconnect(BLEServer* pServer) { 
      deviceConnected = false;
      Serial.println("BLE Client Disconnected");
    }
};

void beep(int duration) {
  tone(BUZZER_PIN, 2000);
  delay(duration);
  noTone(BUZZER_PIN);
}

int getBatteryLevel() {
  int raw = analogRead(BATTERY_PIN);
  // ESP32-C3 ADC is 12-bit (0-4095). Internal ref is approx 1.1V with attenuation.
  // SuperMini often uses a divider. Adjust voltage calculation if needed.
  float voltage = (raw / 4095.0) * 3.3 * 2.0; 
  int percentage = map(voltage * 100, 330, 420, 0, 100);
  return constrain(percentage, 0, 100);
}

void setup() {
  Serial.begin(115200);
  
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  
  // Initialize SPI for C3
  SPI.begin(SCK_PIN, MISO_PIN, MOSI_PIN, SS_PIN);
  rfid.PCD_Init();
  pinMode(BATTERY_PIN, INPUT);

  BLEDevice::init("ESP32-C3-Scanner");
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  // RFID Service
  BLEService *pService = pServer->createService(SERVICE_UUID);
  pCharacteristic = pService->createCharacteristic(
                      CHARACTERISTIC_UUID,
                      BLECharacteristic::PROPERTY_READ   |
                      BLECharacteristic::PROPERTY_WRITE  |
                      BLECharacteristic::PROPERTY_NOTIFY 
                    );
  pCharacteristic->addDescriptor(new BLE2902());
  pService->start();

  // Battery Service
  BLEService *pBatteryService = pServer->createService(BATTERY_SERVICE_UUID);
  pBatteryCharacteristic = pBatteryService->createCharacteristic(
                            BATTERY_LEVEL_CHARACTERISTIC,
                            BLECharacteristic::PROPERTY_READ | 
                            BLECharacteristic::PROPERTY_NOTIFY
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

  Serial.println("BLE Ready (C3). Waiting for connection...");
  beep(100); // Startup beep
}

void loop() {
  // Handle disconnection and advertising restart
  if (!deviceConnected && oldDeviceConnected) {
    delay(500); 
    pServer->startAdvertising(); 
    Serial.println("Restarted Advertising...");
    oldDeviceConnected = deviceConnected;
  }

  // Handle new connection
  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = deviceConnected;
    beep(200); // Connection beep
  }

  if (deviceConnected && (millis() - lastBatteryUpdate > 30000)) {
    uint8_t level = getBatteryLevel();
    pBatteryCharacteristic->setValue(&level, 1);
    pBatteryCharacteristic->notify();
    lastBatteryUpdate = millis();
  }

  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) {
    return;
  }

  uint32_t card_ID = 0;
  if (rfid.uid.size == 4) {
    card_ID = (uint32_t)rfid.uid.uidByte[3] << 24 |
              (uint32_t)rfid.uid.uidByte[2] << 16 |
              (uint32_t)rfid.uid.uidByte[1] << 8 |
              (uint32_t)rfid.uid.uidByte[0];
  }

  char buffer[11];
  sprintf(buffer, "%010u", card_ID);
  String output = String(buffer);
  Serial.println("Scanned ID: " + output);
  beep(100); // Scan beep

  if (deviceConnected) {
    pCharacteristic->setValue(output.c_str());
    pCharacteristic->notify();
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  delay(1000);
}
