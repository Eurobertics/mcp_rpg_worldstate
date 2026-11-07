import { createHash, timingSafeEqual } from "node:crypto";
export function bearerAuth(token: string): (header: string | undefined) => boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(token);
  return (header) => {
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(header ?? "");
    return match !== null && timingSafeEqual(digest(match[1]!), expected);
  };
}
