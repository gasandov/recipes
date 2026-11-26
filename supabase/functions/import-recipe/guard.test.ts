import { describe, expect, it } from "vitest";
import { hostAllowed, isPrivateAddress, isUnsupportedSource, parseHostList, parseImportUrl, policyConfigured } from "./guard.ts";

const code = (input: unknown) => {
  const result = parseImportUrl(input);
  return result.ok ? "ok" : result.code;
};

describe("parseImportUrl", () => {
  it("accepts a plain public HTTPS URL, including explicit port 443 and IDN hosts", () => {
    expect(code("https://www.recetas.example/pollo?x=1#y")).toBe("ok");
    expect(code("https://recetas.example:443/a")).toBe("ok");
    expect(code("https://recetas.example:443/a")).toBe("ok");
    const idn = parseImportUrl("https://cocina-mexicana.mx/ñoquis");
    expect(idn.ok).toBe(true);
  });

  it.each([
    ["http://recetas.example/", "unsafe_destination"],
    ["ftp://recetas.example/", "invalid_url"],
    ["javascript:alert(1)", "invalid_url"],
    ["file:///etc/passwd", "invalid_url"],
    ["https://user:pass@recetas.example/", "unsafe_destination"],
    ["https://recetas.example:8443/", "unsafe_destination"],
    ["https://recetas.example:80/", "unsafe_destination"],
    ["https://localhost/", "unsafe_destination"],
    ["https://localhost./", "unsafe_destination"],
    ["https://recetas.example./", "unsafe_destination"],
    ["https://127.0.0.1/", "unsafe_destination"],
    ["https://2130706433/", "unsafe_destination"],
    ["https://0x7f.1/", "unsafe_destination"],
    ["https://0177.0.0.1/", "unsafe_destination"],
    ["https://[::1]/", "unsafe_destination"],
    ["https://[::ffff:7f00:1]/", "unsafe_destination"],
    ["https://169.254.169.254/latest/meta-data", "unsafe_destination"],
    ["https://10.0.0.5/", "unsafe_destination"],
    ["https://metadata/", "unsafe_destination"],
    ["https://printer.local/", "unsafe_destination"],
    ["https://db.internal/", "unsafe_destination"],
    ["https://app.example.123/", "invalid_url"],
    ["not a url", "invalid_url"],
    ["", "invalid_url"],
    [42, "invalid_url"],
    ["https://recetas.example/a b", "invalid_url"],
    ["https://recetas.example/\\@evil.example", "invalid_url"],
  ])("rejects %s", (input, expected) => {
    expect(code(input)).toBe(expected);
  });

  it("rejects overly long URLs", () => {
    expect(code(`https://recetas.example/${"a".repeat(3000)}`)).toBe("invalid_url");
  });
});

describe("isPrivateAddress", () => {
  it.each([
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "100.127.255.255", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.9.9",
    "192.168.1.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2002:a00:1::", "ff02::1", "2001:db8::1", "garbage",
  ])("blocks %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.63.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2001:4860:4860::8888"])(
    "allows %s",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

describe("host policy", () => {
  it("matches exact hosts and wildcard subdomains but not lookalikes", () => {
    const policy = { allowedHosts: parseHostList("recetas.example, *.cocina.example"), allowAnyPublicHost: true };
    expect(hostAllowed("recetas.example", policy)).toBe(true);
    expect(hostAllowed("RECETAS.example", policy)).toBe(true);
    expect(hostAllowed("www.cocina.example", policy)).toBe(true);
    expect(hostAllowed("cocina.example", policy)).toBe(false);
    expect(hostAllowed("evilcocina.example", policy)).toBe(false);
    expect(hostAllowed("recetas.example.evil.test", policy)).toBe(false);
    expect(hostAllowed("otro.example", policy)).toBe(false);
  });

  it("fails closed when nothing is configured", () => {
    expect(policyConfigured({ allowedHosts: [], allowAnyPublicHost: false })).toBe(false);
    expect(hostAllowed("recetas.example", { allowedHosts: [], allowAnyPublicHost: false })).toBe(false);
    expect(hostAllowed("recetas.example", { allowedHosts: [], allowAnyPublicHost: true })).toBe(true);
  });
});

describe("isUnsupportedSource", () => {
  it("blocks Meta properties and their subdomains, not lookalikes", () => {
    for (const host of ["instagram.com", "www.instagram.com", "m.facebook.com", "fb.watch", "scontent.cdninstagram.com"]) {
      expect(isUnsupportedSource(host)).toBe(true);
    }
    for (const host of ["notinstagram.com", "facebook.com.evil.example", "recetas.example"]) expect(isUnsupportedSource(host)).toBe(false);
  });
});
