// Board catalog used when no compile server lists the installed boards, plus user-added boards.
// upload(opts) tells the IDE how to flash from the browser:
//   stk500v1 / stk500v2: Arduino AVR bootloaders, esptool: ESP32/ESP8266, uf2: RP2040 drive, download: save the file

const ESP8266_URL = 'https://arduino.esp8266.com/stable/package_esp8266com_index.json';
const RP2040_URL = 'https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json';

const v1 = (speed, pageSize = 128) => ({ method: 'stk500v1', speed, pageSize });
const esp = (speed = 921600, address) => () => ({ method: 'esptool', speed, ...(address != null && { address }) });
const download = note => () => ({ method: 'download', note });
const uf2 = () => ({ method: 'uf2' });

const opt = (option, option_label, values) => ({
  option, option_label,
  values: values.map(([value, value_label], i) => ({ value, value_label, selected: i === 0 })),
});
const cpu = values => opt('cpu', 'Processor', values);
const ESP32_DEBUG = opt('DebugLevel', 'Core Debug Level',
  [['none', 'None'], ['error', 'Error'], ['warn', 'Warn'], ['info', 'Info'], ['debug', 'Debug'], ['verbose', 'Verbose']]);
const ESP32_CDC = opt('CDCOnBoot', 'USB CDC On Boot', [['default', 'Disabled'], ['cdc', 'Enabled']]);
const ESP32_PART = opt('PartitionScheme', 'Partition Scheme',
  [['default', 'Default 4MB with spiffs'], ['huge_app', 'Huge APP (3MB No OTA)'], ['min_spiffs', 'Minimal SPIFFS (1.9MB APP with OTA)'], ['no_ota', 'No OTA (2MB APP/2MB SPIFFS)']]);

const AVR = 'Arduino AVR', ESP32 = 'Espressif ESP32', ESP8266 = 'Espressif ESP8266', RP = 'Raspberry Pi RP2040', OTHER = 'Arduino (other)';

export const CATALOG = [
  { name: 'Arduino Uno', fqbn: 'arduino:avr:uno', group: AVR, upload: () => v1(115200) },
  {
    name: 'Arduino Nano', fqbn: 'arduino:avr:nano', group: AVR,
    options: [cpu([['atmega328', 'ATmega328P'], ['atmega328old', 'ATmega328P (Old Bootloader)'], ['atmega168', 'ATmega168']])],
    upload: o => v1({ atmega328old: 57600, atmega168: 19200 }[o.cpu] || 115200),
  },
  {
    name: 'Arduino Mega or Mega 2560', fqbn: 'arduino:avr:mega', group: AVR,
    options: [cpu([['atmega2560', 'ATmega2560 (Mega 2560)'], ['atmega1280', 'ATmega1280']])],
    upload: o => (o.cpu === 'atmega1280' ? v1(57600, 256) : { method: 'stk500v2', speed: 115200, pageSize: 256 }),
  },
  {
    name: 'Arduino Pro or Pro Mini', fqbn: 'arduino:avr:pro', group: AVR,
    options: [cpu([['16MHzatmega328', 'ATmega328P (5V, 16 MHz)'], ['8MHzatmega328', 'ATmega328P (3.3V, 8 MHz)']])],
    upload: () => v1(57600),
  },
  { name: 'Arduino Leonardo', fqbn: 'arduino:avr:leonardo', group: AVR, upload: download('Leonardo uses a USB bootloader the browser cannot drive yet; the .hex file is downloaded.') },
  { name: 'Arduino Micro', fqbn: 'arduino:avr:micro', group: AVR, upload: download('Micro uses a USB bootloader the browser cannot drive yet; the .hex file is downloaded.') },

  { name: 'ESP32 Dev Module', fqbn: 'esp32:esp32:esp32', group: ESP32, options: [ESP32_DEBUG, ESP32_PART], upload: esp() },
  { name: 'ESP32-S3 Dev Module', fqbn: 'esp32:esp32:esp32s3', group: ESP32, options: [ESP32_DEBUG, ESP32_CDC, ESP32_PART], upload: esp() },
  { name: 'ESP32-C3 Dev Module', fqbn: 'esp32:esp32:esp32c3', group: ESP32, options: [ESP32_DEBUG, ESP32_CDC, ESP32_PART], upload: esp() },
  { name: 'ESP32-S2 Dev Module', fqbn: 'esp32:esp32:esp32s2', group: ESP32, options: [ESP32_DEBUG, ESP32_CDC, ESP32_PART], upload: esp() },
  { name: 'ESP32-C6 Dev Module', fqbn: 'esp32:esp32:esp32c6', group: ESP32, options: [ESP32_DEBUG, ESP32_CDC, ESP32_PART], upload: esp() },
  { name: 'ESP32-H2 Dev Module', fqbn: 'esp32:esp32:esp32h2', group: ESP32, options: [ESP32_DEBUG, ESP32_CDC], upload: esp() },
  { name: 'Seeed XIAO ESP32-C3', fqbn: 'esp32:esp32:XIAO_ESP32C3', group: ESP32, options: [ESP32_DEBUG], upload: esp() },
  { name: 'Seeed XIAO ESP32-S3', fqbn: 'esp32:esp32:XIAO_ESP32S3', group: ESP32, options: [ESP32_DEBUG], upload: esp() },

  { name: 'NodeMCU 1.0 (ESP-12E)', fqbn: 'esp8266:esp8266:nodemcuv2', group: ESP8266, url: ESP8266_URL, upload: esp(115200, 0) },
  { name: 'LOLIN (Wemos) D1 mini', fqbn: 'esp8266:esp8266:d1_mini', group: ESP8266, url: ESP8266_URL, upload: esp(115200, 0) },
  { name: 'Generic ESP8266 Module', fqbn: 'esp8266:esp8266:generic', group: ESP8266, url: ESP8266_URL, upload: esp(115200, 0) },

  { name: 'Raspberry Pi Pico', fqbn: 'rp2040:rp2040:rpipico', group: RP, url: RP2040_URL, upload: uf2 },
  { name: 'Raspberry Pi Pico W', fqbn: 'rp2040:rp2040:rpipicow', group: RP, url: RP2040_URL, upload: uf2 },
  { name: 'Raspberry Pi Pico 2', fqbn: 'rp2040:rp2040:rpipico2', group: RP, url: RP2040_URL, upload: uf2 },

  { name: 'Arduino Nano Every', fqbn: 'arduino:megaavr:nona4809', group: OTHER, upload: download('Nano Every uploads over UPDI; the .hex file is downloaded.') },
  { name: 'Arduino Uno R4 Minima', fqbn: 'arduino:renesas_uno:minima', group: OTHER, upload: download('Uno R4 uses DFU; the .bin file is downloaded.') },
  { name: 'Arduino Uno R4 WiFi', fqbn: 'arduino:renesas_uno:unor4wifi', group: OTHER, upload: download('Uno R4 WiFi uses its own uploader; the .bin file is downloaded.') },
];

export const UPLOAD_METHODS = {
  stk500v1: 'Arduino bootloader (Uno, Nano, Pro Mini)',
  stk500v2: 'Arduino Mega bootloader (STK500v2)',
  esptool: 'ESP32 / ESP8266 (esptool)',
  uf2: 'UF2 drive (RP2040 and similar)',
  download: 'Download firmware file only',
};

// User-added boards live in this browser: { name, fqbn, url, method, speed }
export function customBoards() {
  try { return JSON.parse(localStorage.getItem('webide.customBoards') || '[]'); } catch { return []; }
}

export function saveCustomBoards(list) {
  try { localStorage.setItem('webide.customBoards', JSON.stringify(list)); } catch {}
}

export function customToBoard(c) {
  return {
    name: c.name, fqbn: c.fqbn, group: 'My boards', url: c.url || '', custom: true,
    upload: () => {
      if (c.method === 'esptool') return { method: 'esptool', speed: c.speed || 460800 };
      if (c.method === 'stk500v1') return v1(c.speed || 115200);
      if (c.method === 'stk500v2') return { method: 'stk500v2', speed: c.speed || 115200, pageSize: 256 };
      if (c.method === 'uf2') return uf2();
      return { method: 'download', note: 'This board downloads the firmware file; flash it with the board vendor\'s tool.' };
    },
  };
}

export function allBoards() {
  return [...CATALOG, ...customBoards().map(customToBoard)];
}

// Extra Boards Manager URLs the compile job needs for a board (third-party cores)
export function boardUrls(fqbn) {
  const base = fqbn.split(':').slice(0, 3).join(':');
  const b = allBoards().find(x => x.fqbn === base);
  return b?.url ? [b.url] : [];
}

const SIGNATURES = {
  '1e950f': 'ATmega328P', '1e9514': 'ATmega328', '1e9406': 'ATmega168', '1e940b': 'ATmega168P',
  '1e9801': 'ATmega2560', '1e9703': 'ATmega1280', '1e9587': 'ATmega32U4', '1e9705': 'ATmega1284P',
};
export const avrChipName = sig => SIGNATURES[sig] || 'unknown AVR';
