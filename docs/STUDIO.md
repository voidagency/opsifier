# Studio

The Studio lets someone change a web project by talking to an AI agent, and watch the result live: the conversation on the left, the project's preview on the right. It is optional and off by default. The agent is [OpenHands](https://github.com/OpenHands/OpenHands) (MIT), used as it is published: Opsifier talks to its agent server, and brings the interface, the projects and their previews.

The server's administrators reach every project in the Studio, and anyone else the projects shared with them: a designer, for example, with an account of the panel and nothing else on the server. One agent server still works on every project's folder, so someone a project is shared with could ask it about another project's files; each project will get an agent of its own.

## Set it up

You need a model the agent can use, an OpenAI-compatible address, such as a model served by vLLM on your own machine, or a provider's API key, and a GitHub token. Everything else is made from the panel, except one folder on the server.

### 1. A folder for the projects

Each project the Studio works on is copied into this folder, and the agent and the project's preview both mount it. On the server, make it and give it to the agent's user, `10001` in the agent server's image:

```sh
sudo mkdir -p /srv/studio && sudo chown 10001:10001 /srv/studio
```

### 2. The agent server

In a project of your own, `studio` for example, create a service `agent`:

1. **Source:** the image `ghcr.io/openhands/agent-canvas:1.40.0`. When your projects lock their dependencies with Bun, as projects made with Lovable do, give the agent Bun too, with this Dockerfile as the source instead:

   ```dockerfile
   FROM ghcr.io/openhands/agent-canvas:1.40.0
   USER root
   COPY --from=oven/bun:1.3 /usr/local/bin/bun /usr/local/bin/bun
   RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx
   USER openhands
   ```

2. **Storage:** a volume mounted at `/home/openhands/.openhands`, where the agent server keeps its settings, its key and its conversations, and the server's folder `/srv/studio` mounted at `/projects`.
3. **Deploy it**, then open its address once, from its domain: in its interface, set up the model, and add a secret named `GITHUB_TOKEN` holding the token of step 3.

The agent server listens on `127.0.0.1:18000` in its container, where the panel reaches it: it needs no domain of its own after this step.

### 3. The GitHub token

On GitHub, make a fine-grained personal access token: under **Repository access**, the repositories the Studio may work on, or all of them; under **Permissions**, **Contents** in read and write. Save it in the agent server as the secret `GITHUB_TOKEN`. To let the Studio work on another repository later, edit the token on GitHub and add it there: the token keeps its value, and nothing changes in the agent server.

### 4. Turn the Studio on

1. Open **Settings**, **Studio**, and turn it on.
2. Choose the agent server's service. Keep its address, `http://127.0.0.1:18000`, and its key file, `/home/openhands/.openhands/agent-canvas/api-key.txt`; leave the key file empty when the key is in the container's `SESSION_API_KEY` variable.
3. Set the **projects folder** to `/projects`, the folder as the agent server sees it.
4. Save, then **Check the connection**.

### 5. Add a project

Open **Studio** in the top bar, then **Add a project**, and give the repository: its address, such as `https://github.com/owner/name`, or `owner/name`, and a branch when it is not the default one. The Studio then:

1. **copies the repository** into the projects folder, from inside the agent server's container and with its `GITHUB_TOKEN` secret: the token never leaves that container, and is never written in the copy, whose Git reads it from a credential helper;
2. **makes the project's preview**, a service `<name>-preview` in the agent server's project: the project's Vite development server on the same folder, with the inspector, limited to 3 GB of memory and 2 CPUs, at an address of the server's domain for services;
3. **links the two**, and opens the project. The preview's first start installs the project's dependencies, which takes a minute or two.

When the token does not reach the repository, the Studio says so, and adding it again once the token reaches it carries on from the copy already made. Only projects that use Vite can be added this way for now. Any other set-up can still be linked by hand with **Link a project**: a service whose container shows the project's live preview, and the project's folder as the agent server sees it.

## Share a project

1. Invite the person to the panel, from **Settings**, **Accounts**, as a member with no project: such an account reaches nothing on the server by itself.
2. In the Studio, open the project and use **Share this project**: tick the accounts that may work on it.

Each account a project is shared with sees it in the Studio, with its conversations, which everyone on the project shares, and its live preview, which it may start. It sees no other project, and no service, log, variable, terminal or setting of the server. Untick an account to take the project back.

## Previews behind the panel's sign-in

With **Previews behind the panel's sign-in** on, in the Studio's settings, each preview asks for the panel's own account instead of the password the server's gate shares with every site. The server's administrators and the accounts the project is shared with get in; nobody else does.

- Traefik asks the panel about every request to a preview. With no cookie for that preview, the browser goes through the panel, which knows who is signed in and sends it back with a code good once, for a minute, which becomes a cookie of that preview only, for twelve hours.
- Whether that account may still open the preview is read again at least every half minute: a project taken back, or an account turned off, stops opening it.
- The agent reaches the preview inside the server, by its service's name, which the sign-in does not stand in front of.
- For the preview to open inside the Studio, the panel and the previews must share a domain, as `panel.example.com` and the previews' `*.example.com` do: a browser only sends a frame its cookies within one site.

## One agent per project

With **One agent per project** on, in the Studio's settings, each project gets an agent server of its own:

- **Its own Opsifier project.** A project added to the Studio goes in `studio-<folder>`, with two services, `preview` and `agent`. Their network keeps them away from every other project's services: the agent reaches its preview, at `http://preview`, and nothing else on the server.
- **Its own folder.** The agent server mounts the project's folder, and no other folder of the server.
- **No GitHub token.** The agent's `git pull` and `git push` go to the panel, at `/api/v1/studio/git/<project>.git`, with a token that opens that address only. The panel passes them on to the project's repository with the `GITHUB_TOKEN` secret of the agent server named in the settings, which never leaves it. Each push is recorded as a `studio.push` Action.
- **A copy of the model.** The agent server named in the settings becomes the model. Each project's is built from the same image or Dockerfile, with the same deployment settings, fresh volumes of the same names, 4 GB of memory and 2 CPUs. It gets none of the model's variables, which may hold secrets, and makes its own key in its key file. The model's settings, model profiles and agent profile, with the key their stored keys are encrypted with, are copied in before each new conversation whenever they have changed, and the first copy restarts the new agent server once so that it reads that key; the model's secrets are never copied. Everything in those settings goes to every project, MCP servers and their keys included: keep there only what every project may use. A project's agent can read a model profile's API key, since it calls the model with it.
- **Up while someone works on it.** Opening the project, or sending a message, starts its agent server and its preview, deploying them the first time; reading a conversation does not. An agent server nobody has sent anything to for 45 minutes, with no conversation at work, is stopped. A first deployment that failed is not tried again by the Studio: an administrator deploys the service again once its logs say why.

Turning it on is refused until the model can be copied: its settings in a volume (the one that holds its key file, or the one at `~/.openhands`), its key in a key file, an image or a Dockerfile for its source, a projects folder, and an address for the panel, which each agent reaches it at.

### Moving the projects already in the Studio

The projects linked before stay on the shared agent server and wait for their own: a new conversation on one of them is refused until it has it. **Give each project its own agent**, in the Studio's settings, gives each one its agent server, by where its service lives:

- **A service in an Opsifier project of its own**, such as a site with its database: the agent server goes next to it, in that project, whose network is the project's own already. Nothing of the service moves, is copied or stops; the agent reaches that project's services, and only them.
- **A preview among other projects' previews**, in the agent server's own project: when it is a Vite project, the Studio makes the project an Opsifier project of its own, with a preview on the same folder and the agent server, and the project's link, conversations and accounts move there. Nothing is deployed until the project is opened. The old preview is stopped and stays where it was, out of the Studio, for an administrator to remove: still running, it would show the project's folder without the Studio's sign-in.
- **Anything else in the agent server's project** is not moved, since the Studio does not know how to make it again: move it to an Opsifier project of its own first.

The conversations held by the shared agent server are paused, and can still be read, not continued: a new conversation goes on with the project's own agent. A project whose folder is not under the projects folder, is not a copy of a GitHub repository, or holds a credential in its git settings (a user or token in a remote's address, an extra header), cannot have its own agent, and the Studio says why.

## How it works

- **The panel reaches the agent server from inside its container.** For each request it runs a short Python script in the agent server's container, which calls the server on 127.0.0.1 and returns its answer. The agent server needs no domain, and it shares no network with the panel.
- **The panel never holds the agent server's key.** The script reads it inside the container, from `SESSION_API_KEY`, `OH_SESSION_API_KEYS_0` or the key file. A conversation needs the key to look up the agent server's own secrets, such as a GitHub token: the panel sends a stand-in, and the script puts the key in its place.
- **A conversation starts the way the agent server's own interface starts one:** with its active agent profile and its instructions, the project's folder as the workspace, and its secrets looked up by name. The Studio adds what the agent needs to know about the project: its folder, the preview's addresses, from the agent's container and for the user, never to start a development server of its own, to pull before a change and push once it works, with the `GITHUB_TOKEN` secret or, with one agent per project, through the panel, and to check each change on screen, at a phone's and at a desktop's width, before it answers.
- **The agent server keeps what was said.** The panel keeps which conversations belong to which project, and who started each. Taking a project out of the Studio, or deleting its service, forgets them in the panel; the agent server keeps them.
- **Opening a project starts its preview** when it is stopped, as opening a project in a hosted builder would.
- **Each conversation says which model it works with**, and whether what it is sent stays on private addresses, such as a model served on your own machines, or goes to an outside provider. When the agent server has several model profiles, a new conversation can start with any of them.
- **Answers are kept small in the container.** The script keeps what the Studio shows of each answer before it travels: a page of events where the agent read whole files can weigh megabytes, and comes back as a few dozen kilobytes.
- **Images pasted into a message** are scaled down in the browser before they are sent, so that a screenshot fits the panel's request size limit.

## Pointing at an element of the preview

The preview's toolbar shows the page at a desktop's, a tablet's or a phone's width, and gives the address of the page shown. When the preview's page loads the Studio's inspector, **Point at an element** outlines what the pointer is on, and a click joins that element to the next message: its tag, its text, its classes, a CSS selector, and the React components around it, which a development build of React keeps. The agent is told what the block means.

The inspector is a small script the panel serves at `/studio-inspector.js`. A preview loads it however suits it; with Vite, a plugin can import it from Vite's client, which every page of a development server loads:

```js
// In a Vite config: the inspector, fetched once from the panel when the server starts.
const source = await (await fetch("https://panel.example.com/studio-inspector.js")).text();
// Vite's import analysis resolves the import by its name through this plugin; the browser then asks
// for /@id/__x00__opsifier-studio-inspector, which comes back as `id`.
const name = "virtual:opsifier-studio-inspector";
const id = "\0opsifier-studio-inspector";
export const studioInspector = () => ({
  name: "opsifier-studio-inspector",
  apply: "serve",
  resolveId: (module) => (module === name || module === id ? id : undefined),
  load: (module) => (module === id ? source : undefined),
  transform: (code, module) =>
    /vite\/dist\/client\/client\.mjs/.test(module) ? `${code}\nimport("${name}");` : undefined,
});
```

The page and the Studio talk with `postMessage`. The Studio sends `{ source: "opsifier-studio", type: "ping" }` and `{ type: "inspect", on }`; the page answers `{ source: "opsifier-studio-preview", type: "ready", path }`, then `location`, `selected` with the element, and `inspect-ended`. The page listens to its parent frame only, and the Studio to its preview's address only.

## The conversation

- **What the agent does shows as it works:** what it writes before each step, one line per step, and its plan. Once it has answered, those steps fold into one line, such as « 5 steps · 2 files changed », which opens on a click.
- **A message shows as soon as it is sent**, before the agent server has it.
- **Nothing in the conversation is wider than it:** long words and addresses wrap, and a code block scrolls within itself.
- **On a phone**, the Studio shows the conversation or the preview, one at a time at full height. Pointing at an element in the preview brings the conversation back, with the element joined to the next message.

## Suggestions

The agent ends each answer with two or three requests you might send next, which the Studio shows as tags to send in one click. A new conversation offers a few to start with.

## Limits

- On a server whose role asks for a password before every site, and with the previews' sign-in off, a browser asks for that password again for each preview's address, and it cannot ask inside the Studio's frame. Open the preview once in its own tab with **Open the preview in a new tab**, sign in, and reload the Studio, or put the previews behind the panel's sign-in.
- The agent's hidden reasoning, the output of its commands and its screenshots stay in the agent server: the Studio shows what it writes, its steps and its plan.
- With one agent per project, each agent server that runs takes about 700 MB of memory at rest, and its first deployment builds the model's image again, from the build cache when the server has one.

## API

`GET` and `PUT /api/v1/settings/studio` and `POST /api/v1/settings/studio/check` for the settings, `GET /api/v1/studio` for the linked projects, `POST /api/v1/studio/projects` to add a GitHub project, `POST /api/v1/studio/isolate` to give every project still on the shared agent server its own, `GET /api/v1/studio/preview-signin` for the hop of a preview's sign-in, `/api/v1/studio/git/{project}.git` for the git of each project's own agent server, and under `/api/v1/projects/{project}/services/{service}/studio`: the link (`GET`, `PUT`, `DELETE`), `GET` and `PUT .../members` for who it is shared with, `POST .../isolate` to give it an agent server of its own, `POST .../preview/start`, `POST .../conversations` to start one, and `GET .../conversations/{conversation}/events`, `POST .../messages` and `POST .../stop` for a conversation. See [API.md](API.md).
