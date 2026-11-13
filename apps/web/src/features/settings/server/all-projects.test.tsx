// @vitest-environment jsdom
import "../../../testing/browser-stubs";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeServer, renderApp, resetApp } from "../../../testing/appHarness";

afterEach(resetApp);

const OWNER = {
  id: "u1",
  email: "admin@example.com",
  role: "admin",
  owner: true,
  twoFactorEnabled: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  projects: [],
  allProjects: null,
  apiKeyCount: 0,
  name: "",
  active: true,
};

const member = (email: string, extra: Record<string, unknown> = {}) => ({
  ...OWNER,
  id: `id-${email}`,
  email,
  role: "member",
  owner: false,
  ...extra,
});

const project = (name: string) => ({ name, createdAt: "2026-01-01T00:00:00.000Z", services: [] });

const page = (users: unknown[], routes: Record<string, unknown> = {}) =>
  installFakeServer({
    "GET /users": { users: [OWNER, ...users] },
    "GET /projects": { projects: [project("blog"), project("shop")] },
    "GET /users/invitations": { invitations: [] },
    "GET /notifications/channels": { channels: [], settings: { allowPrivateDestinations: false } },
    ...routes,
  });

/** Opens the edit dialog of the one member on the page. */
async function editMember(): Promise<ReturnType<typeof within>> {
  const [, memberEdit] = await screen.findAllByRole("button", { name: "Edit" });
  fireEvent.click(memberEdit as HTMLElement);
  return within(await screen.findByRole("dialog"));
}

async function choose(dialog: ReturnType<typeof within>, combobox: string, option: string): Promise<void> {
  fireEvent.click(dialog.getByRole("combobox", { name: combobox }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("a role in every project", () => {
  it("says in each account's line what it reaches", async () => {
    page([
      member("ops@example.com", { allProjects: "operator" }),
      member("dev@example.com", {
        allProjects: "viewer",
        projects: [
          { project: "blog", role: "operator" },
          { project: "shop", role: "operator" },
        ],
      }),
      member("one@example.com", { projects: [{ project: "shop", role: "viewer" }] }),
    ]);
    renderApp("/settings/server/users");

    expect(await screen.findByText(/^Operator in every project/)).toBeTruthy();
    expect(screen.getByText(/^Viewer in every project · operator in 2 projects/)).toBeTruthy();
    expect(screen.getByText(/^1 project/)).toBeTruthy();
  });

  it("makes a member an operator in every project, with the box above the list", async () => {
    const sam = member("sam@example.com", { projects: [{ project: "shop", role: "viewer" }] });
    const server = page([sam], { [`PUT /users/${sam.id}`]: { ...sam, allProjects: "operator" } });
    renderApp("/settings/server/users");

    const dialog = await editMember();
    const box = dialog.getByRole("checkbox", { name: "All projects" });
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(dialog.getByRole("checkbox", { name: "shop" })).toBeTruthy();
    // The box comes before the projects it stands for.
    expect(
      box.compareDocumentPosition(dialog.getByRole("checkbox", { name: "shop" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(box);
    expect(dialog.getByRole("combobox", { name: "Role in every project" }).textContent).toBe("Viewer");
    await choose(dialog, "Role in every project", "Operator");

    expect(await dialog.findByText(/nothing to choose project by project/)).toBeTruthy();
    expect(dialog.queryByRole("combobox", { name: "Role in shop" })).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({
        email: "sam@example.com",
        role: "member",
        // Kept for when the box is unticked: it adds nothing while the member is an operator everywhere.
        projects: [{ project: "shop", role: "viewer" }],
        allProjects: "operator",
        hostAdmin: false,
      }),
    );
  });

  it("raises one project above a viewer role in every project, and gives the list back when unticked", async () => {
    const sam = member("sam@example.com", { allProjects: "viewer" });
    const server = page([sam], { [`PUT /users/${sam.id}`]: sam });
    renderApp("/settings/server/users");

    const dialog = await editMember();
    expect((dialog.getByRole("checkbox", { name: "All projects" }) as HTMLInputElement).checked).toBe(true);
    expect(dialog.getByRole("combobox", { name: "Role in blog" }).textContent).toBe("Viewer");
    await choose(dialog, "Role in blog", "Operator");
    expect(dialog.getByRole("combobox", { name: "Role in blog" }).textContent).toBe("Operator");

    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "PUT")?.body).toMatchObject({
        projects: [{ project: "blog", role: "operator" }],
        allProjects: "viewer",
      }),
    );
  });

  it("takes the role in every project away, and keeps each project's own", async () => {
    const sam = member("sam@example.com", {
      allProjects: "operator",
      projects: [{ project: "blog", role: "viewer" }],
    });
    const server = page([sam], { [`PUT /users/${sam.id}`]: sam });
    renderApp("/settings/server/users");

    const dialog = await editMember();
    fireEvent.click(dialog.getByRole("checkbox", { name: "All projects" }));
    expect((dialog.getByRole("checkbox", { name: "blog" }) as HTMLInputElement).checked).toBe(true);
    expect((dialog.getByRole("checkbox", { name: "shop" }) as HTMLInputElement).checked).toBe(false);

    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "PUT")?.body).toMatchObject({
        projects: [{ project: "blog", role: "viewer" }],
        allProjects: null,
      }),
    );
  });

  it("invites a whole list with the same role in every project", async () => {
    const server = page([], {
      "POST /users/invitations": { results: [], action: null },
    });
    renderApp("/settings/server/users");

    fireEvent.click(await screen.findByRole("button", { name: "Invite" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(await dialog.findByLabelText("Email addresses"), {
      target: { value: "ann@example.com, bob@example.com" },
    });
    fireEvent.click(dialog.getByRole("checkbox", { name: "All projects" }));
    await choose(dialog, "Role in every project", "Operator");
    fireEvent.click(dialog.getByRole("button", { name: "Invite 2 people" }));

    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "POST")?.body).toMatchObject({
        emails: ["ann@example.com", "bob@example.com"],
        role: "member",
        projects: [],
        allProjects: "operator",
      }),
    );
  });

  it("names it in a pending invitation", async () => {
    page([], {
      "GET /users/invitations": {
        invitations: [
          {
            id: "i1",
            email: "ann@example.com",
            role: "member",
            projects: [],
            allProjects: "operator",
            invitedBy: "admin@example.com",
            createdAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
            expired: false,
            delivery: "link",
            channelName: null,
            sentAt: null,
            error: null,
          },
        ],
      },
    });
    renderApp("/settings/server/users");

    expect(await screen.findByText(/^Operator in every project · sent by/)).toBeTruthy();
  });
});
