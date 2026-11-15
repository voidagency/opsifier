# Studio

The Studio lets someone change a web project by talking to an AI agent, and watch the result live: the conversation on the left, the project's preview on the right. It is optional and off by default. The agent is [OpenHands](https://github.com/OpenHands/OpenHands) (MIT), used as it is published: Opsifier talks to its agent server, and brings the interface, the projects and their previews.

The Studio is new. For now it is open to the server's administrators only, because one agent server works on every project's folder. Each project will get an agent of its own, after which the Studio can be shared with other people project by project.

## What you need

- **An agent server.** A service of yours that runs the OpenHands agent server, for example the `ghcr.io/openhands/agent-canvas` image, with its model set up: an OpenAI-compatible address, such as a model served by vLLM on your own machine, or a provider's API key. Its container needs `python3`, as the agent server's images have.
- **A preview per project.** A service whose container runs the project's development server on the project's folder, for example `vite dev`, with a domain. The agent and the preview share the folder through a mount, so a change the agent makes shows at once.
- **The project's folder in the agent server's container.** For example `/projects/my-project`, mounted from the same folder on the server as the preview's.

## Turn it on

1. Open **Settings**, **Studio**.
2. Turn the Studio on.
3. Choose the service that runs the agent server. Keep its address, `http://127.0.0.1:18000` for `agent-canvas`, unless the server listens elsewhere in its container.
4. Keep the key file, `/home/openhands/.openhands/agent-canvas/api-key.txt` for `agent-canvas`, or leave it empty when the key is in the container's `SESSION_API_KEY` variable.
5. Save, then **Check the connection**.

Then open **Studio** in the top bar, and **Link a project**: its preview service, and its folder as the agent server sees it.

## How it works

- **The panel reaches the agent server from inside its container.** For each request it runs a short Python script in the agent server's container, which calls the server on 127.0.0.1 and returns its answer. The agent server needs no domain, and it shares no network with the panel.
- **The panel never holds the agent server's key.** The script reads it inside the container, from `SESSION_API_KEY`, `OH_SESSION_API_KEYS_0` or the key file. A conversation needs the key to look up the agent server's own secrets, such as a GitHub token: the panel sends a stand-in, and the script puts the key in its place.
- **A conversation starts the way the agent server's own interface starts one:** with its active agent profile and its instructions, the project's folder as the workspace, and its secrets looked up by name. The Studio adds a few lines telling the agent that the user sees the preview next to the conversation.
- **The agent server keeps what was said.** The panel keeps which conversations belong to which project, and who started each. Taking a project out of the Studio, or deleting its service, forgets them in the panel; the agent server keeps them.
- **Opening a project starts its preview** when it is stopped, as opening a project in a hosted builder would.
- **Images pasted into a message** are scaled down in the browser before they are sent, so that a screenshot fits the panel's request size limit.

## Limits

- On a server whose role asks for a password before every site, a browser asks for it again for each preview's address, and it cannot ask inside the Studio's frame. Open the preview once in its own tab with **Open the preview in a new tab**, sign in, and reload the Studio.
- The Studio shows what the agent says and one line per action. Its reasoning, the output of its commands and its browser's screenshots stay in the agent server.

## API

`GET` and `PUT /api/v1/settings/studio` and `POST /api/v1/settings/studio/check` for the settings, `GET /api/v1/studio` for the linked projects, and under `/api/v1/projects/{project}/services/{service}/studio`: the link (`GET`, `PUT`, `DELETE`), `POST .../conversations` to start one, and `GET .../conversations/{conversation}/events`, `POST .../messages` and `POST .../stop` for a conversation. See [API.md](API.md).
