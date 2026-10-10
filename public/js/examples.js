// Example sketches and the WebIDEDebug.h serial debugger helper.

export const DEBUG_HEADER = `// WebIDEDebug.h: serial debugger for the Web IDE.
// Turn on "Debug build" in the IDE to compile these helpers in. With it off,
// every macro below compiles to nothing, so you can leave them in your code.
//
//   DBG_WATCH(x)        show x in the Watch table (numbers are also plotted)
//   DBG_LOG("text")     message in the Debug log
//   DBG_BREAK()         pause here until you press Continue in the IDE
//   DBG_BREAK_IF(cond)  pause only when cond is true
//   DBG_ASSERT(cond)    report and pause when cond is false
//   DBG_TRACE()         record that this function/line ran
//   DBG_MEMORY()        watch the free RAM / heap
#pragma once
#include <Arduino.h>

#ifndef WEBIDE_DEBUG_PORT
#define WEBIDE_DEBUG_PORT Serial
#endif

#ifdef WEBIDE_DEBUG

#ifdef __AVR__
extern int __heap_start, *__brkval;  // heap bounds from avr-libc, used by DBG_MEMORY()
#endif

namespace webide_debug {
inline const char *base(const char *path) {
  const char *b = path;
  for (const char *p = path; *p; p++)
    if (*p == '/' || *p == '\\\\') b = p + 1;
  return b;
}
inline bool &running() { static bool r = false; return r; }
inline void where(const char *file, int line) {
  WEBIDE_DEBUG_PORT.print(base(file));
  WEBIDE_DEBUG_PORT.print(':');
  WEBIDE_DEBUG_PORT.println(line);
}
// Waits for the IDE: 'c' = continue, 'r' = run (ignore further breakpoints until reset)
inline void pause(const char *file, int line) {
  if (running()) return;
  WEBIDE_DEBUG_PORT.print(F("@dbg break "));
  where(file, line);
  for (;;) {
    while (!WEBIDE_DEBUG_PORT.available()) { delay(2); }
    int c = WEBIDE_DEBUG_PORT.read();
    if (c == 'c') break;
    if (c == 'r') { running() = true; break; }
  }
  WEBIDE_DEBUG_PORT.println(F("@dbg resume"));
}
inline long freeMemory() {
#if defined(ESP32) || defined(ESP8266)
  return (long)ESP.getFreeHeap();
#elif defined(__AVR__)
  int top;
  return (long)((int)&top - (__brkval == 0 ? (int)&__heap_start : (int)__brkval));
#else
  return -1;
#endif
}
}  // namespace webide_debug

#define DBG_WATCH(var) do { WEBIDE_DEBUG_PORT.print(F("@dbg watch " #var "=")); WEBIDE_DEBUG_PORT.println(var); } while (0)
#define DBG_LOG(msg) do { WEBIDE_DEBUG_PORT.print(F("@dbg log ")); WEBIDE_DEBUG_PORT.println(msg); } while (0)
#define DBG_BREAK() webide_debug::pause(__FILE__, __LINE__)
#define DBG_BREAK_IF(cond) do { if (cond) webide_debug::pause(__FILE__, __LINE__); } while (0)
#define DBG_ASSERT(cond) do { if (!(cond)) { WEBIDE_DEBUG_PORT.print(F("@dbg assert " #cond " ")); webide_debug::where(__FILE__, __LINE__); webide_debug::pause(__FILE__, __LINE__); } } while (0)
#define DBG_TRACE() do { WEBIDE_DEBUG_PORT.print(F("@dbg trace ")); WEBIDE_DEBUG_PORT.print(__func__); WEBIDE_DEBUG_PORT.print(' '); webide_debug::where(__FILE__, __LINE__); } while (0)
#define DBG_MEMORY() do { WEBIDE_DEBUG_PORT.print(F("@dbg watch freeMemory=")); WEBIDE_DEBUG_PORT.println(webide_debug::freeMemory()); } while (0)

#else

#define DBG_WATCH(var) do {} while (0)
#define DBG_LOG(msg) do {} while (0)
#define DBG_BREAK() do {} while (0)
#define DBG_BREAK_IF(cond) do {} while (0)
#define DBG_ASSERT(cond) do {} while (0)
#define DBG_TRACE() do {} while (0)
#define DBG_MEMORY() do {} while (0)

#endif
`;

const BLINK = `// Blink the built-in LED and print to the Serial Monitor
// Most ESP32 dev boards have their LED on GPIO 2
#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.println("LED on");
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  Serial.println("LED off");
  delay(500);
}
`;

const PLOTTER = `// Open the Plotter tab to see these waves live.
// Print "name:value" pairs separated by spaces or commas, one line per sample.

void setup() {
  Serial.begin(115200);
}

void loop() {
  static float t = 0;
  Serial.print("sine:");
  Serial.print(sin(t) * 100);
  Serial.print(" cosine:");
  Serial.print(cos(t) * 100);
  Serial.print(" sawtooth:");
  Serial.println(fmod(t * 20, 100));
  t += 0.1;
  delay(30);
}
`;

const DEBUGGER = `// Serial debugger demo.
// 1. Turn on "Debug build" (bug button in the toolbar)
// 2. Upload, then open the Debug tab: watch values update live,
//    and the board pauses at DBG_BREAK_IF until you press Continue.
#include "WebIDEDebug.h"
// Most ESP32 dev boards have their LED on GPIO 2
#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

int counter = 0;
float temperature = 21.5;

int average(int a, int b) {
  DBG_TRACE();
  return (a + b) / 2;
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  DBG_LOG("Debugger demo started");
  DBG_MEMORY();
}

void loop() {
  counter++;
  temperature += random(-10, 11) / 10.0;
  DBG_WATCH(counter);
  DBG_WATCH(temperature);

  int avg = average(counter, 10);
  DBG_WATCH(avg);

  // Pauses every 10th loop; press Continue (or Run) in the Debug tab
  DBG_BREAK_IF(counter % 10 == 0);
  DBG_ASSERT(counter < 1000);

  digitalWrite(LED_BUILTIN, counter % 2);
  delay(500);
}
`;

const SERIAL_ECHO = `// Type in the Serial Monitor input and press Enter: the board answers.
// Most ESP32 dev boards have their LED on GPIO 2
#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println("Ready. Send me something!");
}

void loop() {
  if (Serial.available()) {
    String line = Serial.readStringUntil('\\n');
    line.trim();
    Serial.print("You said: ");
    Serial.println(line);
    if (line == "on") digitalWrite(LED_BUILTIN, HIGH);
    if (line == "off") digitalWrite(LED_BUILTIN, LOW);
  }
}
`;

const ANALOG = `// Read a potentiometer or sensor on A0 and plot it (Plotter tab).

void setup() {
  Serial.begin(115200);
}

void loop() {
  int raw = analogRead(A0);
  Serial.print("raw:");
  Serial.println(raw);
  delay(20);
}
`;

const BUTTON = `// Debounced button on pin 4 (to GND) toggles the LED.
// Most ESP32 dev boards have their LED on GPIO 2
#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

const int BUTTON_PIN = 4;
bool ledOn = false;
int lastReading = HIGH, stableState = HIGH;
unsigned long lastChange = 0;

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  int reading = digitalRead(BUTTON_PIN);
  if (reading != lastReading) lastChange = millis();
  if (millis() - lastChange > 30 && reading != stableState) {
    stableState = reading;
    if (stableState == LOW) {
      ledOn = !ledOn;
      digitalWrite(LED_BUILTIN, ledOn);
      Serial.println(ledOn ? "LED on" : "LED off");
    }
  }
  lastReading = reading;
}
`;

const WIFI_SCAN = `// ESP32 / ESP8266: list nearby Wi-Fi networks every 5 seconds.
#if defined(ESP32)
#include <WiFi.h>
#else
#include <ESP8266WiFi.h>
#endif

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
}

void loop() {
  Serial.println("Scanning...");
  int n = WiFi.scanNetworks();
  for (int i = 0; i < n; i++) {
    Serial.printf("%2d  %-32s  %4d dBm  ch %d\\n", i + 1, WiFi.SSID(i).c_str(), WiFi.RSSI(i), WiFi.channel(i));
  }
  Serial.println();
  delay(5000);
}
`;

const ESP_CRASH = `// ESP32 crash decoder demo: type "crash" in the Serial Monitor.
// The board panics and the Debug tab turns the backtrace into function names and lines.

void doCrash() {
  volatile int *p = nullptr;
  *p = 42;  // invalid write: Guru Meditation Error
}

void setup() {
  Serial.begin(115200);
  Serial.println("Type 'crash' and press Enter");
}

void loop() {
  if (Serial.available() && Serial.readStringUntil('\\n').startsWith("crash")) doCrash();
}
`;

export const EXAMPLES = [
  { name: 'Blink', desc: 'Blink the built-in LED and print to serial', files: { 'Blink.ino': BLINK } },
  { name: 'Debugger', desc: 'Watches, breakpoints, trace and asserts', files: { 'Debugger.ino': DEBUGGER, 'WebIDEDebug.h': DEBUG_HEADER } },
  { name: 'SerialPlotter', desc: 'Sine, cosine and sawtooth for the Plotter', files: { 'SerialPlotter.ino': PLOTTER } },
  { name: 'SerialEcho', desc: 'Send commands from the Serial Monitor', files: { 'SerialEcho.ino': SERIAL_ECHO } },
  { name: 'AnalogPlot', desc: 'Plot a sensor on A0', files: { 'AnalogPlot.ino': ANALOG } },
  { name: 'Button', desc: 'Debounced button toggles the LED', files: { 'Button.ino': BUTTON } },
  { name: 'WiFiScan', desc: 'ESP32 / ESP8266: list Wi-Fi networks', files: { 'WiFiScan.ino': WIFI_SCAN } },
  { name: 'CrashDecoder', desc: 'ESP32: decode a crash backtrace', files: { 'CrashDecoder.ino': ESP_CRASH } },
];

export const DEFAULT_SKETCH = BLINK;
