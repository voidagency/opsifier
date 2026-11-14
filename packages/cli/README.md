# opsifier

The command line for an [Opsifier](https://opsifier.com) panel: an open-source control panel that deploys apps and databases on your own server.

It talks to the panel's API only, with the rights of your API key or of your own session, and nothing more.

```sh
npm install -g opsifier          # or: brew install voidagency/tap/opsifier

opsifier login https://panel.example.com        # with an API key
opsifier login --web https://panel.example.com  # as yourself, approved in a browser

cd my-app
opsifier create shop/web --link
opsifier push --wait
opsifier logs -f
```

Node 22.13 or later. The full guide: [docs/CLI.md](https://github.com/voidagency/opsifier/blob/main/docs/CLI.md).

Opsifier is in early development and not ready for production yet. Apache-2.0.
