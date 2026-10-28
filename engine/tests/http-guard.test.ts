import { describe, it, expect } from "vitest";
import { bindHost, loadAuth } from "../src/http-guard.js";

describe("http-guard: loadAuth", () => {
  it("sin ninguna variable no hay auth: es el uso local", () => {
    expect(loadAuth({})).toBeNull();
  });

  it("con las dos variables devuelve las credenciales", () => {
    expect(loadAuth({ MISMEM_AUTH_USER: "brain", MISMEM_AUTH_PASS: "s3cret" })).toEqual({
      user: "brain",
      pass: "s3cret",
    });
  });

  it("con sólo el usuario falla en vez de arrancar abierto", () => {
    expect(() => loadAuth({ MISMEM_AUTH_USER: "brain" })).toThrow(/MISMEM_AUTH_PASS/);
  });

  it("con sólo la contraseña falla en vez de arrancar abierto", () => {
    expect(() => loadAuth({ MISMEM_AUTH_PASS: "s3cret" })).toThrow(/MISMEM_AUTH_USER/);
  });

  it("una variable vacía cuenta como no definida", () => {
    expect(() => loadAuth({ MISMEM_AUTH_USER: "brain", MISMEM_AUTH_PASS: "" })).toThrow(
      /MISMEM_AUTH_PASS/,
    );
  });
});

describe("http-guard: bindHost", () => {
  it("without MISMEM_HTTP_HOST binds loopback only", () => {
    expect(bindHost({})).toBe("127.0.0.1");
  });

  it("an empty value counts as undefined", () => {
    expect(bindHost({ MISMEM_HTTP_HOST: "" })).toBe("127.0.0.1");
  });

  it("an explicit MISMEM_HTTP_HOST wins, which is how containers expose 0.0.0.0", () => {
    expect(bindHost({ MISMEM_HTTP_HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });
});
