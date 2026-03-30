/*
 * ESP32-S2/S3 RFID to USB Keyboard
 * This makes the ESP32 appear as a standard USB Keyboard.
 * ONLY WORKS ON ESP32-S2, ESP32-S3, or ESP32-C3/C6 with Native USB.
 */

#include <SPI.h>
#include <MFRC522.h>
#include "USB.h"
#include "USBHIDKeyboard.h"

// RFID Pins
#define SS_PIN  5
#define RST_PIN 22

MFRC522 rfid(SS_PIN, RST_PIN);
USBHIDKeyboard Keyboard;

void setup() {
  Serial.begin(115200);
  SPI.begin();
  rfid.PCD_Init();

  // Start the USB Keyboard
  Keyboard.begin();
  USB.begin();

  Serial.println("USB Keyboard Ready.");
}

void loop() {
  // Check if a new card is present
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) {
    return;
  }

  // Calculate UID (Decimal format)
  uint32_t card_ID = 0;
  if (rfid.uid.size == 4) {
    card_ID = (uint32_t)rfid.uid.uidByte[3] << 24 |
              (uint32_t)rfid.uid.uidByte[2] << 16 |
              (uint32_t)rfid.uid.uidByte[1] << 8 |
              (uint32_t)rfid.uid.uidByte[0];
  }

  String output = String(card_ID);
  Serial.println("Scanned ID: " + output);

  // Type the ID via USB
  Serial.println("Typing to USB Keyboard...");
  Keyboard.print(output);
  Keyboard.write(KEY_RETURN); // Press Enter

  // Halt RFID
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  delay(1500); // Prevent duplicate scans
}
