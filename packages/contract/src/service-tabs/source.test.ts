import { describe, expect, it } from "vitest";
import { builderLanguages, buildpackLanguages, railpackLanguages } from "./builders";
import {
  buildConfig,
  buildPath,
  buildpacksBuilders,
  defaultBuildpacksBuilder,
  envFilePath,
  githubRepository,
  gitRef,
  isAllowedGitRemote,
  isPinnedBuilder,
  isSafeRelativeFile,
  isValidGitRef,
  normalizeBuildPath,
  saveSourceRequest,
  storedBuildConfig,
  uploadSourceQuery,
} from "./source";

describe("git remotes", () => {
  it.each([
    "https://github.com/acme/shop.git",
    "https://git.example.com:8443/team/app",
    "ssh://git@bitbucket.org/acme/shop.git",
    "ssh://deploy@git.example.com:2222/srv/git/app.git",
    "git@github.com:acme/shop.git",
    "deploy@10.0.0.5:repos/app.git",
    "git@host.example:~/app.git",
  ])("accepts %s", (url) => {
    expect(isAllowedGitRemote(url)).toBe(true);
  });

  it.each([
    "file:///etc/passwd",
    "file://localhost/srv/repo.git",
    "/srv/repo.git",
    "./repo.git",
    "../repo.git",
    "~/repo.git",
    "repo.git",
    "ext::sh -c touch% /tmp/pwned",
    "ext::ssh",
    "fd::17",
    "git://example.com/repo.git",
    "http://example.com/repo.git",
    "ftp://example.com/repo.git",
    "--upload-pack=/bin/sh",
    "-oProxyCommand=/bin/sh",
    "git@-oProxyCommand=sh:repo",
    "-oProxyCommand=sh@host:repo",
    "ssh://-oProxyCommand=sh/repo",
    "ssh://git@-oProxyCommand=sh/repo",
    "https://user:secret@example.com/repo.git",
    "https://token@github.com/repo.git",
    "ssh://git:secret@example.com/repo.git",
    "https://example.com/repo.git?x=1",
    "https://example.com/repo.git#main",
    "https://example.com/",
    "https://example.com",
    "https://exa mple.com/repo.git",
    "https://example.com/re po.git",
    "https://example.com/repo%0aevil",
    "https://example.com/repo\nevil",
    "host.example:repo.git",
    "git@host:-oProxyCommand=sh",
    "git@host://repo",
    "",
  ])("refuses %s", (url) => {
    expect(isAllowedGitRemote(url)).toBe(false);
  });
});

describe("git refs", () => {
  it.each([
    "main",
    "feature/login-page",
    "release-1.2",
    "v1.2.3",
    "refs/heads/main",
    "HEAD",
    "0123456789abcdef0123456789abcdef01234567",
    "fix/#123",
    "dependabot/npm_and_yarn/foo-1.0.0",
    "user@feature",
  ])("accepts %s", (ref) => {
    expect(isValidGitRef(ref)).toBe(true);
    expect(gitRef.safeParse(ref).success).toBe(true);
  });

  it.each([
    "-main",
    "--upload-pack=x",
    "a..b",
    "a b",
    "a\nb",
    "main.lock",
    "a.lock/b",
    ".hidden",
    "a/.b",
    "a//b",
    "/main",
    "main/",
    "main.",
    "@",
    "a@{1}",
    "a~1",
    "a^",
    "a:b",
    "a?",
    "a*",
    "a[b",
    "a\\b",
    "+refs/heads/*:refs/heads/*",
    "$(reboot)",
    "`id`",
    "",
  ])("refuses %j", (ref) => {
    expect(isValidGitRef(ref)).toBe(false);
  });

  it("asks for a ref when there is none", () => {
    expect(gitRef.safeParse("").error?.issues[0]?.message).toBe("Required");
  });
});

describe("build paths", () => {
  it.each([
    ["/", "/"],
    ["./", "/"],
    ["apps/web", "/apps/web"],
    ["/apps/web/", "/apps/web"],
    ["./apps//web", "/apps/web"],
    ["/apps/my app", "/apps/my app"],
  ])("reads %s as %s", (input, normalized) => {
    expect(normalizeBuildPath(input)).toBe(normalized);
    expect(buildPath.parse(input)).toBe(normalized);
  });

  it.each(["..", "../other", "/apps/../..", "apps/../../etc", "a\\..\\b", "a\u0000b"])(
    "refuses %j",
    (path) => {
      expect(buildPath.safeParse(path).success).toBe(false);
    },
  );

  it("asks for a path when there is none", () => {
    expect(buildPath.safeParse("").error?.issues[0]?.message).toBe("Required");
  });
});

describe("files inside the source", () => {
  it.each(["Dockerfile", "docker/Dockerfile.prod", ""])("accepts %j", (file) => {
    expect(isSafeRelativeFile(file)).toBe(true);
  });

  it.each(["/etc/passwd", "../Dockerfile", "a/../../b", "a//b", "a\\b", "a\u0000b"])("refuses %j", (file) => {
    expect(isSafeRelativeFile(file)).toBe(false);
  });

  it("drops a leading ./ and requires a value for the env file", () => {
    expect(envFilePath.parse("./.env")).toBe(".env");
    expect(envFilePath.safeParse("").success).toBe(false);
  });
});

describe("GitHub repositories", () => {
  it.each(["acme/shop", "acme-corp/shop.web_2"])("accepts %s", (name) => {
    expect(githubRepository.parse(name)).toBe(name);
  });

  it("ignores a pasted .git suffix", () => {
    expect(githubRepository.parse("acme/shop.git")).toBe("acme/shop");
  });

  it.each(["", "acme", "acme/", "/shop", "acme/shop/extra", "-acme/shop", "acme/.", "acme/..", "acme/sh op"])(
    "refuses %j",
    (name) => {
      expect(githubRepository.safeParse(name).success).toBe(false);
    },
  );
});

describe("a pinned builder", () => {
  it.each([...buildpacksBuilders])("%s is one the panel offers", (builder) => {
    expect(isPinnedBuilder(builder)).toBe(true);
    expect(buildConfig.safeParse({ type: "buildpacks", builder }).success).toBe(true);
  });

  it.each([
    "paketobuildpacks/builder-jammy-full:latest",
    "heroku/builder:24",
    "registry:5000/org/builder",
    "builder",
  ])("%s can move, so it is refused", (builder) => {
    expect(isPinnedBuilder(builder)).toBe(false);
    const parsed = buildConfig.safeParse({ type: "buildpacks", builder });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/pinned/);
  });

  it.each(["org/builder:1.2.3", "org/builder:v2.0.0", "org/builder@sha256:".padEnd(84, "a")])(
    "%s cannot",
    (builder) => {
      expect(isPinnedBuilder(builder)).toBe(true);
    },
  );

  it("reads what an earlier release offered as the pinned build of the same line", () => {
    expect(storedBuildConfig.parse({ type: "buildpacks", builder: "heroku/builder:24" })).toEqual({
      type: "buildpacks",
      builder: defaultBuildpacksBuilder,
    });
    expect(
      storedBuildConfig.parse({ type: "buildpacks", builder: "paketobuildpacks/builder-jammy-full:latest" }),
    ).toEqual({ type: "buildpacks", builder: "paketobuildpacks/builder-jammy-full:0.3.705" });
  });

  it("still reads an unpinned builder nobody can translate, so a build can say what is wrong", () => {
    expect(storedBuildConfig.parse({ type: "buildpacks", builder: "myorg/builder:edge" })).toEqual({
      type: "buildpacks",
      builder: "myorg/builder:edge",
    });
  });
});

describe("what each builder supports", () => {
  it("says which languages a Railpack version detects, oldest and newest", () => {
    expect(railpackLanguages("0.9.2")).not.toContain(".NET");
    expect(railpackLanguages("0.9.2")).not.toContain("Gleam");
    expect(railpackLanguages("0.10.0")).toContain("Gleam");
    expect(railpackLanguages("0.11.0")).toContain(".NET");
    expect(railpackLanguages("0.13.0")).not.toContain("C and C++");
    expect(railpackLanguages("0.14.0")).toContain("C and C++");
  });

  it("knows every builder image it offers, and answers null for one it doesn't", () => {
    for (const builder of buildpacksBuilders) {
      expect(buildpackLanguages(builder)?.length).toBeGreaterThan(0);
    }
    expect(buildpackLanguages("myorg/builder:1.2.3")).toBeNull();
    expect(buildpackLanguages("paketobuildpacks/builder-jammy-tiny:0.0.595")).not.toContain("Node.js");
  });

  it("leaves a Dockerfile to decide for itself", () => {
    expect(builderLanguages(buildConfig.parse({ type: "dockerfile" }))).toBeNull();
    expect(builderLanguages(buildConfig.parse({ type: "nixpacks" }))).toContain("Python");
  });
});

describe("build settings", () => {
  it("fills in the defaults of each builder", () => {
    expect(buildConfig.parse({ type: "dockerfile" })).toEqual({ type: "dockerfile", file: "" });
    expect(buildConfig.parse({ type: "buildpacks" })).toEqual({
      type: "buildpacks",
      builder: defaultBuildpacksBuilder,
    });
    expect(buildConfig.parse({ type: "nixpacks" })).toMatchObject({ version: "1.41.0", installCommand: "" });
    expect(buildConfig.parse({ type: "railpack" })).toMatchObject({ version: "0.17.1", startCommand: "" });
  });

  it.each([
    [{ type: "dockerfile", file: "../Dockerfile" }],
    [{ type: "dockerfile", file: "/etc/passwd" }],
    [{ type: "buildpacks", builder: "--trust-builder" }],
    [{ type: "buildpacks", builder: "not a builder" }],
    [{ type: "nixpacks", version: "latest" }],
    [{ type: "nixpacks", version: "1.2.3; reboot" }],
    [{ type: "nixpacks", installCommand: "npm ci\nnpm test" }],
    [{ type: "nixpacks", nixPackages: "--evil" }],
    [{ type: "nixpacks", aptPackages: "curl;reboot" }],
    [{ type: "railpack", misePackages: "node@20 --evil" }],
    [{ type: "railpack", buildAptPackages: "$(id)" }],
    [{ type: "other" }],
  ])("refuses %j", (config) => {
    expect(buildConfig.safeParse(config).success).toBe(false);
  });

  it("accepts lists of packages separated by spaces or commas", () => {
    expect(
      buildConfig.parse({
        type: "nixpacks",
        nixPackages: "ffmpeg, imagemagick",
        aptPackages: "curl=7.88 git",
      }),
    ).toMatchObject({ nixPackages: "ffmpeg, imagemagick", aptPackages: "curl=7.88 git" });
    expect(buildConfig.parse({ type: "railpack", misePackages: "node@20 python" })).toMatchObject({
      misePackages: "node@20 python",
    });
  });
});

describe("saving a source", () => {
  it("still treats a body without a type as an image", () => {
    expect(saveSourceRequest.safeParse({ image: "nginx:1.28" }).success).toBe(true);
  });

  it("reports the field that is missing", () => {
    const issues = saveSourceRequest.safeParse({ type: "git", url: "", ref: "", path: "" }).error?.issues;
    expect(issues?.map((issue) => [issue.path[0], issue.message])).toEqual(
      expect.arrayContaining([
        ["url", "Required"],
        ["ref", "Required"],
        ["path", "Required"],
      ]),
    );
  });

  it("refuses an empty or blank Dockerfile", () => {
    expect(saveSourceRequest.safeParse({ type: "dockerfile", dockerfile: "" }).success).toBe(false);
    expect(saveSourceRequest.safeParse({ type: "dockerfile", dockerfile: " \n " }).success).toBe(false);
    expect(saveSourceRequest.safeParse({ type: "dockerfile", dockerfile: "FROM scratch\n" }).success).toBe(
      true,
    );
  });

  it("refuses a Dockerfile longer than the limit", () => {
    expect(
      saveSourceRequest.safeParse({ type: "dockerfile", dockerfile: "x".repeat(256 * 1024 + 1) }).success,
    ).toBe(false);
  });
});

describe("uploads", () => {
  it.each([
    "app.zip",
    "app.tar",
    "app.tar.gz",
    "app.tgz",
    "app.tar.bz2",
    "app.tar.xz",
    "app.tar.zst",
    "app.7z",
    "app.rar",
    "APP.ZIP",
  ])("accepts %s", (fileName) => {
    expect(uploadSourceQuery.safeParse({ fileName }).success).toBe(true);
  });

  it.each(["app.exe", "app", "", "app.tar.gz.exe"])("refuses %j", (fileName) => {
    expect(uploadSourceQuery.safeParse({ fileName }).success).toBe(false);
  });
});
