/*
 * ESP32 RFID to Bluetooth Keyboard
 * This makes the ESP32 appear as a Bluetooth Keyboard.
 * When a card is scanned, it "types" the UID and presses Enter.
 */

#include <SPI.h>
#include <MFRC522.h>
#include <BleKeyboard.h>

// RFID Pins (Matching your previous setup)
#define SS_PIN  5
#define RST_PIN 22

MFRC522 rfid(SS_PIN, RST_PIN);
BleKeyboard bleKeyboard("ESP32-RFID-Keyboard", "ESP32-Tools", 100);

void setup() {
  Serial.begin(115200);
  SPI.begin();
  rfid.PCD_Init();

  Serial.println("Starting BLE Keyboard...");
  bleKeyboard.begin();
  
  Serial.println("Waiting for Bluetooth connection...");
}

void loop() {
  // Check if a new card is present
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) {
    return;
  }

  // Calculate UID (Decimal format matching your database)
  uint32_t card_ID = 0;
  if (rfid.uid.size == 4) {
    card_ID = (uint32_t)rfid.uid.uidByte[3] << 24 |
              (uint32_t)rfid.uid.uidByte[2] << 16 |
              (uint32_t)rfid.uid.uidByte[1] << 8 |
              (uint32_t)rfid.uid.uidByte[0];
  }

  String output = String(card_ID);
  Serial.println("Scanned ID: " + output);

  // If Bluetooth is connected, "type" the ID
  if (bleKeyboard.isConnected()) {
    Serial.println("Typing to keyboard...");
    bleKeyboard.print(output);
    bleKeyboard.write(KEY_RETURN); // Press Enter after typing
  } else {
    Serial.println("Error: Keyboard not connected via Bluetooth.");
  }

  // Halt RFID
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  delay(1500); // Prevent duplicate scans
}
