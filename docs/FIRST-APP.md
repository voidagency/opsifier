# Deploy your first app

This guide takes an empty Opsifier panel to a running app with its own HTTPS address, then shows how to deploy from a Git repository, connect a database and go back to an earlier version. It assumes the panel is installed: see [Install on a server](INSTALL.md).

> **Early development.** Opsifier is not ready for production yet. Try it on a server whose data you can afford to lose.

## 1. Create a project

A project groups services that work together. They share a private network and a set of variables, and no other project can reach them over the network.

On the **Overview**, choose **New project**, give it a name made of lowercase letters, digits and dashes, such as `demo`, and create it.

## 2. Add an app

In the project, choose **Add service**, then **App**, which runs any container image. Give it a name, such as `web`, and add it.

Every new app gets a default address straight away: `<project>-<service>.<address>`, for example `demo-web.<server-ip>.sslip.io`, or a name under your `opsifier.dev` address if the server has one. It comes with HTTPS, and sends visitors to port 80 inside the container.

## 3. Choose what it runs

The app starts empty, so the panel asks what it should run. Pick **Docker image** and enter an image from any registry. For a first try, `nginx:alpine` answers on port 80:

```text
nginx:alpine
```

Save and continue. Saving never touches what is running: settings reach the app at its next deployment.

The other kinds of source are **GitHub**, **Git**, **Dockerfile** and **Upload**. See [Deploy from a repository](#deploy-from-a-repository) below.

## 4. Deploy

Press **Deploy** on the service's page. A deployment pulls the image, starts the new task, and only succeeds once it has stayed running through a short stability window. If it fails, what was running before is put back, and the deployment says why.

Its output streams into the live log drawer at the bottom of the screen, and stays on the **Deployments** tab afterwards. The service's own output is under **Live logs** on its **Overview** tab, with a search mode for older lines.

## 5. Open it

Press **Open this site**. The certificate can take a moment after the first deployment.

Until the server is in production, every site on it asks for the server's password and stays out of search engines. That password is shown once when you choose the server's purpose, and managed under **Settings, Purpose**. Move the server to production when its sites should be public.

## 6. Use your own domain

Point a DNS `A` record for your domain at the server's IP address. Then, on the app's **Domains** tab, choose **Add domain** and enter the hostname, such as `shop.example.com`, and the port the app listens on inside its container. Keep **HTTPS** on to redirect HTTP and get a certificate for it.

A domain can also route a path only, such as `/api`. Redirects, basic authentication and maintenance mode have tabs of their own: **Redirects**, **Security** and **Maintenance**.

## 7. Change it, and go back

Change a setting, such as the image tag or a variable on the **Environment** tab, then deploy again. The **Deployments** tab lists what is waiting for the next deployment before you press the button.

Each successful deployment is kept as a version, with its exact image and settings: five per service by default. On the **Deployments** tab, **Versions** lists them, and **Go back** puts one back in service. Going back never pulls, builds or fetches anything, and volumes stay as they are: data written since is kept, and database migrations are not undone.

## Deploy from a repository

Choose **Git** on the **Source** tab and enter the repository's address (`https://`, `ssh://` or `user@host:path`), a branch, a tag or a commit, and the folder to build from. **GitHub** does the same with a repository written as `owner/repository`, and private repositories need a token, added under **Settings, GitHub**. A private repository over SSH uses a deploy key, and its host has to be in **Settings, Known hosts**.

The code is built on the server, and nothing is pushed anywhere. With no build settings, a `Dockerfile` in the build folder is used if there is one, and Nixpacks otherwise. The **Build** section can choose a Dockerfile, Nixpacks, Railpack or Cloud Native Buildpacks, at a fixed version. [Builders](BUILDERS.md) lists what each one supports.

Runtime variables, build variables and build secrets are kept apart on the **Environment** tab, so a secret meant for the running app never ends up in an image.

To deploy on every push, open the **Deployments** tab:

- **Push webhook** gives an address and a secret for your Git host. Only signed pushes to the repository and branch it was issued for start a deployment.
- **Deployment trigger** gives a token for a CI job, shown once:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" https://<your-panel>/api/v1/deploy
```

## Connect a database

In the same project, choose **Add service**, then **Postgres**, **MySQL**, **MariaDB**, **Mongo** or **Redis**. Leave the password empty and a strong one is generated. The database starts deploying as soon as it is added.

Its **Credentials** tab shows how to reach it from the project: the internal host, the port and a connection URL. Revealing a password is written to the activity log. Put the connection details in the app's **Environment** tab, then deploy the app again. A database is not reachable from other projects, or from the internet, unless you publish a port on its **Expose** tab.

To keep copies of it, see [Back up databases to S3-compatible storage](BACKUPS.md).

## From a terminal

Everything above goes through the panel's API, so it can be scripted. With an API key from **Settings, API keys**:

```bash
export OPSIFIER_URL=https://<your-panel>
export OPSIFIER_API_KEY=opsifier_...
opsifier deploy demo/web
opsifier logs demo/web --since 1h
```

See [the command line](CLI.md), and [the MCP server](MCP.md) for an AI agent.
