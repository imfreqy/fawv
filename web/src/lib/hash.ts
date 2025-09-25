export async function sha256Hex(file: File): Promise<`0x${string}`> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `0x${hex}` as `0x${string}`;
}
// sha256 is already 32 bytes, so it's a valid bytes32 literal
export function toBytes32(sha: `0x${string}`): `0x${string}` {
  if (sha.length !== 66) throw new Error("sha256 length != 32 bytes");
  return sha;
}
