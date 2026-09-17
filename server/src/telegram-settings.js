import crypto from "node:crypto";

export const SETTINGS_NS = "settings";
export const TELEGRAM_KEY = "telegram";
export const DISABLED_KEY = "telegram_disabled";

export function parseSettingsEncryptionKey(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("SETTINGS_ENCRYPTION_KEY is missing");
  }

  const trimmed = raw.trim();

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 32) {
    return decoded;
  }

  throw new Error(
    "SETTINGS_ENCRYPTION_KEY must be 64 hex characters or base64 decoding to exactly 32 bytes"
  );
}

export function encryptTelegramSettings(plaintextObj, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(plaintextObj), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    auth_tag: authTag.toString("base64"),
    updated_at: Date.now(),
  };
}

export function decryptTelegramSettings(encryptedObj, key) {
  if (
    !encryptedObj ||
    !encryptedObj.iv ||
    !encryptedObj.ciphertext ||
    !encryptedObj.auth_tag
  ) {
    throw new Error("[TG] Stored Telegram settings could not be decrypted");
  }

  try {
    const iv = Buffer.from(encryptedObj.iv, "base64");
    const ciphertext = Buffer.from(encryptedObj.ciphertext, "base64");
    const authTag = Buffer.from(encryptedObj.auth_tag, "base64");

    if (iv.length !== 12) {
      throw new Error("[TG] Stored Telegram settings could not be decrypted");
    }

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return JSON.parse(plaintext.toString("utf8"));
  } catch (err) {
    throw new Error("[TG] Stored Telegram settings could not be decrypted");
  }
}

export function maskBotToken(token) {
  if (!token || typeof token !== "string" || token.length <= 8) {
    return "••••••••";
  }
  const prefix = token.slice(0, 4);
  const suffix = token.slice(-4);
  return `${prefix}••••••••${suffix}`;
}

export function validateBotToken(token) {
  if (typeof token !== "string") return false;
  const trimmed = token.trim();
  if (trimmed.length < 10 || trimmed.length > 128) return false;
  if (trimmed !== token) return false;
  if (/[^\x20-\x7e]/.test(trimmed)) return false;
  if (!trimmed.includes(":")) return false;
  return true;
}

export function validateChatId(chatId) {
  if (typeof chatId !== "string") return false;
  const trimmed = chatId.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return false;
  if (trimmed !== chatId) return false;
  if (/[^\x20-\x7e]/.test(trimmed)) return false;
  if (!/^-?\d+$/.test(trimmed) && !/^@[a-zA-Z0-9_]{5,}$/.test(trimmed)) {
    return false;
  }
  return true;
}

export function resolveTelegramConfig(settings, legacyBotToken, legacyChatId, isDisabled) {
  if (isDisabled) {
    return null;
  }

  if (settings && settings.telegram && settings.telegram.ciphertext) {
    return {
      source: "dashboard",
    };
  }

  if (legacyBotToken && legacyChatId) {
    return {
      source: "environment",
      bot_token: legacyBotToken,
      chat_id: legacyChatId,
    };
  }

  return null;
}

export function getDecryptedTelegram(settings, key) {
  if (!settings || !settings.telegram || !settings.telegram.ciphertext) {
    return null;
  }
  try {
    return decryptTelegramSettings(settings.telegram, key);
  } catch {
    return null;
  }
}
