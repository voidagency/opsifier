// @vitest-environment jsdom
import "../../../../testing/browser-stubs";
import { buildpacksBuilders, type ServiceDetail, type SourceSettings } from "@opsifier/contract";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expectLocation,
  type FakeRoute,
  installFakeServer,
  renderApp,
  resetApp,
  withStatus,
} from "../../../../testing/appHarness";

vi.mock("../../../../ui/CodeEditor", () => ({
  CodeEditor: ({
    value,
    onChange,
    label,
  }: {
    value: string;
    onChange: (value: string) => void;
    label: string;
  }) => <textarea aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />,
}));

afterEach(resetApp);

const SOURCE_PATH = "/projects/shop/services/web/source";
const GIT = { type: "git", url: "https://git.example.com/acme/shop.git", ref: "main", path: "/" } as const;

const detail = (overrides: Partial<ServiceDetail> = {}): ServiceDetail => ({
  projectName: "shop",
  name: "web",
  type: "app",
  status: "running",
  replicas: { running: 1, desired: 1 },
  activeAction: null,
  wake: ["succeeded"],
  lastDeployedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  source: { type: "image", image: "traefik/whoami:v1.10", username: null, hasPassword: false },
  notes: "",
  stopped: false,
  primaryUrl: "https://shop-web.example.test/",
  ...overrides,
});

const settings = (overrides: Partial<SourceSettings> = {}): SourceSettings => ({
  source: null,
  build: null,
  sshPublicKey: null,
  githubConfigured: false,
  ...overrides,
});

const metrics = {
  cpuPercent: 1.5,
  memoryUsedBytes: 67108864,
  networkRxBytes: 2048,
  networkTxBytes: 4096,
  readAt: "2026-01-01T00:00:00.000Z",
};

const routes = (service: ServiceDetail, extra: FakeRoute = {}): FakeRoute => ({
  "GET /projects": { projects: [{ name: "shop", createdAt: "2026-01-01T00:00:00.000Z", services: [] }] },
  "GET /projects/shop/services/web": service,
  "GET /projects/shop/services/web/metrics": metrics,
  [`GET ${SOURCE_PATH}`]: settings(),
  ...extra,
});

async function openInit(extra: FakeRoute = {}) {
  const server = installFakeServer(routes(detail({ source: null, status: "undeployed" }), extra));
  const app = renderApp("/projects/shop/app/web/init/source");
  await screen.findByRole("tab", { name: "Git" });
  return { server, app };
}

async function openSource(service: Partial<ServiceDetail>, extra: FakeRoute = {}) {
  const server = installFakeServer(routes(detail(service), extra));
  const app = renderApp("/projects/shop/app/web/source");
  await screen.findByRole("tab", { name: "Git" });
  return { server, app };
}

/** Radix opens a tab on mouse down, not on click. */
function selectTab(name: string): void {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 });
}

const puts = (server: ReturnType<typeof installFakeServer>, path = SOURCE_PATH) =>
  server.calls.filter((call) => call.method === "PUT" && call.path === path);

const fillGit = () => {
  fireEvent.change(screen.getByLabelText("Repository URL"), { target: { value: GIT.url } });
  fireEvent.change(screen.getByLabelText("Branch"), { target: { value: GIT.ref } });
};

describe("the init screen", () => {
  it("offers every kind of source and starts on a Docker image", async () => {
    await openInit();

    for (const name of ["Docker image", "GitHub", "Git", "Dockerfile", "Upload"]) {
      expect(screen.getByRole("tab", { name })).toBeTruthy();
    }
    expect(await screen.findByLabelText("Image")).toBeTruthy();
  });

  it("saves a Git source with its build settings in one go and leaves the screen", async () => {
    const { server, app } = await openInit({ [`PUT ${SOURCE_PATH}`]: GIT });
    selectTab("Git");
    await screen.findByLabelText("Repository URL");
    fillGit();
    fireEvent.click(screen.getByRole("radio", { name: /Dockerfile/ }));
    fireEvent.change(await screen.findByLabelText(/Dockerfile path/), {
      target: { value: "docker/Dockerfile" },
    });
    server.set({ "GET /projects/shop/services/web": detail({ source: GIT }) });

    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    await expectLocation(app, "/projects/shop/app/web");
    expect(puts(server)[0]?.body).toMatchObject({
      ...GIT,
      build: { type: "dockerfile", file: "docker/Dockerfile" },
    });
  });

  it("needs all three fields of a Git source, before calling the server", async () => {
    const { server } = await openInit();
    selectTab("Git");
    await screen.findByLabelText("Repository URL");
    fireEvent.change(screen.getByLabelText("Build path"), { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    expect(await screen.findByText("Enter the address of the repository.")).toBeTruthy();
    expect(screen.getByText("Enter a branch, tag or commit.")).toBeTruthy();
    expect(screen.getByText("Enter a folder, or / for the whole repository.")).toBeTruthy();
    expect(puts(server)).toHaveLength(0);
  });

  it.each(["file:///etc/passwd", "ext::sh -c id", "/srv/repo.git"])(
    "refuses the remote %s before calling the server",
    async (url) => {
      const { server } = await openInit();
      selectTab("Git");
      fireEvent.change(await screen.findByLabelText("Repository URL"), { target: { value: url } });
      fireEvent.change(screen.getByLabelText("Branch"), { target: { value: "main" } });

      fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

      expect(await screen.findByText("Use an https:// or ssh:// address, or user@host:path.")).toBeTruthy();
      expect(puts(server)).toHaveLength(0);
    },
  );

  it("shows why a repository could not be read, and stays on the form", async () => {
    const { app } = await openInit({
      [`PUT ${SOURCE_PATH}`]: withStatus(400, {
        error: {
          code: "repository_unreachable",
          message: "Opsifier could not read this repository.",
          fields: { reason: "Permission denied (publickey)." },
        },
      }),
    });
    selectTab("Git");
    await screen.findByLabelText("Repository URL");
    fillGit();

    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    expect(await screen.findByText(/Permission denied \(publickey\)\./)).toBeTruthy();
    expect(app.location()).toBe("/projects/shop/app/web/init/source");
  });
});

describe("the build settings", () => {
  const openBuild = async () => {
    const result = await openSource({ source: GIT });
    await screen.findByRole("heading", { name: "Build" });
    return result;
  };

  it("start with nothing chosen", async () => {
    await openBuild();

    for (const radio of screen.getAllByRole("radio")) {
      expect((radio as HTMLInputElement).checked).toBe(false);
    }
    expect(screen.queryByRole("button", { name: "Save build settings" })).toBeNull();
  });

  it("show the fields of the chosen builder and only those, with their defaults", async () => {
    await openBuild();

    fireEvent.click(screen.getByRole("radio", { name: /^Dockerfile/ }));
    expect((await screen.findByLabelText(/Dockerfile path/)).getAttribute("placeholder")).toBe("Dockerfile");

    fireEvent.click(screen.getByRole("radio", { name: /^Buildpacks/ }));
    expect(((await screen.findByLabelText("Builder")) as HTMLInputElement).value).toBe("heroku/builder:24");
    expect(screen.queryByLabelText(/Dockerfile path/)).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /^Nixpacks/ }));
    expect(((await screen.findByLabelText("Version")) as HTMLInputElement).value).toBe("1.41.0");
    expect(screen.getByLabelText(/Nix packages/)).toBeTruthy();
    expect(screen.getByLabelText(/^APT packages/)).toBeTruthy();
    expect(screen.queryByLabelText(/Mise packages/)).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /^Railpack/ }));
    expect(((await screen.findByLabelText("Version")) as HTMLInputElement).value).toBe("0.17.1");
    expect(screen.getByLabelText(/Mise packages/)).toBeTruthy();
    expect(screen.getByLabelText(/APT packages for the build/)).toBeTruthy();
    expect(screen.getByLabelText(/APT packages in the final image/)).toBeTruthy();
    expect(screen.queryByLabelText(/Nix packages/)).toBeNull();
  });

  it("offer the six builder suggestions", async () => {
    await openBuild();
    fireEvent.click(screen.getByRole("radio", { name: /^Buildpacks/ }));
    const input = await screen.findByLabelText("Builder");

    fireEvent.focus(input);

    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([...buildpacksBuilders]);
  });

  it("save on their own, and validate first", async () => {
    const { server } = await openSource(
      { source: GIT },
      { [`PUT ${SOURCE_PATH}/build`]: { build: { type: "nixpacks", version: "9.9.9" } } },
    );
    await screen.findByRole("heading", { name: "Build" });
    fireEvent.click(screen.getByRole("radio", { name: /^Nixpacks/ }));
    fireEvent.change(await screen.findByLabelText("Version"), { target: { value: "latest" } });

    fireEvent.click(screen.getByRole("button", { name: "Save build settings" }));
    expect(await screen.findByText("Use a version such as 1.2.3.")).toBeTruthy();
    expect(puts(server, `${SOURCE_PATH}/build`)).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Version"), { target: { value: "1.40.0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save build settings" }));

    await waitFor(() => expect(puts(server, `${SOURCE_PATH}/build`)).toHaveLength(1));
    expect(puts(server, `${SOURCE_PATH}/build`)[0]?.body).toMatchObject({
      build: { type: "nixpacks", version: "1.40.0" },
    });
  });

  it("go back to detection with Skip", async () => {
    const { server } = await openSource(
      { source: GIT },
      {
        [`GET ${SOURCE_PATH}`]: settings({ source: GIT, build: { type: "dockerfile", file: "" } }),
        [`PUT ${SOURCE_PATH}/build`]: { build: null },
      },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));

    await waitFor(() => expect(puts(server, `${SOURCE_PATH}/build`)[0]?.body).toEqual({ build: null }));
  });

  it("are not offered on a Docker image or a Dockerfile", async () => {
    await openSource({});

    expect(screen.queryByRole("heading", { name: "Build" })).toBeNull();

    selectTab("Dockerfile");
    await screen.findByRole("textbox", { name: "Dockerfile" });
    expect(screen.queryByRole("heading", { name: "Build" })).toBeNull();
  });
});

describe("the deploy key", () => {
  const PUBLIC_KEY = "ssh-ed25519 AAAAexample opsifier-shop-web";

  it("is generated on demand and only ever shows its public half", async () => {
    const { server } = await openSource(
      { source: GIT },
      { [`POST ${SOURCE_PATH}/ssh-key`]: { publicKey: PUBLIC_KEY } },
    );
    selectTab("Git");

    server.set({ [`GET ${SOURCE_PATH}`]: settings({ source: GIT, sshPublicKey: PUBLIC_KEY }) });
    fireEvent.click(await screen.findByRole("button", { name: "Generate SSH key" }));

    expect(await screen.findByText(PUBLIC_KEY)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy the public key" })).toBeTruthy();
  });

  it("asks before replacing a key that may already be installed", async () => {
    const { server } = await openSource(
      { source: GIT },
      {
        [`GET ${SOURCE_PATH}`]: settings({ source: GIT, sshPublicKey: PUBLIC_KEY }),
        [`POST ${SOURCE_PATH}/ssh-key`]: { publicKey: "ssh-ed25519 BBBB new" },
      },
    );
    selectTab("Git");

    fireEvent.click(await screen.findByRole("button", { name: "Replace the SSH key" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace" }));

    await waitFor(() =>
      expect(server.calls.some((call) => call.method === "POST" && call.path.endsWith("/ssh-key"))).toBe(
        true,
      ),
    );
  });
});

describe("a GitHub source", () => {
  it("warns about private repositories and shows what will be used", async () => {
    await openInit();
    selectTab("GitHub");

    expect(await screen.findByText(/Private repositories need a GitHub token/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "acme/shop" } });
    expect(screen.getByText("acme/shop")).toBeTruthy();
  });

  it("explains the format without calling the server", async () => {
    const { server } = await openInit();
    selectTab("GitHub");
    await screen.findByLabelText("Repository");

    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    expect(await screen.findByText("Write it as owner/repository.")).toBeTruthy();
    expect(puts(server)).toHaveLength(0);
  });

  it("starts the build path at the root", async () => {
    await openInit();
    selectTab("GitHub");

    expect(((await screen.findByLabelText("Build path")) as HTMLInputElement).value).toBe("/");
  });

  it("lets a person pick from their repositories and branches with a token", async () => {
    const { server } = await openInit({
      [`GET ${SOURCE_PATH}`]: settings({ githubConfigured: true }),
      "GET /github/repositories": {
        items: [{ fullName: "acme/shop", private: true, defaultBranch: "main" }],
      },
      "GET /github/repositories/acme/shop/branches": { items: [{ name: "main" }, { name: "develop" }] },
      [`PUT ${SOURCE_PATH}`]: {
        type: "github",
        repository: "acme/shop",
        ref: "develop",
        path: "/",
        autoDeploy: false,
      },
    });
    selectTab("GitHub");
    expect(screen.queryByText(/Private repositories need a GitHub token/)).toBeNull();

    const repository = await screen.findByRole("combobox", { name: "Repository" });
    fireEvent.focus(repository);
    fireEvent.click(await screen.findByRole("option", { name: /acme\/shop/ }));

    const branch = await screen.findByRole("combobox", { name: "Branch" });
    fireEvent.focus(branch);
    fireEvent.click(await screen.findByRole("option", { name: "develop" }));
    server.set({
      "GET /projects/shop/services/web": detail({
        source: { type: "github", repository: "acme/shop", ref: "develop", path: "/", autoDeploy: false },
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    await waitFor(() => expect(puts(server)).toHaveLength(1));
    expect(puts(server)[0]?.body).toMatchObject({
      type: "github",
      repository: "acme/shop",
      ref: "develop",
      path: "/",
    });
  });

  it("can turn auto-deploy on when it has a token", async () => {
    const github = {
      type: "github",
      repository: "acme/shop",
      ref: "main",
      path: "/",
      autoDeploy: false,
    } as const;
    const { server } = await openSource(
      { source: github },
      {
        [`GET ${SOURCE_PATH}`]: settings({ source: github, githubConfigured: true }),
        [`PUT ${SOURCE_PATH}/auto-deploy`]: { ...github, autoDeploy: true },
      },
    );

    fireEvent.click(await screen.findByRole("switch"));

    await waitFor(() =>
      expect(puts(server, `${SOURCE_PATH}/auto-deploy`)[0]?.body).toEqual({ enabled: true }),
    );
    expect(await screen.findByText("Auto-deploy is on")).toBeTruthy();
  });

  it("asks for a token before offering auto-deploy", async () => {
    await openSource({
      source: { type: "github", repository: "acme/shop", ref: "main", path: "/", autoDeploy: false },
    });

    expect(await screen.findByText("Auto-deploy needs a GitHub token.")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

describe("an inline Dockerfile", () => {
  it("requires content", async () => {
    await openInit();
    selectTab("Dockerfile");
    await screen.findByRole("textbox", { name: "Dockerfile" });

    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    expect(await screen.findByText("Write a Dockerfile to build.")).toBeTruthy();
  });

  it("saves what was written", async () => {
    const { server } = await openInit({
      [`PUT ${SOURCE_PATH}`]: { type: "dockerfile", dockerfile: "FROM scratch\n" },
    });
    selectTab("Dockerfile");
    fireEvent.change(await screen.findByRole("textbox", { name: "Dockerfile" }), {
      target: { value: "FROM scratch\n" },
    });

    server.set({
      "GET /projects/shop/services/web": detail({
        source: { type: "dockerfile", dockerfile: "FROM scratch\n" },
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    await waitFor(() =>
      expect(puts(server)[0]?.body).toEqual({ type: "dockerfile", dockerfile: "FROM scratch\n" }),
    );
  });
});

describe("an upload", () => {
  class FakeXhr {
    static last: FakeXhr | undefined;
    upload: {
      onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
    } = {
      onprogress: null,
    };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    url = "";
    status = 200;
    statusText = "OK";
    responseText = "";
    sent: unknown;

    constructor() {
      FakeXhr.last = this;
    }
    open(_method: string, url: string) {
      this.url = url;
    }
    setRequestHeader() {}
    send(body: unknown) {
      this.sent = body;
    }
  }

  const chooseFile = (name: string, size = 10) => {
    const input = screen.getByLabelText("Choose an archive") as HTMLInputElement;
    const file = new File(["x".repeat(size)], name, { type: "application/zip" });
    fireEvent.change(input, { target: { files: [file] } });
  };

  it("lists the formats and asks for a file", async () => {
    const { server } = await openInit();
    selectTab("Upload");

    expect(await screen.findByText(/zip, tar, tar\.gz, tar\.bz2, tar\.xz, tar\.zst, 7z or rar/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    expect(await screen.findByText("Choose an archive to upload.")).toBeTruthy();
    expect(server.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it("refuses a file it cannot unpack", async () => {
    await openInit();
    selectTab("Upload");
    await screen.findByText(/zip, tar/);

    chooseFile("malware.exe");

    expect(await screen.findByText("Use a zip, tar, 7z or rar archive.")).toBeTruthy();
  });

  it("sends the archive and saves the build path with it", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const { server, app } = await openInit();
    selectTab("Upload");
    await screen.findByText(/zip, tar/);
    chooseFile("app.tar.gz");
    await screen.findByText("app.tar.gz");

    const uploaded = {
      type: "upload",
      fileName: "app.tar.gz",
      sizeBytes: 10,
      uploadedAt: "2026-01-01T00:00:00.000Z",
      path: "/",
    };
    server.set({
      "GET /projects/shop/services/web": detail({ source: uploaded as ServiceDetail["source"] }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    await waitFor(() => expect(FakeXhr.last?.sent).toBeInstanceOf(File));
    expect(FakeXhr.last?.url).toBe(
      "/api/v1/projects/shop/services/web/source/upload?fileName=app.tar.gz&path=%2F",
    );

    act(() => FakeXhr.last?.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 }));
    expect(await screen.findByText("Uploading, 50%")).toBeTruthy();

    const xhr = FakeXhr.last as FakeXhr;
    xhr.responseText = JSON.stringify(uploaded);
    act(() => xhr.onload?.());

    await expectLocation(app, "/projects/shop/app/web");
  });

  it("shows what the server refused", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    await openInit();
    selectTab("Upload");
    await screen.findByText(/zip, tar/);
    chooseFile("app.tar.gz");
    await screen.findByText("app.tar.gz");
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(FakeXhr.last?.sent).toBeInstanceOf(File));

    const xhr = FakeXhr.last as FakeXhr;
    xhr.status = 400;
    xhr.responseText = JSON.stringify({
      error: { code: "upload_rejected", message: "This archive has entries that would escape its folder." },
    });
    act(() => xhr.onload?.());

    expect(await screen.findByText("This archive can't be used.")).toBeTruthy();
  });
});

describe("the deployment trigger", () => {
  const TRIGGER = "/projects/shop/services/web/deployments/trigger";

  it("shows the URL and replaces it on request", async () => {
    const server = installFakeServer(
      routes(detail(), {
        "GET /projects/shop/services/web/deployments": { items: [], nextCursor: null },
        [`GET ${TRIGGER}`]: { path: "/api/v1/deploy/aaa" },
        [`POST ${TRIGGER}/rotate`]: { path: "/api/v1/deploy/bbb" },
      }),
    );
    renderApp("/projects/shop/app/web/deployments");

    expect(await screen.findByText("http://localhost:3000/api/v1/deploy/aaa")).toBeTruthy();
    server.set({ [`GET ${TRIGGER}`]: { path: "/api/v1/deploy/bbb" } });

    fireEvent.click(screen.getByRole("button", { name: "Replace the URL" }));

    expect(await screen.findByText("http://localhost:3000/api/v1/deploy/bbb")).toBeTruthy();
    expect(server.calls.some((call) => call.method === "POST" && call.path === `${TRIGGER}/rotate`)).toBe(
      true,
    );
  });
});

describe("the environment file", () => {
  const ENV_FILE = `${SOURCE_PATH}/env-file`;

  const openEnvironment = (source: ServiceDetail["source"], extra: FakeRoute = {}) => {
    const server = installFakeServer(
      routes(detail({ source }), {
        "GET /projects/shop/services/web/environment": { env: "A=1\n" },
        [`GET ${ENV_FILE}`]: { path: null },
        ...extra,
      }),
    );
    renderApp("/projects/shop/app/web/environment");
    return server;
  };

  it("is offered for a source that has a tree to write into", async () => {
    const server = openEnvironment(GIT, { [`PUT ${ENV_FILE}`]: { path: ".env" } });

    fireEvent.click(await screen.findByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Save file setting" }));

    await waitFor(() => expect(puts(server, ENV_FILE)[0]?.body).toEqual({ path: ".env" }));
  });

  it("is not offered for a Docker image", async () => {
    openEnvironment(detail().source);

    await screen.findByRole("button", { name: "Save variables" });
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
