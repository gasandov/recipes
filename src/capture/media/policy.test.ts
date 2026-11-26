import { describe, expect, it } from "vitest";
import { checkPublicMediaUrl } from "./policy";

describe("checkPublicMediaUrl", () => {
  it("accepts a public https image address", () => {
    expect(checkPublicMediaUrl("https://cdn.recetas.example/pollo.jpg")).toMatchObject({ ok: true });
  });

  it.each([
    ["http://cdn.recetas.example/pollo.jpg", "insecure"],
    ["https://user:pass@cdn.recetas.example/pollo.jpg", "invalid"],
    ["not a url", "invalid"],
    ["https://localhost/x.png", "private-host"],
    ["https://192.168.1.4/x.png", "private-host"],
    ["https://[::1]/x.png", "private-host"],
    ["https://impresora.local/x.png", "private-host"],
    ["https://intranet/x.png", "private-host"],
    ["https://scontent.cdninstagram.com/v/t51/x.jpg", "social"],
    ["https://scontent-dfw5-1.xx.fbcdn.net/v/x.jpg", "social"],
    ["https://www.instagram.com/p/abc/media/?size=l", "social"],
    ["https://fb.watch/abc/", "social"],
  ])("refuses %s", (url, reason) => {
    expect(checkPublicMediaUrl(url)).toEqual({ ok: false, reason });
  });
});
