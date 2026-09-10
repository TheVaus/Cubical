import type { StatusbarSegment } from "../settings/statusbarSettings";

export const VAULT_PATH_SEGMENT: StatusbarSegment = {
  id: "vault_path",
  name: "Vault path",
  description: "Show the open vault's folder path on the left.",
  settingKey: "statusbar.show_vault_path",
  defaultVisible: true,
};

export const FILE_PATH_SEGMENT: StatusbarSegment = {
  id: "file_path",
  name: "File path",
  description: "Show the current note's vault-relative path on the right.",
  settingKey: "statusbar.show_file_path",
  defaultVisible: true,
};

export const WORD_COUNT_SEGMENT: StatusbarSegment = {
  id: "word_count",
  name: "Word count",
  description: "Show the current note's word count.",
  settingKey: "statusbar.show_word_count",
  defaultVisible: true,
};

export const BLOCK_COUNT_SEGMENT: StatusbarSegment = {
  id: "block_count",
  name: "Block count",
  description: "Show the current note's block count.",
  settingKey: "statusbar.show_block_count",
  defaultVisible: true,
};

export const STATUSBAR_SEGMENTS: StatusbarSegment[] = [
  VAULT_PATH_SEGMENT,
  FILE_PATH_SEGMENT,
  WORD_COUNT_SEGMENT,
  BLOCK_COUNT_SEGMENT,
];
