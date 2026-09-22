import {
  blockSetting,
  type BlockSetting,
} from "../settings/blockSettings";

export const DATE_FORMAT_TOKENS = [
  "YYYY-MM-DD",
  "YYYY-MM-DD HH:MM",
  "YYYY",
  "YYYY-MM",
  "DD-MM-YYYY",
  "DD-MM-YY",
  "MM/DD/YYYY",
  "DD/MM/YYYY",
] as const;

export type DateFormatToken = (typeof DATE_FORMAT_TOKENS)[number];

export const CURRENCY_CODES = ["usd", "nis", "eur"] as const;

export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export const PROPERTIES_DEFAULTS = {
  typedEnabled: false,
  dateFormat: DATE_FORMAT_TOKENS[0],
  currency: CURRENCY_CODES[0],
  tagsKeyAsTags: true,
};

export function propertiesBlockSettings(): BlockSetting[] {
  return [
    blockSetting("properties.typed_enabled", PROPERTIES_DEFAULTS.typedEnabled),
    blockSetting(
      "properties.date_format_default",
      PROPERTIES_DEFAULTS.dateFormat,
    ),
    blockSetting("properties.default_currency", PROPERTIES_DEFAULTS.currency),
    blockSetting(
      "properties.tags_key_as_tags",
      PROPERTIES_DEFAULTS.tagsKeyAsTags,
    ),
  ];
}

declare module "../api/ipc" {
  interface SettingRegistry {
    "properties.typed_enabled": boolean;
    "properties.date_format_default": string;
    "properties.default_currency": string;
    "properties.tags_key_as_tags": boolean;
  }
}
