#include "servo_control.h"

#include "driver/ledc.h"

#include "app_config.h"

#define SERVO_FREQ_HZ 50
#define SERVO_DUTY_LOCKED 410
#define SERVO_DUTY_UNLOCKED 615

static bool servo_ready = false;

esp_err_t servo_control_init(void)
{
    ledc_timer_config_t ledc_timer = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .timer_num = LEDC_TIMER_0,
        .duty_resolution = LEDC_TIMER_13_BIT,
        .freq_hz = SERVO_FREQ_HZ,
        .clk_cfg = LEDC_AUTO_CLK
    };
    esp_err_t err = ledc_timer_config(&ledc_timer);
    if (err != ESP_OK) {
        return err;
    }

    ledc_channel_config_t ledc_channel = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_0,
        .timer_sel = LEDC_TIMER_0,
        .intr_type = LEDC_INTR_DISABLE,
        .gpio_num = PIN_SERVO,
        .duty = 0,
        .hpoint = 0
    };
    err = ledc_channel_config(&ledc_channel);
    if (err != ESP_OK) {
        return err;
    }

    servo_ready = true;
    return servo_control_set_locked();
}

esp_err_t servo_control_set_locked(void)
{
    if (!servo_ready) {
        return ESP_ERR_INVALID_STATE;
    }

    esp_err_t err = ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, SERVO_DUTY_LOCKED);
    if (err != ESP_OK) {
        return err;
    }

    return ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

esp_err_t servo_control_set_unlocked(void)
{
    if (!servo_ready) {
        return ESP_ERR_INVALID_STATE;
    }

    esp_err_t err = ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, SERVO_DUTY_UNLOCKED);
    if (err != ESP_OK) {
        return err;
    }

    return ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}
