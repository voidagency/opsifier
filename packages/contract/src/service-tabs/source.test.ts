import { describe, expect, it } from "vitest";
import {
  buildConfig,
  buildPath,
  envFilePath,
  githubRepository,
  gitRef,
  isAllowedGitRemote,
  isSafeRelativeFile,
  isValidGitRef,
  normalizeBuildPath,
  saveSourceRequest,
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

describe("build settings", () => {
  it("fills in the defaults of each builder", () => {
    expect(buildConfig.parse({ type: "dockerfile" })).toEqual({ type: "dockerfile", file: "" });
    expect(buildConfig.parse({ type: "buildpacks" })).toEqual({
      type: "buildpacks",
      builder: "heroku/builder:24",
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
