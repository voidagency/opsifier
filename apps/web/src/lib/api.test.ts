import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, isApiError, setUnauthorizedHandler } from "./api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(response: Response | Error): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) {
      throw response;
    }
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => {
      throw new Error("expected the request to fail");
    },
    (cause: unknown) => cause,
  );
  expect(isApiError(error)).toBe(true);
  return error as ApiError;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(undefined);
});

describe("api error mapping", () => {
  it("carries the API's code, message and fields on a validation failure", async () => {
    stubFetch(
      jsonResponse(400, {
        error: {
          code: "validation_failed",
          message: "Some fields need attention.",
          fields: { email: "Invalid email", password: "Use at least 12 characters" },
        },
      }),
    );

    const error = await failure(api.post("/auth/setup", { body: { email: "x" } }));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(400);
    expect(error.code).toBe("validation_failed");
    expect(error.message).toBe("Some fields need attention.");
    expect(error.fields).toEqual({ email: "Invalid email", password: "Use at least 12 characters" });
  });

  it("gives an empty field map when the API sends none", async () => {
    stubFetch(jsonResponse(401, { error: { code: "two_factor_required", message: "Code needed." } }));

    const error = await failure(api.post("/auth/login"));

    expect(error.status).toBe(401);
    expect(error.code).toBe("two_factor_required");
    expect(error.fields).toEqual({});
    expect(error.isNetworkError).toBe(false);
  });

  it("reports a body that is not JSON as a bad response", async () => {
    stubFetch(new Response("<html>Oops</html>", { status: 500, statusText: "Server Error" }));

    const error = await failure(api.get("/system/info"));

    expect(error.status).toBe(500);
    expect(error.code).toBe("bad_response");
    expect(error.fields).toEqual({});
  });

  it("treats a gateway error page as the server being unreachable", async () => {
    stubFetch(new Response("<html>Bad gateway</html>", { status: 502, statusText: "Bad Gateway" }));

    const error = await failure(api.get("/system/info"));

    expect(error.status).toBe(502);
    expect(error.isNetworkError).toBe(true);
  });

  it("reports JSON that is not the error shape as a bad response", async () => {
    stubFetch(jsonResponse(500, { oops: true }));

    const error = await failure(api.get("/system/info"));

    expect(error.status).toBe(500);
    expect(error.code).toBe("bad_response");
  });

  it("marks a request that never reached the server", async () => {
    stubFetch(new TypeError("Failed to fetch"));

    const error = await failure(api.get("/auth/session"));

    expect(error.status).toBe(0);
    expect(error.code).toBe("network");
    expect(error.isNetworkError).toBe(true);
  });

  it("lets an abort through untouched", async () => {
    const controller = new AbortController();
    const abort = new DOMException("Aborted", "AbortError");
    stubFetch(abort);
    controller.abort();

    await expect(api.get("/system/info", { signal: controller.signal })).rejects.toBe(abort);
  });

  it("treats a response that fails its schema as a bad response", async () => {
    stubFetch(jsonResponse(200, { unexpected: true }));
    const schema = {
      parse: (data: unknown) => {
        throw new Error(`not valid: ${JSON.stringify(data)}`);
      },
    };

    const error = await failure(api.get("/system/info", { schema }));

    expect(error.status).toBe(200);
    expect(error.code).toBe("bad_response");
  });

  it("returns the parsed body on success and sends JSON", async () => {
    const fetchMock = stubFetch(jsonResponse(200, { ok: true }));

    await expect(
      api.post<{ ok: boolean }>("/auth/login", { body: { email: "a@b.c" }, query: { keep: 1, skip: null } }),
    ).resolves.toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/auth/login?keep=1");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ email: "a@b.c" }));
  });
});

describe("the unauthorized handler", () => {
  it("runs when a signed-in request comes back 401", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    stubFetch(jsonResponse(401, { error: { code: "unauthorized", message: "Sign in." } }));

    await failure(api.get("/system/info"));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("stays out of the sign-in endpoints, where a 401 is the answer", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    stubFetch(jsonResponse(401, { error: { code: "invalid_credentials", message: "Wrong password." } }));

    await failure(api.post("/auth/login", { body: {} }));

    expect(handler).not.toHaveBeenCalled();
  });
});
