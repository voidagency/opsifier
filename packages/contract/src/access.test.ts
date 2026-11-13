import { describe, expect, it } from "vitest";
import {
  createUserRequest,
  effectiveProjectRole,
  panelUser,
  projectMember,
  projectMemberPath,
  setProjectMemberRequest,
  updateUserRequest,
} from "./access";
import { callerIdentity } from "./caller-identity";
import { createInvitationsRequest, invitation } from "./invitations";

const password = "a long enough password";

describe("a role in every project", () => {
  it("gives a project the stronger of that role and the project's own", () => {
    expect(effectiveProjectRole(null, undefined)).toBeNull();
    expect(effectiveProjectRole(null, "viewer")).toBe("viewer");
    expect(effectiveProjectRole("viewer", undefined)).toBe("viewer");
    expect(effectiveProjectRole("viewer", "operator")).toBe("operator");
    expect(effectiveProjectRole("operator", "viewer")).toBe("operator");
    expect(effectiveProjectRole("operator", null)).toBe("operator");
  });

  it("is a project role or none, and none unless someone asks for one", () => {
    const account = { email: "ann@example.com", password };
    expect(createUserRequest.parse(account).allProjects).toBeNull();
    expect(createUserRequest.parse({ ...account, allProjects: "operator" }).allProjects).toBe("operator");
    expect(createUserRequest.safeParse({ ...account, allProjects: "admin" }).success).toBe(false);

    const people = { emails: ["ann@example.com"] };
    expect(createInvitationsRequest.parse(people).allProjects).toBeNull();
    expect(createInvitationsRequest.parse({ ...people, allProjects: "viewer" }).allProjects).toBe("viewer");
    expect(createInvitationsRequest.safeParse({ ...people, allProjects: "owner" }).success).toBe(false);
  });

  it("stays as it is when an edit leaves it out, and goes with null", () => {
    const edit = { email: "ann@example.com", role: "member", projects: [] };
    expect(updateUserRequest.parse(edit).allProjects).toBeUndefined();
    expect(updateUserRequest.parse({ ...edit, allProjects: null }).allProjects).toBeNull();
    expect(updateUserRequest.parse({ ...edit, allProjects: "operator" }).allProjects).toBe("operator");
  });

  it("reads as none in an answer from a panel that has never heard of it", () => {
    const account = {
      id: "u2",
      email: "ann@example.com",
      name: "",
      role: "member",
      owner: false,
      twoFactorEnabled: false,
      active: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      projects: [],
      apiKeyCount: 0,
    };
    expect(panelUser.parse(account).allProjects).toBeNull();
    const pending = {
      id: "i1",
      email: "ann@example.com",
      role: "member",
      projects: [],
      invitedBy: "admin@example.com",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-08T00:00:00.000Z",
      expired: false,
      delivery: "link",
      channelName: null,
      sentAt: null,
      error: null,
    };
    expect(invitation.parse(pending).allProjects).toBeNull();
  });

  it("is always stated by the identity a credential reports", () => {
    const identity = {
      user: { id: "u2", email: "ann@example.com", role: "member" },
      credential: { kind: "session" },
      projects: [{ name: "shop", role: "operator" }],
      operations: [],
    };
    expect(callerIdentity.safeParse(identity).success).toBe(false);
    expect(callerIdentity.parse({ ...identity, allProjects: "operator" }).allProjects).toBe("operator");
  });
});

describe("who reaches a project", () => {
  it("is set to one of the two project roles, or none", () => {
    expect(setProjectMemberRequest.parse({ role: "operator" }).role).toBe("operator");
    expect(setProjectMemberRequest.parse({ role: null }).role).toBeNull();
    expect(setProjectMemberRequest.safeParse({ role: "admin" }).success).toBe(false);
    expect(setProjectMemberRequest.safeParse({}).success).toBe(false);
    expect(setProjectMemberRequest.safeParse({ role: "viewer", allProjects: "operator" }).success).toBe(
      false,
    );
  });

  it("names a project and an account the way their own routes do", () => {
    expect(projectMemberPath.safeParse({ project: "shop", user: "u_1-x" }).success).toBe(true);
    expect(projectMemberPath.safeParse({ project: "Shop!", user: "u1" }).success).toBe(false);
    expect(projectMemberPath.safeParse({ project: "shop", user: "../u1" }).success).toBe(false);
  });

  it("says what a member can do there and where it comes from", () => {
    const row = {
      id: "u2",
      email: "ann@example.com",
      name: "",
      owner: false,
      administrator: false,
      active: true,
      role: "operator",
      grant: "operator",
      allProjects: "viewer",
    };
    expect(projectMember.parse(row)).toEqual(row);
    expect(projectMember.safeParse({ ...row, role: "owner" }).success).toBe(false);
  });
});
