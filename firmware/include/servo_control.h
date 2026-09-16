#pragma once

#include "esp_err.h"

// Initialize the PWM timer/channel for the lock servo.
esp_err_t servo_control_init(void);

// Move servo to locked/unlocked position.
esp_err_t servo_control_set_locked(void);
esp_err_t servo_control_set_unlocked(void);
