// SHA-256，返回 64 位十六进制小写字符串
export async function sha256(blob) {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const shortHash = h => (h || '').slice(0, 8);
