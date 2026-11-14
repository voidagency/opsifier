# Install Opsifier on a server

Opsifier installs on one Linux server with a single command. The installer checks the server, adds Docker when it is missing, sets up Docker Swarm, Traefik and the panel, then prints a one-time link to create the first account.

> **Early development.** Releases are published, but Opsifier is not ready for production yet. Expect breaking changes, and don't put anything on it yet that you can't afford to lose.

## What the server needs

- Linux on x86_64 or arm64. The installer is written for Ubuntu and Debian: it can only add Docker on those two.
- At least 2 GB of memory.
- Ports 80, 443 and 3000 free. Traefik takes 80 and 443, the panel takes 3000.
- Root access, for example through `sudo`.
- Docker 26 or later, or no Docker at all. The installer adds Docker from Docker's own repository when it is missing. It never upgrades a Docker that is already there: an older one stops it before anything has changed, with the reason.

Whoever controls an Opsifier panel has root-equivalent access to its server through the Docker socket, so treat its accounts and API keys accordingly.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/voidagency/opsifier/main/scripts/install.sh | sudo bash
```

The installer:

1. Checks the system, the processor, the memory and the ports, and stops before its first change if something is missing.
2. Adds Docker when it is not there, and starts it.
3. Downloads the panel's image, `ghcr.io/voidagency/opsifier`, and runs its `setup` command with the Docker socket and `/var/lib/opsifier` mounted.
4. Initializes Swarm, creates the `opsifier` overlay network, and starts two Swarm services: `opsifier`, the panel, published on port 3000, and `opsifier-traefik`, the proxy, published on ports 80 and 443.

It ends like this:

```text
Opsifier is running.
Open one of these addresses to create the administrator account. The code in it works once:
  http://<server-ip>:3000/setup?token=...
  https://panel.<server-ip>.sslip.io/setup?token=...
```

Open one of them, choose the email and password of the first account, and you are in. That account is the owner of the panel. If the link is lost, the setup code is also in the panel's log, on the line with `/setup?token=`, and in the file `/var/lib/opsifier/setup-token`.

Running the installer again changes nothing that is already right, and never updates Docker or the panel.

## Options

Options go after `bash -s --` when the script comes through a pipe:

```bash
curl -fsSL https://raw.githubusercontent.com/voidagency/opsifier/main/scripts/install.sh | sudo bash -s -- --version 0.3.2
```

| Option                  | What it does                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--version <tag>`       | Installs this release instead of the latest one, for example `0.3.2`.                                              |
| `--image <ref>`         | Installs this image reference instead of the official one.                                                         |
| `--advertise-addr <ip>` | The address Swarm advertises. Otherwise it is worked out from the default route.                                   |
| `--server-ip <ip>`      | The address people reach the server on, when it differs from its own, as behind NAT.                               |
| `--force`               | Replaces what is in the way, such as a service named `opsifier` that the installer did not create. Off by default. |
| `--clean-up`            | Installs nothing. Shows what an install that stopped partway made, and what stays because it was not its own.      |
| `--yes`                 | With `--clean-up`, removes what it lists. Docker itself and the panel's image stay.                                |
| `--restore`             | Puts a server backup back first, then installs: see [Restore a whole server](BACKUPS.md#restore-a-whole-server).   |
| `--snapshot <id>`       | With `--restore`, which backup. The latest one otherwise.                                                          |

## If the install stops partway

Run the same command again: it carries on from where it stopped. To undo it instead, look first, then remove:

```bash
curl -fsSL https://raw.githubusercontent.com/voidagency/opsifier/main/scripts/install.sh | sudo bash -s -- --clean-up
curl -fsSL https://raw.githubusercontent.com/voidagency/opsifier/main/scripts/install.sh | sudo bash -s -- --clean-up --yes
```

Only what that install made goes, and only for an install that never finished on a panel nobody has claimed. A Swarm it started is left alone when anything else runs on it.

## After the install

- **Say what the server is for.** The panel asks on first use: development, staging or production. Until the server is in production, every site on it asks for the server's password and stays out of search engines. The password is shown once when you choose, and managed under **Settings, Purpose**.
- **Give it an address.** New services get generated names under `sslip.io` until you choose otherwise. You can ask for a free `<id>.opsifier.dev` address under **Settings, Address**: a person approves each request, and the server then gets its own name and one wildcard certificate. You can always use your own domains instead, on each service's **Domains** tab.
- **Turn on two-factor sign-in** under **Settings, Authentication**, and invite the people who need access from **Settings, Users**.
- **Deploy something.** [Deploy your first app](FIRST-APP.md) goes from an empty panel to a running app with HTTPS.

## Updates

The top bar shows the running version and offers new releases. An update saves the panel's database and key first. If the new version does not start, Swarm brings the old one back and the saved data is restored. Your services keep running while the panel restarts.

## Where things are on the server

| Path                           | What it holds                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `/var/lib/opsifier`            | The panel's data: its SQLite database, `secret.key`, the proxy's files, and each project's files |
| `/var/lib/opsifier/secret.key` | The key that seals secrets at rest. Keep it with any copy of the data directory                  |

Backups made from the panel cover databases and volumes, not the panel's own data directory. Back that up with the panel stopped, and keep `secret.key` with it.
