const EMPTY = new Uint8Array(0);

export function decodeChunk(base64: string): Uint8Array {
  if (base64 === "") return EMPTY;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i) & 0xff;
  }
  return bytes;
}
