// Local override template for non-secret firmware configuration.
// Copy to `app_config_local.h` and adjust pins/timing for your hardware.
// This file is an EXAMPLE; values here are placeholders, not live settings.

#pragma once

// Example GPIO map (verify against your own wiring before use).
// These mirror the defaults already defined in main.c / servo_control.h.
#define SERVO_PIN               13
#define LED_PIN                 2
#define BUZZER_PIN              15
#define PIR_PIN                 14
#define REED_PIN                27
#define KEYPAD_ROWS 4
#define KEYPAD_COLS 4
